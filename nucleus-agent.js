/** Pure, frame-rate-independent nucleus behaviour. No timers or DOM. */
export const TRANSIT_MS = 4200
export const MEMORY_BREATH_MS = 3200
const smooth = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x) }
const validSessionId = id => typeof id === 'string' && id.trim() !== ''
const sessionMode = (session, now) => session.mode === 'conversing' && !session.outputSent && now >= session.inputUntil
  ? 'waiting' : session.mode
const sessionSeed = id => {
  let value = 2166136261
  for (let i = 0; i < id.length; i += 1) {
    value = Math.imul(value ^ id.charCodeAt(i), 16777619)
  }
  return value >>> 0
}

/** A positive 3.2-second cycle sampled from absolute monotonic time, not frames. */
export function memoryBreath(now, seed = 0) {
  const time = Number.isFinite(now) ? now : 0
  const offset = Number.isFinite(seed) ? (seed >>> 0) / 4294967296 : 0
  const cycle = ((time % MEMORY_BREATH_MS) + MEMORY_BREATH_MS) % MEMORY_BREATH_MS
  return 0.675 + 0.325 * Math.sin((cycle / MEMORY_BREATH_MS + offset) * Math.PI * 2)
}

/** Single traversal with a continuous leading and trailing edge; never wraps. */
export function passageLight(t, age) {
  if (age < 0 || age >= TRANSIT_MS) return 0
  const phase = age / TRANSIT_MS
  const head = -0.28 + phase * 1.56
  const offset = t - head
  const light = Math.exp(-0.5 * (offset / 0.17) ** 2)
  return light * smooth(phase / 0.13) * smooth((1 - phase) / 0.18)
}

export class NucleusAgent {
  constructor() { this.sessions = new Map(); this.seen = new Set() }
  accept(item, now, wallNow = Date.now()) {
    if (!item || !validSessionId(item.sessionId) || item.replay || !Number.isFinite(item.time) || Math.abs(wallNow - item.time) > 15000) return null
    const key = `${item.sessionId}:${item.type}:${item.sourceSeq ?? item.seq ?? item.time}`
    if (this.seen.has(key)) return null
    this.seen.add(key)
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value)
    let s = this.sessions.get(item.sessionId)
    if (!s) { s = { mode: 'idle', outputSent: false, inputUntil: 0, changed: now }; this.sessions.set(item.sessionId, s) }
    let direction = null
    switch (item.type) {
      case 'user/message':
        s.mode = 'conversing'; s.inputUntil = now + TRANSIT_MS; s.outputSent = false; direction = 'input'; break
      case 'turn/start':
        if (s.mode === 'idle') { s.outputSent = false; s.inputUntil = now + TRANSIT_MS }
        s.mode = 'conversing'; break
      case 'stream/start': case 'request/header': s.mode = 'waiting'; break
      case 'stream/data': case 'assistant/message':
        s.mode = 'conversing'
        if (!s.outputSent) { direction = 'output'; s.outputSent = true }
        break
      case 'tool/call': case 'tool/result':
        s.mode = 'conversing'; s.inputUntil = Infinity; break
      case 'turn/end': case 'stream/error':
        s.mode = 'idle'; s.inputUntil = 0; s.outputSent = false; break
      default: return null
    }
    s.changed = now
    // Preserve active waits. Retain only a small number of idle sessions.
    if (this.sessions.size > 64) for (const [id, record] of this.sessions) {
      if (record.mode === 'idle' && id !== item.sessionId) { this.sessions.delete(id); break }
    }
    return direction
  }
  isActive(sessionId) {
    if (!validSessionId(sessionId)) return false
    const session = this.sessions.get(sessionId)
    return session !== undefined && session.mode !== 'idle'
  }
  /** Zero for inactive sessions; otherwise a sustained [0.35, 1] breath. */
  clusterActivity(sessionId, now) {
    return this.isActive(sessionId) ? memoryBreath(now, sessionSeed(sessionId)) : 0
  }
  activeCount() {
    let count = 0
    for (const session of this.sessions.values()) if (session.mode !== 'idle') count += 1
    return count
  }
  /** Plain authoritative state for new clients; no event replay or flow pulses. */
  activeSessionsSnapshot(now) {
    return [...this.sessions]
      .filter(([, session]) => session.mode !== 'idle')
      .map(([sessionId, session]) => ({ sessionId, mode: sessionMode(session, now) }))
  }
  /** Replace activity from the server without manufacturing input/output events. */
  syncActiveSessions(list, now) {
    if (!Array.isArray(list)) return
    const next = new Map()
    for (const item of list) {
      if (!item || !validSessionId(item.sessionId) || !['waiting', 'conversing'].includes(item.mode)) continue
      const previous = this.sessions.get(item.sessionId)
      const ongoing = previous && previous.mode !== 'idle'
      next.set(item.sessionId, {
        mode: item.mode,
        // Restored conversation output is presumed already acknowledged. A
        // restored wait still permits its first real response to send output.
        outputSent: ongoing
          ? previous.outputSent || (item.mode === 'conversing' && previous.inputUntil <= now)
          : item.mode === 'conversing',
        inputUntil: ongoing ? previous.inputUntil : 0,
        changed: now,
      })
    }
    this.sessions = next
  }
  mode(now) {
    const active = [...this.sessions.values()].filter(s => s.mode !== 'idle')
    if (!active.length) return 'idle'
    const last = active.reduce((a, b) => a.changed > b.changed ? a : b)
    // Input is acknowledged visually; then stay waiting until an actual event
    // says data arrived. A timer never pretends the AI has finished.
    return sessionMode(last, now)
  }
}

/** Smooth orbit velocity with an exact exponential integral, in radians. */
export class NucleusOrbit {
  constructor() {
    this.phase = 0
    this.speed = NucleusOrbit.targetSpeed(0)
    this.lastNow = null
  }
  static targetSpeed(activeCount) {
    const count = Number.isFinite(activeCount) ? Math.max(0, Math.floor(activeCount)) : 0
    return Math.min(2, 0.16 + 0.29 * count ** 0.77)
  }
  /**
   * now is a monotonic timestamp in milliseconds (e.g. performance.now()).
   * Integrate at most 100ms after a suspended tab; discard excess elapsed time
   * so neither phase nor velocity jumps to catch up with a hidden interval.
   */
  update(now, activeCount) {
    if (!Number.isFinite(now)) return { phase: this.phase, speed: this.speed }
    if (this.lastNow === null) this.lastNow = now
    if (now <= this.lastNow) return { phase: this.phase, speed: this.speed }
    const seconds = Math.min(0.1, (now - this.lastNow) / 1000)
    this.lastNow = now
    const target = NucleusOrbit.targetSpeed(activeCount)
    const timeConstant = 0.65
    const approach = -Math.expm1(-seconds / timeConstant)
    // Integral of target + (initialSpeed - target) * exp(-t / tau).
    this.phase += target * seconds + (this.speed - target) * timeConstant * approach
    this.speed += (target - this.speed) * approach
    return { phase: this.phase, speed: this.speed }
  }
}
