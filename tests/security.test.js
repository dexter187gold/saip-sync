const test = require('node:test')
const assert = require('node:assert/strict')
const { mountSecurity, isSessionVersionValid } = require('../security')

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
