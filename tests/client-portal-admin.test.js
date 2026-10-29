const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const bcrypt = require('bcryptjs')
const { mountClientPortal } = require('../client-portal-auth')

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saip-client-portal-admin-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const accountsFile = path.join(dir, 'client_portal_accounts.json')
  fs.writeFileSync(accountsFile, JSON.stringify({
    'owner-1::client@example.com': {
      workspaceOwnerId: 'owner-1', clientId: 'client-1', email: 'client@example.com',
      name: 'Client One', pin_hash: bcrypt.hashSync('123456', 4), active: true,
      createdAt: '2026-10-01T00:00:00.000Z', snapshot: { invoices: [{ id: 'private-invoice' }], quotes: [], tickets: [], payments: [] },
    },
    'owner-2::client@example.com': {
      workspaceOwnerId: 'owner-2', clientId: 'client-2', email: 'client@example.com',
      name: 'Other Workspace Client', pin_hash: bcrypt.hashSync('654321', 4), active: true,
      snapshot: { invoices: [], quotes: [], tickets: [], payments: [] },
    },
  }))
  const routes = new Map()
  const app = {
    get(route, ...handlers) { routes.set('GET ' + route, handlers) },
    post(route, ...handlers) { routes.set('POST ' + route, handlers) },
    patch(route, ...handlers) { routes.set('PATCH ' + route, handlers) },
  }
  const workspaces = {}
  mountClientPortal(app, {
    DATA_DIR: dir,
    loadJson(file, fallback) {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
    },
    saveJson(file, value) { fs.writeFileSync(file, JSON.stringify(value)) },
    workspaces,
    auth: (_req, _res, next) => next(),
    now: () => '2026-10-29T12:00:00.000Z',
    JWT_SECRET: 'test-secret-for-client-portal',
    loginRateLimit: (_req, _res, next) => next(),
    safeEmail(value) {
      const email = String(value || '').trim().toLowerCase()
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null
    },
    git: null,
  })
  async function call(method, route, { actorId = 'owner-1', params = {}, body = {} } = {}) {
    const handlers = routes.get(method + ' ' + route)
    assert.ok(handlers, 'registered route ' + method + ' ' + route)
    const handler = handlers[handlers.length - 1]
    let statusCode = 200
    let payload
    const res = { status(code) { statusCode = code; return this }, json(value) { payload = value; return this } }
    await handler({ user: { id: actorId }, params, body }, res)
    return { statusCode, payload }
  }
  return { call, dir }
}

test('owner portal account list is workspace-scoped and excludes secrets/snapshots', async (t) => {
  const h = harness(t)
  const r = await h.call('GET', '/api/client-portal/accounts')
  assert.equal(r.statusCode, 200)
  assert.equal(r.payload.accounts.length, 1)
  assert.equal(r.payload.accounts[0].email, 'client@example.com')
  assert.equal('pin_hash' in r.payload.accounts[0], false)
  assert.equal('snapshot' in r.payload.accounts[0], false)
})

test('owner can disable a portal account only in their own workspace', async (t) => {
  const h = harness(t)
  const r = await h.call('PATCH', '/api/client-portal/accounts/:email/status', {
    params: { email: 'client@example.com' }, body: { active: false },
  })
  assert.equal(r.statusCode, 200)
  assert.equal(r.payload.account.active, false)
  const other = await h.call('PATCH', '/api/client-portal/accounts/:email/status', {
    actorId: 'owner-3', params: { email: 'client@example.com' }, body: { active: false },
  })
  assert.equal(other.statusCode, 404)
})

test('owner can reset portal PIN and server returns it only once', async (t) => {
  const h = harness(t)
  const r = await h.call('POST', '/api/client-portal/accounts/:email/reset-pin', {
    params: { email: 'client@example.com' },
  })
  assert.equal(r.statusCode, 200)
  assert.match(r.payload.pin, /^\d{6}$/)
  const accounts = JSON.parse(fs.readFileSync(path.join(h.dir, 'client_portal_accounts.json'), 'utf8'))
  assert.equal(bcrypt.compareSync(r.payload.pin, accounts['owner-1::client@example.com'].pin_hash), true)
  assert.equal(r.payload.pin === '123456', false)
  assert.equal('pin_hash' in r.payload, false)
})
