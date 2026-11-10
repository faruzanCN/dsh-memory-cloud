import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, inject } from './index.js'

// Exercise the registered HTTP handlers, not a copy of their access checks.
// The Connection double models its documented admission result; signing and
// Host/Origin validation remain DSH's responsibility. Requests must be forwarded
// unchanged so that the real Connection can apply those checks.
async function harness(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'memory-cloud-auth-'))
  const sessionsDir = join(directory, 'sessions')
  await mkdir(sessionsDir)
  const routes = [], dispose = [], events = new EventEmitter(), seen = [], warnings = []
  const state = { revoked: false, broken: false }
  const connection = {
    admit(req) {
      seen.push(req)
      if (state.broken) throw new Error('private authentication error')
      if (req.headers.host !== `127.0.0.1:${server.address().port}` ||
          req.headers['sec-fetch-site'] === 'cross-site' ||
          (req.headers.origin && req.headers.origin !== base)) return { rejection: 403 }
      if (state.revoked || req.headers.cookie !== 'dsh-fixture=owner') {
        if (req.headers.cookie === 'dsh-fixture=shared') return { peer: { principal: { kind: 'shared' } } }
        return { rejection: 401 }
      }
      return { peer: { principal: { kind: 'owner' } } }
    },
  }
  const ctx = {
    connection,
    logger: { warn: message => warnings.push(message), error() {} },
    on: (name, fn) => events.on(name, fn),
    effect(fn) { const release = fn(); if (typeof release === 'function') dispose.push(release) },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
  apply(ctx, { sessionsDir, ...config })
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname
    const route = routes.find(r => r.kind === 'exact' && r.path === path) ||
      routes.find(r => r.kind === 'prefix' && path.startsWith(r.path + '/'))
    if (route) void route.handler(req, res)
    else { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    for (const release of dispose.reverse()) release()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  return {
    ctx, state, seen, warnings,
    request: (path, init) => fetch(base + path, { redirect: 'manual', ...init }),
    rawRequest: (path, headers) => new Promise((resolve, reject) => {
      const request = httpRequest(base + path, { headers }, response => {
        response.resume()
        response.on('end', () => resolve(response))
      })
      request.on('error', reject)
      request.end()
    }),
    owner: { cookie: 'dsh-fixture=owner' },
    publish: text => events.emit('session/event', { id: 'fixture-session', title: 'Fixture' },
      { type: 'user/message', time: Date.now(), data: { content: text } }),
  }
}

const paths = [
  '/memory-cloud', '/memory-cloud/', '/memory-cloud/index.html',
  '/memory-cloud/nebula.js', '/memory-cloud/nucleus-agent.js', '/memory-cloud/nebula.css',
  '/memory-cloud/api/memories', '/memory-cloud/api/session/fixture-session',
  '/memory-cloud/api/live', '/memory-cloud/unknown',
]

test('all routes require DSH authentication, including loopback, redirect and SSE', async t => {
  assert.ok(inject.includes('connection'))
  const h = await harness(t)
  h.publish('PRIVATE_REPLAY_FIXTURE')
  for (const path of paths) {
    for (const method of ['GET', 'HEAD']) {
      const response = await h.request(path, { method })
      assert.equal(response.status, 401, `${method} ${path}`)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.notEqual(response.headers.get('content-type')?.split(';')[0], 'text/event-stream')
      assert.equal(response.headers.get('location'), null)
      assert.ok(!(await response.text()).includes('PRIVATE_REPLAY_FIXTURE'))
    }
  }
})

test('forged credentials and non-owner Peers cannot access any memory route', async t => {
  const h = await harness(t)
  for (const path of paths) {
    const forged = await h.request(path, { headers: { cookie: 'dsh-fixture=forged' } })
    assert.equal(forged.status, 401, path)
    const shared = await h.request(path, { headers: { cookie: 'dsh-fixture=shared' } })
    assert.equal(shared.status, 403, path)
  }
})

test('DSH trust rejections win over valid cookies and legacy plugin trustedHosts', async t => {
  const h = await harness(t, { trustedHosts: ['attacker.example'] })
  assert.ok(h.warnings.some(message => message.includes('deprecated')))
  for (const headers of [
    { ...h.owner, host: 'attacker.example' },
    { ...h.owner, origin: 'https://attacker.example' },
    { ...h.owner, 'sec-fetch-site': 'cross-site' },
  ]) {
    const response = await h.rawRequest('/memory-cloud/api/memories', headers)
    assert.equal(response.statusCode, 403, JSON.stringify(headers))
    const request = h.seen.at(-1)
    for (const [key, value] of Object.entries(headers)) assert.equal(request.headers[key], value)
  }
})

test('authenticated owners can load the complete page and data API', async t => {
  const h = await harness(t)
  const redirect = await h.request('/memory-cloud', { headers: h.owner })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), '/memory-cloud/')
  for (const path of paths.slice(1, 6)) {
    const response = await h.request(path, { headers: h.owner })
    assert.equal(response.status, 200, path)
    assert.ok((await response.text()).length > 0)
  }
  const data = await h.request('/memory-cloud/api/memories', { headers: h.owner })
  assert.equal(data.status, 200)
  assert.deepEqual((await data.json()).sessions, [])
  const missing = await h.request('/memory-cloud/api/session/not-found', { headers: h.owner })
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error, 'Session not found')
  assert.equal((await h.request('/memory-cloud/api/live', { method: 'HEAD', headers: h.owner })).status, 200)
  assert.equal((await h.request('/memory-cloud/api/memories', { method: 'POST', headers: h.owner })).status, 405)
})

test('missing or failing DSH authentication never falls back to public access', async t => {
  const h = await harness(t)
  for (const connection of [undefined, {}, { admit: () => undefined }]) {
    h.ctx.connection = connection
    for (const path of paths) {
      const response = await h.request(path, { headers: h.owner })
      assert.equal(response.status, 503, path)
      assert.ok(!(await response.text()).includes('<canvas'))
    }
  }
  h.ctx.connection = { admit() { throw new Error('private authentication error') } }
  const failure = await h.request('/memory-cloud/api/memories', { headers: h.owner })
  assert.equal(failure.status, 500)
  assert.ok(!(await failure.text()).includes('private authentication error'))
})

test('SSE owner receives replay and new data; expired credentials stop further delivery', async t => {
  const h = await harness(t)
  h.publish('PRIVATE_REPLAY_FIXTURE')
  const controller = new AbortController()
  t.after(() => controller.abort())
  const response = await h.request('/memory-cloud/api/live', { headers: h.owner, signal: controller.signal })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.match(new TextDecoder().decode(first.value), /PRIVATE_REPLAY_FIXTURE/)
  const update = reader.read()
  h.publish('PRIVATE_NEW_FIXTURE')
  assert.match(new TextDecoder().decode((await update).value), /PRIVATE_NEW_FIXTURE/)
  h.state.revoked = true
  const ended = reader.read()
  h.publish('PRIVATE_AFTER_REVOCATION')
  assert.equal((await ended).done, true)
})
