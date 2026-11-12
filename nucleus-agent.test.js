import test from 'node:test'
import assert from 'node:assert/strict'
import { NucleusAgent, NucleusOrbit, memoryBreath, MEMORY_BREATH_MS, passageLight, TRANSIT_MS } from './nucleus-agent.js'
const event=(type,id,time=100000)=>({type,sessionId:'s',sourceSeq:id,time})
test('one input and output per turn; waiting persists; chunks/tools do not refire',()=>{
 const m=new NucleusAgent()
 assert.equal(m.mode(0),'idle')
 assert.equal(m.accept(event('user/message',1),0,100000),'input')
 assert.equal(m.accept(event('user/message',1),20,100000),null)
 assert.equal(m.mode(100),'conversing')
 assert.equal(m.mode(TRANSIT_MS+1),'waiting')
 m.accept(event('stream/start',2),3000,100000)
 assert.equal(m.mode(100000),'waiting')
 assert.equal(m.accept(event('stream/data',3),3100,100000),'output')
 assert.equal(m.accept(event('assistant/message',4),3200,100000),null)
 m.accept(event('tool/call',5),3300,100000)
 m.accept(event('stream/start',6),3400,100000)
 assert.equal(m.accept(event('stream/data',7),3500,100000),null)
 m.accept(event('turn/end',8),4000,100000)
 assert.equal(m.mode(4001),'idle')
 assert.equal(m.accept(event('user/message',9),5000,100000),'input')
 assert.equal(m.accept(event('stream/data',10),5100,100000),'output')
})
test('SSE replay and stale history never restart an idle nucleus',()=>{
 const m=new NucleusAgent()
 assert.equal(m.accept({...event('user/message',1),replay:true},0,100000),null)
 assert.equal(m.accept(event('stream/start',2,0),0,100000),null)
 assert.equal(m.mode(1),'idle')
})
test('one pass, exact zero endpoints; brightness advances smoothly',()=>{
 for(const t of [0,.25,.5,.75,1]) {assert.equal(passageLight(t,0),0);assert.equal(passageLight(t,TRANSIT_MS),0);assert.equal(passageLight(t,TRANSIT_MS*2),0)}
 const peaks=[400,900,1500,2000].map(age=>{
  let best=0,level=-1
  for(let k=0;k<=1000;k++){const l=passageLight(k/1000,age);if(l>level){level=l;best=k/1000}}
  return best
 })
 for(let i=1;i<peaks.length;i++)assert.ok(peaks[i]>peaks[i-1])
 let jump=0
 for(let age=0;age<TRANSIT_MS;age++)jump=Math.max(jump,Math.abs(passageLight(.5,age+1)-passageLight(.5,age)))
 assert.ok(jump<.005,`per-ms jump ${jump}`)
})

const sessionEvent = (sessionId, type, sourceSeq, time = 100000) => ({ sessionId, type, sourceSeq, time })
const near = (actual, expected, tolerance = 1e-11) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`,
)

test('active count follows unique conversations through waiting, tools and completion', () => {
  const agent = new NucleusAgent()
  const accept = (sessionId, type, seq, now = seq * 10) => agent.accept(sessionEvent(sessionId, type, seq), now, 100000)
  assert.equal(agent.activeCount(), 0)
  accept('a', 'user/message', 1)
  accept('a', 'turn/start', 2)
  accept('a', 'stream/start', 3)
  accept('a', 'request/header', 4)
  assert.equal(agent.activeCount(), 1)
  accept('b', 'tool/call', 5)
  accept('b', 'tool/result', 6)
  assert.equal(agent.activeCount(), 2)
  assert.deepEqual(agent.activeSessionsSnapshot(100000), [
    { sessionId: 'a', mode: 'waiting' }, { sessionId: 'b', mode: 'conversing' },
  ])
  accept('a', 'stream/data', 7)
  accept('a', 'assistant/message', 8)
  assert.equal(agent.activeCount(), 2)
  accept('a', 'turn/end', 9)
  assert.equal(agent.activeCount(), 1)
  accept('b', 'stream/error', 10)
  assert.equal(agent.activeCount(), 0)
  assert.deepEqual(agent.activeSessionsSnapshot(100000), [])
  accept('a', 'turn/start', 11)
  assert.equal(agent.activeCount(), 1)
  assert.equal(accept('a', 'stream/data', 12), 'output')
})

test('tools before text preserve exactly one genuine response pulse', () => {
  const agent = new NucleusAgent()
  const accept = (type, sourceSeq, now) => agent.accept(sessionEvent('a', type, sourceSeq), now, 100000)
  assert.equal(accept('user/message', 1, 0), 'input')
  assert.equal(accept('tool/call', 2, 100), null)
  assert.equal(accept('tool/result', 3, 200), null)
  assert.equal(agent.activeCount(), 1)
  assert.equal(agent.mode(TRANSIT_MS + 100), 'conversing')
  assert.equal(accept('stream/start', 4, TRANSIT_MS + 200), null)
  assert.equal(agent.mode(TRANSIT_MS + 201), 'waiting')
  assert.equal(accept('stream/data', 5, TRANSIT_MS + 300), 'output')
  assert.equal(accept('assistant/message', 6, TRANSIT_MS + 400), null)
  assert.equal(accept('tool/call', 7, TRANSIT_MS + 500), null)
  assert.equal(accept('tool/result', 8, TRANSIT_MS + 600), null)
  assert.equal(accept('stream/start', 9, TRANSIT_MS + 700), null)
  assert.equal(accept('stream/data', 10, TRANSIT_MS + 800), null)
  assert.equal(agent.activeCount(), 1)
  accept('turn/end', 11, TRANSIT_MS + 900)
  assert.equal(agent.activeCount(), 0)
})

test('duplicate, replayed, stale and malformed events do not inflate activity', () => {
  const agent = new NucleusAgent()
  const start = sessionEvent('a', 'user/message', 1)
  agent.accept(start, 0, 100000)
  agent.accept(start, 1, 100000)
  agent.accept({ ...sessionEvent('b', 'stream/start', 2), replay: true }, 2, 100000)
  agent.accept(sessionEvent('c', 'tool/call', 3, 50000), 3, 100000)
  agent.accept(sessionEvent('', 'turn/start', 4), 4, 100000)
  agent.accept(sessionEvent(undefined, 'turn/start', 5), 5, 100000)
  agent.accept(null, 6, 100000)
  assert.equal(agent.activeCount(), 1)
  agent.accept(sessionEvent('a', 'turn/end', 6), 7, 100000)
  agent.accept(start, 8, 100000)
  assert.equal(agent.activeCount(), 0)
})

test('authoritative snapshots restore mid-turn activity without replay flow pulses', () => {
  const server = new NucleusAgent()
  server.accept(sessionEvent('input', 'user/message', 1), 100, 100000)
  server.accept(sessionEvent('output', 'assistant/message', 2), 150, 100000)
  const records = server.activeSessionsSnapshot(TRANSIT_MS + 101)
  assert.deepEqual(records, [
    { sessionId: 'input', mode: 'waiting' }, { sessionId: 'output', mode: 'conversing' },
  ])
  const client = new NucleusAgent()
  assert.equal(client.syncActiveSessions(records, 20000), undefined)
  assert.equal(client.activeCount(), 2)
  assert.deepEqual(client.activeSessionsSnapshot(30000), records)
  assert.equal(client.accept(sessionEvent('output', 'stream/data', 3), 20010, 100000), null)
  assert.equal(client.accept(sessionEvent('input', 'stream/data', 4), 20020, 100000), 'output')
  client.syncActiveSessions([
    { sessionId: 'input', mode: 'waiting' },
    { sessionId: 'input', mode: 'conversing' },
    { sessionId: '', mode: 'waiting' },
    { sessionId: 'invalid', mode: 'idle' },
    null,
  ], 20030)
  assert.equal(client.activeCount(), 1)
  assert.deepEqual(client.activeSessionsSnapshot(20030), [{ sessionId: 'input', mode: 'conversing' }])
  assert.equal(client.accept(sessionEvent('input', 'assistant/message', 5), 20040, 100000), null)
  client.syncActiveSessions([], 20050)
  assert.equal(client.activeCount(), 0)
  assert.equal(client.mode(20050), 'idle')
})

test('snapshot refresh preserves in-flight input and acknowledged output state', () => {
  const agent = new NucleusAgent()
  const start = sessionEvent('a', 'user/message', 1)
  agent.accept(start, 0, 100000)
  agent.syncActiveSessions([{ sessionId: 'a', mode: 'conversing' }], 100)
  assert.equal(agent.mode(200), 'conversing')
  assert.equal(agent.mode(TRANSIT_MS + 1), 'waiting')
  assert.equal(agent.accept(start, 200, 100000), null)
  assert.equal(agent.accept(sessionEvent('a', 'stream/data', 2), 300, 100000), 'output')
  agent.syncActiveSessions([{ sessionId: 'a', mode: 'waiting' }], 400)
  assert.equal(agent.accept(sessionEvent('a', 'stream/data', 3), 500, 100000), null)
  agent.syncActiveSessions(null, 600)
  assert.equal(agent.activeCount(), 1)
  agent.accept(sessionEvent('a', 'turn/end', 4), 700, 100000)
  agent.syncActiveSessions([{ sessionId: 'a', mode: 'waiting' }], 800)
  assert.equal(agent.accept(sessionEvent('a', 'stream/data', 5), 900, 100000), 'output')
})

test('authoritative conversing mode supersedes an elapsed local input wait', () => {
  const agent = new NucleusAgent()
  agent.accept(sessionEvent('a', 'user/message', 1), 0, 100000)
  agent.syncActiveSessions([{ sessionId: 'a', mode: 'conversing' }], TRANSIT_MS + 1)
  assert.equal(agent.mode(TRANSIT_MS + 100), 'conversing')
  assert.equal(agent.accept(sessionEvent('a', 'stream/data', 2), TRANSIT_MS + 200, 100000), null)
})

test('orbit target speed increases with active count and stays below the strobe cap', () => {
  near(NucleusOrbit.targetSpeed(0), 0.16)
  near(NucleusOrbit.targetSpeed(1), 0.45)
  near(NucleusOrbit.targetSpeed(4), 1, 0.01)
  let previous = 0
  for (let count = 0; count <= 100; count += 1) {
    const speed = NucleusOrbit.targetSpeed(count)
    assert.ok(speed >= previous && speed <= 2)
    previous = speed
  }
  assert.equal(NucleusOrbit.targetSpeed(100000), 2)
  for (const count of [-10, NaN, undefined, Infinity]) near(NucleusOrbit.targetSpeed(count), 0.16)
})

test('orbit accelerates and decelerates continuously without phase resets', () => {
  const orbit = new NucleusOrbit()
  assert.deepEqual(orbit.update(0, 0), { phase: 0, speed: 0.16 })
  const idle = orbit.update(20, 0)
  near(idle.phase, 0.0032)
  const before = orbit.phase
  assert.equal(orbit.update(20, 4).phase, before)
  let previousSpeed = orbit.speed
  for (let now = 40; now <= 6020; now += 20) {
    const previousPhase = orbit.phase
    const result = orbit.update(now, 4)
    assert.ok(result.speed >= previousSpeed && result.speed < NucleusOrbit.targetSpeed(4))
    assert.ok(result.phase > previousPhase)
    previousSpeed = result.speed
  }
  near(orbit.speed, NucleusOrbit.targetSpeed(4), 0.0001)
  const peak = orbit.speed
  for (let now = 6040; now <= 12020; now += 20) {
    const previousPhase = orbit.phase
    const result = orbit.update(now, 0)
    assert.ok(result.speed <= previousSpeed && result.speed > 0.16)
    assert.ok(result.phase > previousPhase)
    previousSpeed = result.speed
  }
  assert.ok(orbit.speed < peak)
  near(orbit.speed, 0.16, 0.0001)
})

function simulateOrbit(steps, count, orbit = new NucleusOrbit(), start = 0) {
  orbit.update(start, count)
  const end = start + 4000
  for (let i = 1; i <= steps; i += 1) orbit.update(start + (end - start) * i / steps, count)
  return orbit
}

test('orbit exactly integrates exponential velocity independent of frame rate', () => {
  const target = NucleusOrbit.targetSpeed(4)
  const expectedSpeed = target + (0.16 - target) * Math.exp(-4 / 0.65)
  const expectedPhase = target * 4 + (0.16 - target) * 0.65 * (1 - Math.exp(-4 / 0.65))
  for (const fps of [20, 30, 60, 144]) {
    const orbit = simulateOrbit(fps * 4, 4)
    near(orbit.phase, expectedPhase)
    near(orbit.speed, expectedSpeed)
  }
  const slow = simulateOrbit(120, 4)
  const fast = simulateOrbit(576, 4)
  simulateOrbit(120, 0, slow, 4000)
  simulateOrbit(576, 0, fast, 4000)
  near(slow.phase, fast.phase)
  near(slow.speed, fast.speed)
})

test('memory breathing remains positive, smooth and periodic at arbitrary sample times', () => {
  near(memoryBreath(800), 1)
  near(memoryBreath(2400), 0.35)
  for (const seed of [0, 123, 0xffffffff]) {
    for (let now = 0; now <= MEMORY_BREATH_MS * 3; now += 1) {
      const level = memoryBreath(now, seed)
      assert.ok(level >= 0.35 - 1e-12 && level <= 1 + 1e-12)
      assert.ok(Math.abs(memoryBreath(now + 1, seed) - level) < 0.00065)
      near(memoryBreath(now + MEMORY_BREATH_MS, seed), level)
    }
  }
  for (const now of [NaN, Infinity, undefined]) near(memoryBreath(now), memoryBreath(0))
})

test('every active conversation breathes through long waits and tool activity without a timeout', () => {
  const agent = new NucleusAgent()
  const accept = (sessionId, type, seq) => agent.accept(sessionEvent(sessionId, type, seq), seq * 10, 100000)
  for (const id of ['waiting', 'tools', 'responding', 'done', 'missing']) {
    assert.equal(agent.isActive(id), false)
    assert.equal(agent.clusterActivity(id, 0), 0)
  }
  accept('waiting', 'user/message', 1)
  accept('waiting', 'stream/start', 2)
  accept('tools', 'tool/call', 3)
  accept('tools', 'tool/result', 4)
  accept('responding', 'assistant/message', 5)
  accept('done', 'user/message', 6)
  accept('done', 'turn/end', 7)
  assert.equal(agent.activeCount(), 3)
  for (const now of [0, 5000, 60000, 600000, 3600000]) {
    for (const id of ['waiting', 'tools', 'responding']) {
      assert.equal(agent.isActive(id), true)
      assert.ok(agent.clusterActivity(id, now) >= 0.35)
    }
    for (const id of ['done', 'missing']) assert.equal(agent.clusterActivity(id, now), 0)
  }
  accept('waiting', 'turn/end', 8)
  accept('tools', 'stream/error', 9)
  for (const id of ['waiting', 'tools']) {
    assert.equal(agent.isActive(id), false)
    assert.equal(agent.clusterActivity(id, 3600001), 0)
  }
  assert.equal(agent.isActive('responding'), true)
})

test('cluster breathing restores from snapshots and clears only removed or completed sessions', () => {
  const agent = new NucleusAgent()
  agent.syncActiveSessions([
    { sessionId: 'waiting', mode: 'waiting' },
    { sessionId: 'talking', mode: 'conversing' },
  ], 100)
  for (const now of [100, 200000, 1200000]) {
    assert.ok(agent.clusterActivity('waiting', now) > 0)
    assert.ok(agent.clusterActivity('talking', now) > 0)
  }
  const before = agent.clusterActivity('waiting', 1200000)
  agent.syncActiveSessions([{ sessionId: 'waiting', mode: 'waiting' }], 1200000)
  near(agent.clusterActivity('waiting', 1200000), before)
  assert.equal(agent.clusterActivity('talking', 1200000), 0)
  agent.syncActiveSessions([], 1200001)
  assert.equal(agent.clusterActivity('waiting', 1200001), 0)
})

test('cluster phase depends only on session id and time, never frame or event frequency', () => {
  const agent = new NucleusAgent()
  agent.accept(sessionEvent('a', 'user/message', 1), 0, 100000)
  agent.accept(sessionEvent('b', 'user/message', 2), 0, 100000)
  const baseline = agent.clusterActivity('a', 12345)
  for (const fps of [20, 30, 60, 144]) {
    for (let frame = 0; frame <= fps * 5; frame += 1) agent.clusterActivity('a', frame * 1000 / fps)
    near(agent.clusterActivity('a', 12345), baseline)
  }
  agent.accept(sessionEvent('a', 'tool/call', 3), 1000, 100000)
  agent.accept(sessionEvent('a', 'tool/result', 4), 1100, 100000)
  near(agent.clusterActivity('a', 12345), baseline)
  assert.notEqual(agent.clusterActivity('a', 0), agent.clusterActivity('b', 0))
  for (const id of ['', null, undefined, 12]) {
    assert.equal(agent.isActive(id), false)
    assert.equal(agent.clusterActivity(id, 0), 0)
  }
})

test('tab resume gaps, duplicate times and invalid clocks never create large orbit jumps', () => {
  const orbit = simulateOrbit(240, 100)
  const before = orbit.phase
  const resumed = orbit.update(600000, 100)
  assert.ok(resumed.phase > before)
  assert.ok(resumed.phase - before <= 0.2 + 1e-12)
  const snapshot = { phase: orbit.phase, speed: orbit.speed }
  for (const now of [600000, 1, NaN, Infinity]) assert.deepEqual(orbit.update(now, 0), snapshot)
  const next = orbit.update(600016, 100)
  assert.ok(next.phase - snapshot.phase <= 0.032 + 1e-12)
})
