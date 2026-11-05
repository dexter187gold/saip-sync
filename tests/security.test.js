const test = require('node:test')
const assert = require('node:assert/strict')
const { mountSecurity, isSessionVersionValid, clientIp } = require('../security')

function runCors(origin, method = 'GET') {
  const middleware = []
  mountSecurity({ use: (fn) => middleware.push(fn) })
  const headers = {}
  let statusCode = 200
  let ended = false
  let nextCalled = false
  const req = { headers: { origin }, method, ip: '127.0.0.1', socket: {} }
  const res = {
    setHeader(name, value) { headers[name.toLowerCase()] = value },
    removeHeader(name) { delete headers[name.toLowerCase()] },
    status(code) { statusCode = code; return this },
    end() { ended = true; return this },
    json(value) { this.body = value; return this },
  }
  middleware[1](req, res, () => { nextCalled = true })
  return { headers, statusCode, ended, nextCalled }
}

test('allows the production Cloudflare Pages app origin', () => {
  const result = runCors('https://sa-invoice-pro.pages.dev')
  assert.equal(result.headers['access-control-allow-origin'], 'https://sa-invoice-pro.pages.dev')
  assert.equal(result.headers['access-control-allow-credentials'], 'true')
  assert.equal(result.nextCalled, true)
})

test('does not reflect an arbitrary hostile origin', () => {
  const result = runCors('https://attacker.example')
  assert.equal(result.headers['access-control-allow-origin'], undefined)
  assert.equal(result.headers['access-control-allow-credentials'], undefined)
  assert.equal(result.nextCalled, true)
})

test('does not trust arbitrary customer subdomains on shared hosting platforms', () => {
  for (const origin of ['https://attacker.pages.dev', 'https://attacker.onrender.com', 'https://attacker.vercel.app']) {
    const result = runCors(origin)
    assert.equal(result.headers['access-control-allow-origin'], undefined, origin)
    assert.equal(result.headers['access-control-allow-credentials'], undefined, origin)
  }
})

test('does not grant hostile origins access through preflight headers', () => {
  const result = runCors('https://attacker.example', 'OPTIONS')
  assert.equal(result.headers['access-control-allow-origin'], undefined)
  assert.equal(result.ended, true)
  assert.equal(result.statusCode, 204)
})

test('session version validation rejects tokens after a password reset or logout', () => {
  const user = { id: 'user-1', session_version: 0 }
  assert.equal(isSessionVersionValid({ id: 'user-1' }, user), true)
  assert.equal(isSessionVersionValid({ id: 'user-1', sv: 0 }, user), true)
  user.session_version = 1
  assert.equal(isSessionVersionValid({ id: 'user-1', sv: 0 }, user), false)
  assert.equal(isSessionVersionValid({ id: 'user-1', sv: 1 }, user), true)
  assert.equal(isSessionVersionValid(null, user), false)
})

test('admin APIs reject an admin JWT after its account session version changes', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const jwt = require('jsonwebtoken')
  const { mountAdmin } = require('../admin')
  const secret = 'test-admin-session-secret-at-least-32-characters'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saip-admin-session-'))
  try {
    const users = {
      'admin@example.com': { id: 'admin-1', email: 'admin@example.com', role: 'admin', session_version: 1 },
    }
    const routes = new Map()
    const app = {
      get(route, ...handlers) { routes.set('GET ' + route, handlers) },
      post(route, ...handlers) { routes.set('POST ' + route, handlers) },
      patch(route, ...handlers) { routes.set('PATCH ' + route, handlers) },
      put(route, ...handlers) { routes.set('PUT ' + route, handlers) },
      delete(route, ...handlers) { routes.set('DELETE ' + route, handlers) },
    }
    mountAdmin(app, {
      users, workspaces: {}, persistUsers() {}, persistWorkspaces() {},
      auth(_req, _res, next) { next() }, JWT_SECRET: secret,
      PUBLIC_BASE: 'https://saip-sync.example', now: () => new Date().toISOString(),
      git: null, gitMeta: {}, strongPassword: () => ({ ok: true }),
      safeEmail: (value) => String(value || '').toLowerCase(),
      DATA_DIR: dir, loginRateLimit(_req, _res, next) { next() },
    })
    const [adminAuth, handler] = routes.get('GET /api/admin/stats')
    const token = jwt.sign({ id: 'admin-1', email: 'admin@example.com', sv: 0 }, secret)
    const req = { headers: { authorization: 'Bearer ' + token } }
    let statusCode = 200
    let nextCalled = false
    const res = { status(code) { statusCode = code; return this }, json() { return this } }
    adminAuth(req, res, () => { nextCalled = true; handler(req, res) })
    assert.equal(nextCalled, false)
    assert.equal(statusCode, 403)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('rate-limit identity ignores spoofed X-Forwarded-For values', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '198.51.100.7' }, ip: '203.0.113.9', socket: { remoteAddress: '203.0.113.9' } }), '203.0.113.9')
})

test('CORS preflight explicitly permits owner-token header for trusted origins', () => {
  const result = runCors('https://sa-invoice-pro.pages.dev', 'OPTIONS')
  assert.match(result.headers['access-control-allow-headers'], /X-Owner-Token/i)
})
