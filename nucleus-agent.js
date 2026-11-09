/** Pure, frame-rate-independent nucleus behaviour. No timers or DOM. */
export const TRANSIT_MS = 4200
const smooth = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x) }

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
    if (item.replay || !Number.isFinite(item.time) || Math.abs(wallNow - item.time) > 15000) return null
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
      case 'turn/start': s.mode = 'conversing'; break
      case 'stream/start': case 'request/header': s.mode = 'waiting'; break
      case 'stream/data': case 'assistant/message':
        s.mode = 'conversing'
        if (!s.outputSent) { direction = 'output'; s.outputSent = true }
        break
      case 'tool/call': case 'tool/result': s.mode = 'conversing'; break
      case 'turn/end': case 'stream/error': s.mode = 'idle'; s.inputUntil = 0; break
      default: return null
    }
    s.changed = now
    // Preserve active waits. Retain only a small number of idle sessions.
    if (this.sessions.size > 64) for (const [id, record] of this.sessions) {
      if (record.mode === 'idle' && id !== item.sessionId) { this.sessions.delete(id); break }
    }
    return direction
  }
  mode(now) {
    const active = [...this.sessions.values()].filter(s => s.mode !== 'idle')
    if (!active.length) return 'idle'
    const last = active.reduce((a, b) => a.changed > b.changed ? a : b)
    // Input is acknowledged visually; then stay waiting until an actual event
    // says data arrived. A timer never pretends the AI has finished.
    if (last.mode === 'conversing' && !last.outputSent && now >= last.inputUntil) return 'waiting'
    return last.mode
  }
}
