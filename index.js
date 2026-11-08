/**
 * Host half of the Memory Nebula bundle.
 *
 * DSH has no standalone "memory" store: every durable memory is a committed
 * Session event in the append-only session log under $DSH_HOME/sessions. Those
 * logs are concatenated zstd frames wrapping JSONL. This plugin cold-reads all
 * of them, folds each Session into a compact "memory cluster" (title, activity
 * counts, time range and a sampled set of conversation fragments), caches by
 * file mtime, and serves the aggregate to the Client over same-origin HTTP.
 *
 * Nothing here writes to the profile, the session log, or any other plugin's
 * state. It is a read-only projection of history.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const inject = ['webServer']

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const LOG_PATTERN = /^session(?:\.[\w-]+)*\.jsonl\.zstd$/
const RUNTIME_CONTEXT_PREFIX = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
const RUNTIME_FILLERS = [
  'Time sampled while preparing turn',
  'Elapsed since the preceding',
  'Browser time zone for this request',
  'Interpret otherwise-unqualified dates',
  'Current the agent harness file policy',
  'Current agent implementation checkout',
  'Current Web GUI URL',
]
const SKILL_CATALOG_OPENER = '<system-reminder>'
const SKILL_CATALOG_MARKER = '<available_skills>'
// Generic words carry no "this session was about X" signal. Keeping them out
// stops short chit-chat sessions from linking to everything via "的/我们/the".
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'you', 'are', 'not', 'have', 'can', 'will',
  'but', 'all', 'any', 'use', 'using', 'used', 'how', 'what', 'when', 'where', 'which', 'who', 'why',
  '一个', '我们', '你们', '他们', '这个', '那个', '什么', '可以', '怎么', '需要', '如果', '已经',
  '没有', '就是', '这样', '那样', '时候', '现在', '一下', '使用', '以及', '通过', '是否', '这些',
  '那些', '然后', '因为', '所以', '但是', '还是', '或者', '一下', '这里', '那里', '当前', '问题',
  '看看', '帮我', '一个', '进行', '相关', '之后', '之前', '出来', '进去', '东西', '内容', '地方',
  '用户', '助手', '工具', '文件', '代码', '插件', '会话', '记忆', '支持', '实现', '添加', '修改',
  'current', 'the agent harness', 'runtime', 'context', 'snapshot', 'session', 'user', 'assistant',
])
const TOKEN_RE = /[\u4e00-\u9fa5]{2,}|[a-z][a-z0-9_-]{2,}/g

// ---------------------------------------------------------------------------
// zstd frame decoding
// ---------------------------------------------------------------------------

/** Decode a run of concatenated zstd frames into UTF-8 JSONL text. */
function decodeSessionLog(buffer) {
  if (typeof zstdDecompressSync !== 'function') return null
  const offsets = []
  let index = buffer.indexOf(ZSTD_MAGIC, 0)
  while (index !== -1) {
    offsets.push(index)
    index = buffer.indexOf(ZSTD_MAGIC, index + 4)
  }
  if (offsets.length === 0) return null
  const parts = []
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offsets[i], end)))
    } catch {
      // A log that is still being appended can end mid-frame: keep whole frames.
      break
    }
  }
  if (parts.length === 0) return null
  return Buffer.concat(parts).toString('utf8')
}

// ---------------------------------------------------------------------------
// Event text helpers
// ---------------------------------------------------------------------------

/** Join the readable text blocks of a message content array. */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap(block => {
      if (block == null) return []
      if (block.type === 'text') return typeof block.text === 'string' ? [block.text] : []
      if (block.type === 'tool-call') return [] // tool calls are not remembered text
      if (block.type === 'tool-result') return contentText(block.content)
      return []
    })
    .filter(value => value.trim() !== '')
    .join('\n')
    .trim()
}

function isInjectedUser(event) {
  const source = event?.data?.source
  if (source != null && typeof source === 'object' && typeof source.kind === 'string') {
    if (source.kind === 'skill-catalog' || source.kind === 'runtime-context') return true
  }
  const text = contentText(event?.data?.content)
  if (text.startsWith(RUNTIME_CONTEXT_PREFIX)) return true
  // DSH prepends runtime-context bookkeeping to some user turns; those lines
  // are injected scaffolding, not a memory a person authored.
  if (RUNTIME_FILLERS.some(marker => text.startsWith(marker))) return true
  const head = text.trimStart()
  return head.startsWith(SKILL_CATALOG_OPENER) && head.includes(SKILL_CATALOG_MARKER)
}

function clip(text, max) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return { text: normalized, truncated: false }
  return { text: `${normalized.slice(0, max).trimEnd()}…`, truncated: true }
}

/** Ignore fragments that carry no real words (bare punctuation, separators). */
function hasSubstance(text) {
  return /[\u4e00-\u9fa5a-zA-Z0-9]/.test(text)
}

/** Even sampling keeps both the oldest and newest memories of a long Session. */
function sampleEvenly(items, cap) {
  if (items.length <= cap) return items
  if (cap <= 0) return []
  const out = []
  for (let i = 0; i < cap; i += 1) {
    const index = Math.round((i * (items.length - 1)) / (cap - 1))
    out.push(items[index])
  }
  return out
}

// ---------------------------------------------------------------------------
// Folding one Session log into a memory cluster
// ---------------------------------------------------------------------------

function foldEvents(sessionId, workspaceDir, events, limits) {
  let title = ''
  let createdAt = 0
  let updatedAt = 0
  let realCwd = ''
  let userMessages = 0
  let assistantMessages = 0
  let toolCalls = 0
  let turns = 0
  let eventCount = 0
  let parentSession = null
  const rawFragments = []
  const wordCounts = new Map()
  const toolNames = new Set()

  for (const event of events) {
    if (event == null || typeof event !== 'object') continue
    // The log's header row carries the real working directory, creation time
    // and the durable fork lineage (parentSession).
    if (event.type === 'session') {
      if (typeof event.cwd === 'string' && event.cwd !== '') realCwd = event.cwd
      if (typeof event.createdAt === 'number' && event.createdAt > 0 && createdAt === 0) createdAt = event.createdAt
      if (typeof event.parentSession === 'string' && event.parentSession !== '') parentSession = event.parentSession
      continue
    }
    eventCount += 1
    const time = typeof event.time === 'number' ? event.time : 0
    if (time > 0) {
      if (createdAt === 0 || time < createdAt) createdAt = time
      if (time > updatedAt) updatedAt = time
    }
    const data = event.data || {}
    switch (event.type) {
      case 'session/title':
        if (typeof data.title === 'string' && data.title.trim() !== '') title = data.title.trim()
        break
      case 'user/message': {
        if (isInjectedUser(event)) break
        const text = contentText(data.content)
        if (text === '' || !hasSubstance(text)) break
        userMessages += 1
        collectWords(text, wordCounts)
        const clipped = clip(text, limits.maxFragmentChars)
        rawFragments.push({ kind: 'user', text: clipped.text, truncated: clipped.truncated, time, seq: event.seq })
        break
      }
      case 'assistant/message': {
        const text = contentText(data.message?.content)
        if (text === '' || !hasSubstance(text)) break
        assistantMessages += 1
        collectWords(text, wordCounts)
        const clipped = clip(text, limits.maxFragmentChars)
        rawFragments.push({ kind: 'assistant', text: clipped.text, truncated: clipped.truncated, time, seq: event.seq })
        break
      }
      case 'tool/call':
        toolCalls += 1
        if (typeof data.name === 'string') toolNames.add(data.name)
        break
      case 'turn/end':
        turns += 1
        break
      default:
        break
    }
  }

  // A Session with no user turns yet (only runtime bootstrap) is not a memory.
  if (userMessages === 0 && assistantMessages === 0) return null

  const fragments = sampleEvenly(rawFragments, limits.maxFragments)
  if (title === '') {
    const firstUser = rawFragments.find(fragment => fragment.kind === 'user')
    title = firstUser ? clip(firstUser.text, 42).text || '未命名记忆' : '未命名记忆'
  }

  return {
    id: sessionId,
    title: clip(title, 90).text,
    workspace: workspaceDir,
    workspaceLabel: realCwd !== '' ? realCwd : workspaceLabel(workspaceDir),
    createdAt,
    updatedAt,
    counts: {
      events: eventCount,
      user: userMessages,
      assistant: assistantMessages,
      tools: toolCalls,
      turns,
      fragments: rawFragments.length,
    },
    // Compact relation signals. `topics` is capped so the payload stays small.
    topics: topTopics(wordCounts, 18),
    tools: [...toolNames].slice(0, 40),
    parentSession,
    fragments,
  }
}

/** Count meaningful tokens of one message into the Session's word bag. */
function collectWords(text, into) {
  const lowered = text.toLowerCase()
  const tokens = lowered.match(TOKEN_RE) || []
  for (const token of tokens) {
    if (STOP_WORDS.has(token) || token.length > 20) continue
    into.set(token, (into.get(token) || 0) + 1)
  }
}

/** Highest-count, non-generic tokens = what this Session was actually about. */
function topTopics(wordCounts, cap) {
  return [...wordCounts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([word, count]) => ({ word, count }))
}

// ---------------------------------------------------------------------------
// Relations between Sessions
//
// DSH Sessions are not an unrelated pile: they share a workspace, a fork
// lineage, the tools they used, and above all the words people typed. We fold
// those signals into a small weighted graph so the nebula can draw the links.
// ---------------------------------------------------------------------------

function computeRelations(sessions) {
  const byId = new Map(sessions.map(s => [s.id, s]))
  // Document frequency gives rare, specific words more weight than ubiquitous
  // ones ("插件" appears everywhere, "bark" only in one thread).
  const df = new Map()
  for (const s of sessions) {
    for (const { word } of s.topics || []) df.set(word, (df.get(word) || 0) + 1)
  }
  const idf = word => Math.log(1 + sessions.length / (1 + (df.get(word) || 0)))
  const vectors = new Map()
  for (const s of sessions) {
    const vec = new Map()
    for (const { word, count } of s.topics || []) vec.set(word, (1 + Math.log(count)) * idf(word))
    vectors.set(s.id, vec)
  }
  const norm = v => Math.sqrt([...v.values()].reduce((acc, x) => acc + x * x, 0))

  const candidates = []
  for (let i = 0; i < sessions.length; i += 1) {
    for (let j = i + 1; j < sessions.length; j += 1) {
      const A = sessions[i], B = sessions[j]
      const va = vectors.get(A.id), vb = vectors.get(B.id)
      let dot = 0
      for (const [word, wa] of va) {
        const wb = vb.get(word)
        if (wb !== undefined) dot += wa * wb
      }
      const na = norm(va), nb = norm(vb)
      const cosine = na > 0 && nb > 0 ? dot / (na * nb) : 0

      const ta = new Set(A.tools || []), tb = new Set(B.tools || [])
      let sharedTools = 0
      for (const t of ta) if (tb.has(t)) sharedTools += 1
      const toolScore = sharedTools / Math.max(1, Math.min(ta.size, tb.size) || 1)

      const sameWorkspace = A.workspace === B.workspace
      const forked = A.parentSession === B.id || B.parentSession === A.id
      // Sessions worked on in the same period are more likely a continuing thread.
      const gap = Math.abs((A.createdAt || 0) - (B.createdAt || 0))
      const temporal = gap > 0 && gap < 1000 * 60 * 60 * 24 * 7 ? 0.12 : 0

      let weight = cosine * 0.72 + toolScore * 0.18 + (sameWorkspace ? 0.12 : 0) + temporal
      if (forked) weight += 0.6
      if (weight < 0.16) continue

      const kinds = []
      if (forked) kinds.push('fork')
      if (sameWorkspace) kinds.push('workspace')
      if (cosine >= 0.2) kinds.push('topic')
      if (sharedTools >= 2) kinds.push('tools')
      if (temporal > 0) kinds.push('time')
      if (kinds.length === 0) kinds.push('weak')
      candidates.push({
        source: A.id, target: B.id,
        weight: Math.round(Math.min(1, weight) * 100) / 100,
        kind: kinds[0],
        kinds,
        shared: sharedWords(A, B, 6),
      })
    }
  }
  candidates.sort((a, b) => b.weight - a.weight)
  // Cap per node as well as globally: a hub must not dominate the picture.
  const perNode = new Map()
  const picked = []
  for (const edge of candidates) {
    const ca = perNode.get(edge.source) || 0
    const cb = perNode.get(edge.target) || 0
    if (ca >= 4 || cb >= 4) continue
    perNode.set(edge.source, ca + 1)
    perNode.set(edge.target, cb + 1)
    picked.push(edge)
    if (picked.length >= 60) break
  }
  // A relation is only meaningful if both endpoints are still in the payload.
  return picked.filter(e => byId.has(e.source) && byId.has(e.target))
}

/** A few concrete shared words, shown in the UI as the reason for a link. */
function sharedWords(A, B, cap) {
  const wa = new Map((A.topics || []).map(t => [t.word, t.count]))
  const out = []
  for (const { word } of B.topics || []) {
    if (wa.has(word)) out.push(word)
    if (out.length >= cap) break
  }
  return out
}

/** Turn a DSH workspace directory slug into a readable label. */
function workspaceLabel(dirName) {
  let inner = String(dirName).replace(/^--+/, '').replace(/--+$/, '')
  const drive = /^([A-Za-z])-(.*)$/.exec(inner)
  if (drive !== null) inner = `${drive[1].toUpperCase()}:\\${drive[2]}`
  return inner || String(dirName)
}

// ---------------------------------------------------------------------------
// Disk reader with an mtime cache
// ---------------------------------------------------------------------------

class MemoryReader {
  constructor(directory, limits) {
    this.directory = directory
    this.limits = limits
    this.cache = new Map() // file path -> { mtimeMs, size, cluster }
  }

  async findLogFiles() {
    const files = []
    let workspaces
    try {
      workspaces = await readdir(this.directory, { withFileTypes: true })
    } catch {
      return files
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue
      const workspacePath = join(this.directory, workspace.name)
      let sessions
      try {
        sessions = await readdir(workspacePath, { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        const sessionPath = join(workspacePath, session.name)
        let entries
        try {
          entries = await readdir(sessionPath)
        } catch {
          continue
        }
        const log = entries.find(name => LOG_PATTERN.test(name))
        if (log === undefined) continue
        files.push({ path: join(sessionPath, log), sessionId: session.name, workspaceDir: workspace.name })
      }
    }
    return files
  }

  async readCluster(file) {
    const info = await stat(file.path).catch(() => null)
    if (info === null) return null
    const cached = this.cache.get(file.path)
    if (cached != null && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return cached.cluster
    }
    const text = decodeSessionLog(await readFile(file.path).catch(() => Buffer.alloc(0)))
    if (text === null) return null
    const events = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // A trailing partial line while the Session is still being written.
      }
    }
    const cluster = foldEvents(file.sessionId, file.workspaceDir, events, this.limits)
    // Bound the cache so a profile with hundreds of Sessions cannot grow it forever.
    if (this.cache.size >= this.limits.maxSessions * 2) {
      this.cache.delete(this.cache.keys().next().value)
    }
    this.cache.set(file.path, { mtimeMs: info.mtimeMs, size: info.size, cluster })
    return cluster
  }

  async snapshot() {
    const files = await this.findLogFiles()
    // Newest activity first, then cap so the nebula stays responsive.
    const clusters = []
    for (const file of files) {
      const cluster = await this.readCluster(file)
      if (cluster != null) clusters.push(cluster)
    }
    clusters.sort((a, b) => b.updatedAt - a.updatedAt)
    const capped = clusters.slice(0, this.limits.maxSessions)

    let totalEvents = 0
    let totalUser = 0
    let totalAssistant = 0
    let totalTools = 0
    let totalTurns = 0
    let totalFragments = 0
    let oldest = Infinity
    let newest = 0
    const workspaces = new Map()
    for (const cluster of capped) {
      totalEvents += cluster.counts.events
      totalUser += cluster.counts.user
      totalAssistant += cluster.counts.assistant
      totalTools += cluster.counts.tools
      totalTurns += cluster.counts.turns
      totalFragments += cluster.fragments.length
      if (cluster.createdAt > 0 && cluster.createdAt < oldest) oldest = cluster.createdAt
      if (cluster.updatedAt > newest) newest = cluster.updatedAt
      if (!workspaces.has(cluster.workspace)) {
        workspaces.set(cluster.workspace, { id: cluster.workspace, label: cluster.workspaceLabel, sessions: 0 })
      }
      workspaces.get(cluster.workspace).sessions += 1
    }

    const relations = computeRelations(capped)

    return {
      generatedAt: Date.now(),
      sessions: capped,
      workspaces: [...workspaces.values()].sort((a, b) => b.sessions - a.sessions),
      relations,
      stats: {
        sessions: capped.length,
        events: totalEvents,
        user: totalUser,
        assistant: totalAssistant,
        tools: totalTools,
        turns: totalTurns,
        fragments: totalFragments,
        relations: relations.length,
        oldest: Number.isFinite(oldest) ? oldest : 0,
        newest,
      },
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendFile(res, contentType, body) {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(body)
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const limits = {
    maxSessions: Number.isFinite(config?.maxSessions) ? Math.max(1, Math.floor(config.maxSessions)) : 400,
    maxFragments: Number.isFinite(config?.maxFragments) ? Math.max(1, Math.floor(config.maxFragments)) : 28,
    maxFragmentChars: Number.isFinite(config?.maxFragmentChars) ? Math.max(40, Math.floor(config.maxFragmentChars)) : 220,
  }
  const sessionsDir = typeof config?.sessionsDir === 'string' && config.sessionsDir !== ''
    ? config.sessionsDir
    : (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : '')
  const reader = new MemoryReader(sessionsDir, limits)

  // The DSH /api browser-trust fence does not cover these routes, so the
  // handler checks the Host header itself (DNS-rebinding defense), mirroring
  // the shipped Synapse plugin. The Web GUI is always localhost/127.0.0.1.
  const trustedHosts = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '[::1]',
    ...[...(config?.trustedHosts ?? [])].map(host => String(host).trim().toLowerCase()).filter(Boolean),
  ])
  const hostAllowed = req => {
    const raw = typeof req.headers.host === 'string' ? req.headers.host : ''
    const hostname = raw.replace(/:\d+$/, '').toLowerCase()
    return trustedHosts.has(hostname)
  }

  const handler = async (req, res) => {
    try {
      if (!hostAllowed(req)) return sendJson(res, 403, { error: 'Untrusted Host' })
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' })
      const path = new URL(req.url ?? '/', 'http://dsh.local').pathname

      if (path === '/memory-cloud/api/memories') {
        const data = await reader.snapshot()
        return sendJson(res, 200, data)
      }
      if (path === '/memory-cloud/' || path === '/memory-cloud/index.html') {
        return sendFile(res, 'text/html; charset=utf-8', await readAsset('nebula.html'))
      }
      if (path === '/memory-cloud/nebula.css') {
        return sendFile(res, 'text/css; charset=utf-8', await readAsset('nebula.css'))
      }
      if (path === '/memory-cloud/nebula.js') {
        return sendFile(res, 'text/javascript; charset=utf-8', await readAsset('nebula.js'))
      }
      return sendJson(res, 404, { error: 'Not found' })
    } catch (error) {
      ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
      return sendJson(res, 500, { error: 'Memory nebula data is temporarily unavailable' })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/memory-cloud', handler: (_req, res) => {
      res.writeHead(302, { location: '/memory-cloud/' })
      res.end()
    } }),
    'memory-cloud: redirect',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/memory-cloud', handler }),
    'memory-cloud: page, assets and api',
  )
}

async function readAsset(name) {
  return readFile(new URL(`./${name}`, import.meta.url), 'utf8')
}
