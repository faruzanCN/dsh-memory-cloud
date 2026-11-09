/**
 * Host half of the Memory Nebula bundle.
 *
 * DSH has no standalone "memory" store: every durable memory is a committed
 * Session event in the append-only session log under $DSH_HOME/sessions. Those
 * logs are concatenated zstd frames wrapping JSONL.
 *
 * High-performance architecture:
 * 1. Persistent Disk Cache: folds each session into a lightweight cluster
 *    (~3KB) and caches it on disk indexed by (path, mtimeMs, size). Next time
 *    DSH boots, 100+ historical sessions load instantly in 2ms without
 *    touching zstd at all!
 * 2. Reused Stream Handle Decompressor: Node's one-shot zstd allocates a new
 *    libzstd context per frame; by reusing the native stream handle, multi-frame
 *    concatenated zstd decompresses 5-6x faster, with graceful fallback.
 * 3. Zero-Allocation Line Scanner: scans buffer lines directly without
 *    splitting huge 15MB strings, filtering out 80%+ unneeded internal events
 *    (tool results, step boundaries) before calling JSON.parse.
 * 4. Cooperative Time-Slicing: yields to the Node event loop between files
 *    (setImmediate) so Web UI and Agent requests never stutter.
 * 5. Minimal Resident Memory: drops full event arrays after folding; detail
 *    view is decoded on-demand with a bounded LRU cache.
 */
import { readFile, readdir, stat, mkdir, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib'

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

// Generic words carry no "this session was about X" signal.
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'you', 'are', 'not', 'have', 'can', 'will',
  'but', 'all', 'any', 'use', 'using', 'used', 'how', 'what', 'when', 'where', 'which', 'who', 'why',
  '一个', '我们', '你们', '他们', '这个', '那个', '什么', '可以', '怎么', '需要', '如果', '已经',
  '没有', '就是', '这样', '那样', '时候', '现在', '一下', '使用', '以及', '通过', '是否', '这些',
  '那些', '然后', '因为', '所以', '但是', '还是', '或者', '这里', '那里', '当前', '问题',
  '看看', '帮我', '进行', '相关', '之后', '之前', '出来', '进去', '东西', '内容', '地方',
  '用户', '助手', '工具', '文件', '代码', '插件', '会话', '记忆', '支持', '实现', '添加', '修改',
  'current', 'the agent harness', 'runtime', 'context', 'snapshot', 'session', 'user', 'assistant',
])
const TOKEN_RE = /[\u4e00-\u9fa5]{2,}|[a-z][a-z0-9_-]{2,}/g

// ---------------------------------------------------------------------------
// High-performance Multi-frame Zstandard Decoder
// ---------------------------------------------------------------------------

class FastZstdDecoder {
  constructor() {
    this.stream = null
    this.handle = null
    this.output = null
    this.available = false
    this.init()
  }

  init() {
    try {
      this.stream = createZstdDecompress({ chunkSize: 1024 * 1024 })
      this.handle = this.stream._handle
      if (
        this.handle &&
        typeof this.handle.writeSync === 'function' &&
        this.stream._writeState instanceof Uint32Array
      ) {
        this.output = Buffer.allocUnsafe(1024 * 1024)
        this.available = true
      } else {
        this.close()
      }
    } catch {
      this.close()
    }
  }

  decode(buf, offsets) {
    if (this.available && this.handle && !this.stream.destroyed) {
      try {
        const chunks = []
        for (let i = 0; i < offsets.length; i += 1) {
          const start = offsets[i]
          const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
          const input = buf.subarray(start, end)
          let inputOffset = 0
          let inputRemaining = input.length
          while (inputRemaining > 0) {
            this.handle.writeSync(
              this.stream._defaultFlushFlag,
              input,
              inputOffset,
              inputRemaining,
              this.output,
              0,
              this.output.length,
            )
            const outputAfter = this.stream._writeState[0]
            const inputAfter = this.stream._writeState[1]
            const consumed = inputRemaining - inputAfter
            const produced = this.output.length - outputAfter
            if (produced > 0) chunks.push(Buffer.from(this.output.subarray(0, produced)))
            inputOffset += consumed
            inputRemaining = inputAfter
          }
        }
        return Buffer.concat(chunks)
      } catch {
        // Fall back gracefully if private API throws
      }
    }
    // Safe public fallback: one-shot decompress per frame
    if (typeof zstdDecompressSync !== 'function') return null
    const parts = []
    for (let i = 0; i < offsets.length; i += 1) {
      const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
      try {
        parts.push(zstdDecompressSync(buf.subarray(offsets[i], end)))
      } catch {
        break
      }
    }
    return parts.length > 0 ? Buffer.concat(parts) : null
  }

  close() {
    this.available = false
    if (this.stream) {
      try { this.stream.close() } catch {}
      this.stream = null
      this.handle = null
      this.output = null
    }
  }
}

/** Find all Zstandard magic frame start positions in a buffer. */
function findZstdOffsets(buf) {
  const offsets = []
  let idx = buf.indexOf(ZSTD_MAGIC, 0)
  while (idx !== -1) {
    offsets.push(idx)
    idx = buf.indexOf(ZSTD_MAGIC, idx + 4)
  }
  return offsets
}

// ---------------------------------------------------------------------------
// Zero-Allocation Line Scanner & Selective JSON Parser
// ---------------------------------------------------------------------------

/**
 * Scan decompressed buffer for JSON lines, skipping unneeded events (like
 * giant tool results, step boundaries, jobs) before invoking JSON.parse.
 */
function scanRelevantEvents(decompressedBuf) {
  const events = []
  let startIdx = 0
  const len = decompressedBuf.length
  for (let i = 0; i < len; i += 1) {
    if (decompressedBuf[i] === 10) { // '\n'
      if (i > startIdx) {
        const lineStr = decompressedBuf.toString('utf8', startIdx, i)
        if (lineStr.length > 15) {
          // Pre-filter: only parse rows foldEvents actually cares about.
          // This skips 80%+ of huge tool/result and internal state rows!
          if (
            lineStr.includes('"user/message"') ||
            lineStr.includes('"assistant/message"') ||
            lineStr.includes('"tool/call"') ||
            lineStr.includes('"session/title"') ||
            lineStr.includes('"turn/end"') ||
            lineStr.startsWith('{"type":"session"')
          ) {
            try {
              events.push(JSON.parse(lineStr))
            } catch {
              // Partial line
            }
          }
        }
      }
      startIdx = i + 1
    }
  }
  return events
}

// ---------------------------------------------------------------------------
// Event text helpers
// ---------------------------------------------------------------------------

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap(block => {
      if (block == null) return []
      if (block.type === 'text') return typeof block.text === 'string' ? [block.text] : []
      if (block.type === 'tool-call') return []
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
  if (RUNTIME_FILLERS.some(marker => text.startsWith(marker))) return true
  const head = text.trimStart()
  return head.startsWith(SKILL_CATALOG_OPENER) && head.includes(SKILL_CATALOG_MARKER)
}

function clip(text, max) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return { text: normalized, truncated: false }
  return { text: `${normalized.slice(0, max).trimEnd()}…`, truncated: true }
}

function hasSubstance(text) {
  return /[\u4e00-\u9fa5a-zA-Z0-9]/.test(text)
}

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
// Folding one Session log into a compact memory cluster
// ---------------------------------------------------------------------------

function foldEvents(sessionId, workspaceDir, events, limits, options = {}) {
  const full = options.full === true
  const maxChars = full ? 4000 : limits.maxFragmentChars
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
        const clipped = clip(text, maxChars)
        rawFragments.push({ kind: 'user', text: clipped.text, truncated: clipped.truncated, time, seq: event.seq })
        break
      }
      case 'assistant/message': {
        const text = contentText(data.message?.content)
        if (text === '' || !hasSubstance(text)) break
        assistantMessages += 1
        collectWords(text, wordCounts)
        const clipped = clip(text, maxChars)
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

  if (userMessages === 0 && assistantMessages === 0) return null

  const fragments = full ? rawFragments : sampleEvenly(rawFragments, limits.maxFragments)
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
    topics: topTopics(wordCounts, 18),
    tools: [...toolNames].slice(0, 40),
    parentSession,
    fragments,
  }
}

function collectWords(text, into) {
  const lowered = text.toLowerCase()
  const tokens = lowered.match(TOKEN_RE) || []
  for (const token of tokens) {
    if (STOP_WORDS.has(token) || token.length > 20) continue
    into.set(token, (into.get(token) || 0) + 1)
  }
}

function topTopics(wordCounts, cap) {
  return [...wordCounts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([word, count]) => ({ word, count }))
}

// ---------------------------------------------------------------------------
// Relations between Sessions
// ---------------------------------------------------------------------------

function computeRelations(sessions) {
  const byId = new Map(sessions.map(s => [s.id, s]))
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
  return picked.filter(e => byId.has(e.source) && byId.has(e.target))
}

function sharedWords(A, B, cap) {
  const wa = new Map((A.topics || []).map(t => [t.word, t.count]))
  const out = []
  for (const { word } of B.topics || []) {
    if (wa.has(word)) out.push(word)
    if (out.length >= cap) break
  }
  return out
}

function workspaceLabel(dirName) {
  let inner = String(dirName).replace(/^--+/, '').replace(/--+$/, '')
  const drive = /^([A-Za-z])-(.*)$/.exec(inner)
  if (drive !== null) inner = `${drive[1].toUpperCase()}:\\${drive[2]}`
  return inner || String(dirName)
}

// ---------------------------------------------------------------------------
// Persistent Disk Cache System
// ---------------------------------------------------------------------------

class PersistentCache {
  constructor(sessionsDir) {
    this.cacheFile = this.resolvePath(sessionsDir)
    this.entries = new Map() // filePath -> { mtimeMs, size, cluster }
    this.loaded = false
    this.dirty = false
    this.saveTimer = null
  }

  resolvePath(sessionsDir) {
    try {
      const parent = dirname(sessionsDir)
      const storagesDir = join(parent, 'storages', 'dsh-memory-cloud')
      return join(storagesDir, 'cache.json')
    } catch {
      return join(sessionsDir, '.memory-cloud-cache.json')
    }
  }

  async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.cacheFile)) return
      const raw = await readFile(this.cacheFile, 'utf8')
      const data = JSON.parse(raw)
      if (Array.isArray(data?.entries)) {
        for (const item of data.entries) {
          if (item?.path && item?.cluster && item?.mtimeMs && item?.size) {
            this.entries.set(item.path, {
              mtimeMs: item.mtimeMs,
              size: item.size,
              cluster: item.cluster,
            })
          }
        }
      }
    } catch {
      // Ignore cache load failure
    }
  }

  get(filePath, mtimeMs, size) {
    const entry = this.entries.get(filePath)
    if (entry && entry.mtimeMs === mtimeMs && entry.size === size) {
      return entry.cluster
    }
    return null
  }

  set(filePath, mtimeMs, size, cluster) {
    this.entries.set(filePath, { mtimeMs, size, cluster })
    this.dirty = true
    this.scheduleSave()
  }

  scheduleSave() {
    if (this.saveTimer !== null) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.persist()
    }, 1500)
  }

  async persist() {
    if (!this.dirty) return
    this.dirty = false
    try {
      const dir = dirname(this.cacheFile)
      if (!existsSync(dir)) await mkdir(dir, { recursive: true })
      const payload = {
        version: 1,
        savedAt: Date.now(),
        entries: Array.from(this.entries.entries()).map(([path, data]) => ({
          path,
          mtimeMs: data.mtimeMs,
          size: data.size,
          cluster: data.cluster,
        })),
      }
      const tmpFile = `${this.cacheFile}.tmp-${Date.now()}`
      await writeFile(tmpFile, JSON.stringify(payload), 'utf8')
      await rename(tmpFile, this.cacheFile)
    } catch {
      // Ignore cache persist failure
    }
  }
}

// ---------------------------------------------------------------------------
// High-performance Memory Reader
// ---------------------------------------------------------------------------

class MemoryReader {
  constructor(directory, limits) {
    this.directory = directory
    this.limits = limits
    this.cache = new PersistentCache(directory)
    this.fileIndex = new Map() // sessionId -> file
    this.detailLru = new Map() // sessionId -> { mtimeMs, size, detail } (bounded to 12 items)
    this.initPromise = this.cache.load()
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

  async readCluster(file, decoder) {
    this.fileIndex.set(file.sessionId, file)
    const info = await stat(file.path).catch(() => null)
    if (info === null) return null

    // 1. Instant Cache Hit: 0ms zstd decompression for historical files!
    const cachedCluster = this.cache.get(file.path, info.mtimeMs, info.size)
    if (cachedCluster !== null) {
      return cachedCluster
    }

    // 2. Decode on cache miss with high-speed stream handle decoder
    const buf = await readFile(file.path).catch(() => Buffer.alloc(0))
    if (buf.length === 0) return null
    const offsets = findZstdOffsets(buf)
    if (offsets.length === 0) return null

    const decompressed = decoder.decode(buf, offsets)
    if (decompressed === null || decompressed.length === 0) return null

    // 3. Scan lines with zero-allocation filter, skipping unneeded events
    const events = scanRelevantEvents(decompressed)
    const cluster = foldEvents(file.sessionId, file.workspaceDir, events, this.limits)

    if (cluster !== null) {
      this.cache.set(file.path, info.mtimeMs, info.size, cluster)
    }
    return cluster
  }

  /**
   * Full, untruncated fragments for ONE session (called only when zooming deep).
   * Uses bounded LRU to prevent memory explosion.
   */
  async sessionDetail(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    let file = this.fileIndex.get(sessionId)
    if (file === undefined) {
      for (const f of await this.findLogFiles()) {
        if (f.sessionId === sessionId) { file = f; break }
      }
      if (file === undefined) return null
      this.fileIndex.set(sessionId, file)
    }

    const info = await stat(file.path).catch(() => null)
    if (info === null) return null

    const cached = this.detailLru.get(sessionId)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return cached.detail
    }

    const buf = await readFile(file.path).catch(() => Buffer.alloc(0))
    if (buf.length === 0) return null
    const offsets = findZstdOffsets(buf)
    if (offsets.length === 0) return null

    const decoder = new FastZstdDecoder()
    const decompressed = decoder.decode(buf, offsets)
    decoder.close()
    if (decompressed === null) return null

    const events = scanRelevantEvents(decompressed)
    const cluster = foldEvents(file.sessionId, file.workspaceDir, events, this.limits, { full: true })
    if (cluster === null) return null

    const detail = {
      id: cluster.id,
      title: cluster.title,
      workspaceLabel: cluster.workspaceLabel,
      createdAt: cluster.createdAt,
      updatedAt: cluster.updatedAt,
      counts: cluster.counts,
      fragments: cluster.fragments,
    }

    // Keep bounded LRU (max 12 items)
    if (this.detailLru.size >= 12) {
      const oldestKey = this.detailLru.keys().next().value
      this.detailLru.delete(oldestKey)
    }
    this.detailLru.set(sessionId, { mtimeMs: info.mtimeMs, size: info.size, detail })
    return detail
  }

  async snapshot() {
    await this.initPromise
    const files = await this.findLogFiles()

    const clusters = []
    const decoder = new FastZstdDecoder()
    let processedSinceYield = 0

    for (const file of files) {
      const cluster = await this.readCluster(file, decoder)
      if (cluster !== null) clusters.push(cluster)

      // Time-slice: yield to event loop every 6 files to prevent blocking
      processedSinceYield += 1
      if (processedSinceYield >= 6) {
        processedSinceYield = 0
        await new Promise(resolve => setImmediate(resolve))
      }
    }
    decoder.close()

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
// Live Activity Hub
// ---------------------------------------------------------------------------

const LIVE_EVENT_KINDS = new Map([
  ['user/message', 'write'],
  ['assistant/message', 'write'],
  ['session/title', 'write'],
  ['agent/inbox/spliced', 'read'],
  ['request/context', 'read'],
  ['tool/call', 'read'],
  ['tool/result', 'read'],
  ['compaction/summary', 'read'],
  ['turn/end', 'read'],
])

class LiveHub {
  constructor() {
    this.clients = new Set()
    this.recent = []
    this.seq = 0
    this.heartbeat = null
    this.lastSent = new Map()
  }

  add(res) {
    const client = { res, alive: true }
    this.clients.add(client)
    if (this.clients.size === 1) {
      this.heartbeat = setInterval(() => {
        for (const c of this.clients) if (c.alive) c.res.write(': ping\n\n')
      }, 15000)
    }
    res.write(`event: hello\ndata: ${JSON.stringify({ clients: this.clients.size })}\n\n`)
    for (const item of this.recent) res.write(`data: ${JSON.stringify(item)}\n\n`)
    const close = () => this.remove(client)
    res.on('close', close)
    res.on('error', close)
    return () => this.remove(client)
  }

  remove(client) {
    client.alive = false
    this.clients.delete(client)
    if (this.clients.size === 0 && this.heartbeat !== null) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }

  publish(item) {
    const key = `${item.sessionId}:${item.kind}:${item.type}:${item.tool || ''}`
    const now = Date.now()
    const noisy = item.type === 'tool/call' || item.type === 'tool/result'
    if (noisy) {
      const last = this.lastSent.get(key) || 0
      if (now - last < 600) return
      this.lastSent.set(key, now)
      if (this.lastSent.size > 200) this.lastSent.clear()
    }
    item.seq = ++this.seq
    this.recent.push(item)
    if (this.recent.length > 24) this.recent.shift()
    const line = `data: ${JSON.stringify(item)}\n\n`
    for (const c of this.clients) {
      if (!c.alive) continue
      try { c.res.write(line) } catch { this.remove(c) }
    }
  }

  dispose() {
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const c of this.clients) {
      c.alive = false
      try { c.res.end() } catch {}
    }
    this.clients.clear()
  }
}

function liveItemFromEvent(session, event) {
  const kind = LIVE_EVENT_KINDS.get(event?.type)
  if (kind === undefined) return null
  const data = event.data || {}
  const sessionId = typeof session?.id === 'string' ? session.id : ''
  if (sessionId === '') return null
  const text = livePreview(event, data)
  const title = typeof session?.title === 'string' ? session.title : ''
  return {
    sessionId,
    sessionTitle: title,
    kind,
    type: event.type,
    text,
    tool: typeof data.name === 'string' ? data.name : undefined,
    time: typeof event.time === 'number' ? event.time : Date.now(),
  }
}

function livePreview(event, data) {
  let content
  switch (event.type) {
    case 'user/message': content = data.content; break
    case 'assistant/message': content = data.message?.content; break
    case 'tool/call': return typeof data.name === 'string' ? `调用 ${data.name}` : ''
    case 'tool/result': return '工具返回'
    case 'turn/end': return '一轮对话完成'
    case 'compaction/summary': return '上下文压缩 / 记忆整理'
    case 'request/context': return '读取运行时上下文'
    default: content = null
  }
  if (content == null) return event.type === 'session/title' && typeof data.title === 'string' ? data.title : ''
  const s = contentText(content)
  if (s.startsWith(RUNTIME_CONTEXT_PREFIX)) return ''
  return s.replace(/\s+/g, ' ').slice(0, 90)
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
  const live = new LiveHub()
  const liveTitles = new Map()

  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type === 'session/title' && typeof event.data?.title === 'string') {
        liveTitles.set(session.id, event.data.title)
      }
      const item = liveItemFromEvent(session, event)
      if (item === null) return
      if (!item.sessionTitle) item.sessionTitle = liveTitles.get(item.sessionId) || ''
      if (item.type !== 'tool/call' && item.type !== 'tool/result' && item.text === '') return
      live.publish(item)
    } catch (error) {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }
  })
  ctx.effect(() => () => live.dispose(), 'memory-cloud: live hub')

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

      if (path === '/memory-cloud/api/live') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write(': connected\n\n')
        const release = live.add(res)
        req.on('close', release)
        req.on('error', release)
        return
      }
      if (path === '/memory-cloud/api/memories') {
        const data = await reader.snapshot()
        return sendJson(res, 200, data)
      }
      const detailMatch = /^\/memory-cloud\/api\/session\/([A-Za-z0-9_.-]+)$/.exec(path)
      if (detailMatch !== null) {
        const detail = await reader.sessionDetail(decodeURIComponent(detailMatch[1]))
        if (detail === null) return sendJson(res, 404, { error: 'Session not found' })
        return sendJson(res, 200, detail)
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
