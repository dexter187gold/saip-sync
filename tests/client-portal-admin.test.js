const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
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
  async function call(method, route, { actorId = 'owner-1', clientUser = null, params = {}, body = {} } = {}) {
    const handlers = routes.get(method + ' ' + route)
    assert.ok(handlers, 'registered route ' + method + ' ' + route)
    const handler = handlers[handlers.length - 1]
    let statusCode = 200
    let payload
    const res = { status(code) { statusCode = code; return this }, json(value) { payload = value; return this } }
    await handler({ user: { id: actorId }, clientUser, params, body }, res)
    return { statusCode, payload }
  }
  async function authenticateClient(token) {
    const middleware = routes.get('GET /api/client-portal/me')[0]
    let statusCode = 200
    let payload
    let nextCalled = false
    const res = { status(code) { statusCode = code; return this }, json(value) { payload = value; return this } }
    middleware({ headers: { authorization: 'Bearer ' + token } }, res, () => { nextCalled = true })
    return { statusCode, payload, nextCalled }
  }
  return { call, dir, workspaces, authenticateClient }
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


test('disabled portal accounts cannot start a new client session', async (t) => {
  const h = harness(t)
  const disabled = await h.call('PATCH', '/api/client-portal/accounts/:email/status', {
    params: { email: 'client@example.com' }, body: { active: false },
  })
  assert.equal(disabled.statusCode, 200)
  const login = await h.call('POST', '/api/client-portal/login', {
    body: { email: 'client@example.com', pin: '123456' },
  })
  assert.equal(login.statusCode, 401)
  assert.equal(login.payload.ok, undefined)
})


test('client portal cannot approve or reject another client quote by guessing its ID', async (t) => {
  const h = harness(t)
  h.workspaces['owner-1'] = {
    data: {
      quotes: [
        { id: 'own-quote', number: 'Q-001', clientId: 'client-1', status: 'sent' },
        { id: 'other-quote', number: 'Q-002', clientId: 'client-2', status: 'sent' },
      ],
    },
    version: 1,
  }
  const clientUser = {
    workspaceOwnerId: 'owner-1',
    email: 'client@example.com',
    clientId: 'client-1',
  }
  const denied = await h.call('POST', '/api/client-portal/quote-decision', {
    clientUser, body: { quoteId: 'other-quote', decision: 'accepted' },
  })
  assert.equal(denied.statusCode, 404)
  assert.equal(h.workspaces['owner-1'].data.quotes[1].status, 'sent')

  const allowed = await h.call('POST', '/api/client-portal/quote-decision', {
    clientUser, body: { quoteId: 'own-quote', decision: 'accepted' },
  })
  assert.equal(allowed.statusCode, 200)
  assert.equal(h.workspaces['owner-1'].data.quotes[0].status, 'accepted')
})

test('disabling a portal account immediately invalidates its existing client JWT', async (t) => {
  const h = harness(t)
  const token = jwt.sign({
    aud: 'client_portal',
    workspaceOwnerId: 'owner-1',
    email: 'client@example.com',
    clientId: 'client-1',
  }, 'test-secret-for-client-portal')
  const before = await h.authenticateClient(token)
  assert.equal(before.nextCalled, true)

  const disabled = await h.call('PATCH', '/api/client-portal/accounts/:email/status', {
    params: { email: 'client@example.com' }, body: { active: false },
  })
  assert.equal(disabled.statusCode, 200)

  const after = await h.authenticateClient(token)
  assert.equal(after.statusCode, 401)
  assert.equal(after.nextCalled, false)
})


test('client dashboard returns a detailed statement and includes payments linked by invoice ID', async (t) => {
  const h = harness(t)
  h.workspaces['owner-1'] = { data: {
    clients: [{ id: 1, name: 'Client One', email: 'client@example.com' }],
    invoices: [
      { id: 'inv-1', number: 'INV-001', clientId: 'client-1', total: 100, amountPaid: 20, amountDue: 80, status: 'partial', date: '2026-10-01' },
      { id: 'private-inv', clientId: 'client-2', total: 999, status: 'unpaid' },
    ],
    quotes: [{ id: 'q-1', clientId: 'client-1', total: 50, status: 'accepted', createdAt: '2026-10-02T10:00:00.000Z' }],
    tickets: [{ id: 'job-1', clientId: 'client-1', status: 'completed', createdAt: '2026-10-03T10:00:00.000Z' }],
    payments: [
      { id: 'pay-1', invoiceId: 'inv-1', amount: 20, method: 'EFT', reference: 'REF-1', createdAt: '2026-10-04T11:30:00.000Z' },
      { id: 'private-pay', invoiceId: 'private-inv', amount: 999 },
    ],
  }, version: 2 }
  const clientUser = { workspaceOwnerId: 'owner-1', email: 'client@example.com', clientId: '1' }
  const r = await h.call('GET', '/api/client-portal/dashboard', { clientUser })
  assert.equal(r.statusCode, 200)
  assert.equal(r.payload.invoices.length, 1)
  assert.equal(r.payload.payments.length, 1)
  assert.equal(r.payload.quotes.length, 1)
  assert.equal(r.payload.tickets.length, 1)
  assert.equal(r.payload.summary.totalInvoiced, 100)
  assert.equal(r.payload.summary.totalPaid, 20)
  assert.equal(r.payload.summary.openBalance, 80)
  assert.equal(r.payload.accountStatement.entries.length, 2)
  assert.equal(r.payload.accountStatement.entries.some((e) => e.reference === 'REF-1'), true)
})

test('client portal PayFast checkout is limited to the signed-in client and returns a signed form', async (t) => {
  const h = harness(t)
  const old = {
    id: process.env.PAYFAST_MERCHANT_ID,
    key: process.env.PAYFAST_MERCHANT_KEY,
    phrase: process.env.PAYFAST_PASSPHRASE,
    sandbox: process.env.PAYFAST_SANDBOX,
  }
  process.env.PAYFAST_MERCHANT_ID = '10000100'
  process.env.PAYFAST_MERCHANT_KEY = 'test-key'
  process.env.PAYFAST_PASSPHRASE = 'test-passphrase'
  process.env.PAYFAST_SANDBOX = 'true'
  try {
    h.workspaces['owner-1'] = { data: {
      invoices: [
        { id: 'own-invoice', number: 'INV-OWN', clientId: 'client-1', total: 150, amountPaid: 50, status: 'partial' },
        { id: 'other-invoice', number: 'INV-OTHER', clientId: 'client-2', total: 500, status: 'unpaid' },
      ],
      payments: [{ id: 'pay-1', invoiceId: 'own-invoice', clientId: 'client-1', amount: 50 }],
      settings: {},
      company: { name: 'Workshop' },
    }, version: 1 }
    const clientUser = { workspaceOwnerId: 'owner-1', email: 'client@example.com', clientId: 'client-1' }
    const ok = await h.call('POST', '/api/client-portal/pay/:invoiceId', {
      clientUser, params: { invoiceId: 'own-invoice' },
    })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.payload.configured, true)
    assert.equal(ok.payload.amount, 100)
    assert.equal(ok.payload.processUrl, 'https://sandbox.payfast.co.za/eng/process')
    assert.ok(ok.payload.fields.signature)
    const denied = await h.call('POST', '/api/client-portal/pay/:invoiceId', {
      clientUser, params: { invoiceId: 'other-invoice' },
    })
    assert.equal(denied.statusCode, 404)
  } finally {
    for (const [key, value] of Object.entries({
      PAYFAST_MERCHANT_ID: old.id, PAYFAST_MERCHANT_KEY: old.key,
      PAYFAST_PASSPHRASE: old.phrase, PAYFAST_SANDBOX: old.sandbox,
    })) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
})


test('client portal login accepts the issued username alias as well as email', async (t) => {
  const h = harness(t)
  const r = await h.call('POST', '/api/client-portal/login', {
    body: { username: 'client@example.com', pin: '123456' },
  })
  assert.equal(r.statusCode, 200)
  assert.equal(r.payload.ok, true)
  assert.ok(r.payload.token)
  assert.equal(r.payload.user.email, 'client@example.com')
})
