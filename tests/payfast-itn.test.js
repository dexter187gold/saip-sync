import test from 'node:test'
import assert from 'node:assert/strict'
import { mountPayfastItn, buildItnSignature } from '../payfastItn.js'

function makeHarness(workspaces) {
  let handler
  const app = { post(path, fn) { assert.equal(path, '/api/payfast/itn'); handler = fn } }
  let persisted = 0
  mountPayfastItn(app, { workspaces, persistWorkspaces: () => { persisted++ }, now: () => '2026-11-03T10:00:00.000Z' })
  const response = () => ({
    code: 200, body: '',
    status(code) { this.code = code; return this },
    send(body) { this.body = body; return this },
  })
  return { invoke: async (body) => { const res = response(); await handler({ body }, res); return res }, persisted: () => persisted }
}

function signedBody(overrides = {}) {
  const body = {
    pf_payment_id: 'PF-1001',
    payment_status: 'COMPLETE',
    m_payment_id: 'INV-invoice-1',
    amount_gross: '100.00',
    merchant_id: 'MERCHANT-1',
    item_name: 'Invoice 1',
    ...overrides,
  }
  body.signature = buildItnSignature(body, 'test-passphrase')
  return body
}

function withEnv(fn) {
  const previous = {
    PAYFAST_MERCHANT_ID: process.env.PAYFAST_MERCHANT_ID,
    PAYFAST_PASSPHRASE: process.env.PAYFAST_PASSPHRASE,
    PAYFAST_SANDBOX: process.env.PAYFAST_SANDBOX,
  }
  process.env.PAYFAST_MERCHANT_ID = 'MERCHANT-1'
  process.env.PAYFAST_PASSPHRASE = 'test-passphrase'
  process.env.PAYFAST_SANDBOX = 'true'
  return Promise.resolve().then(fn).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('valid PayFast ITN is server-verified and posts payment, invoice and journal once', async () => withEnv(async () => {
  const workspaces = { u1: { version: 1, data: { invoices: [{ id: 'invoice-1', number: 'INV-1', total: 100, amountPaid: 0, amountDue: 100, status: 'unpaid', clientId: 'c1' }] } } }
  const h = makeHarness(workspaces)
  const previousFetch = global.fetch
  let validationUrl = ''
  global.fetch = async (url, options) => {
    validationUrl = url
    assert.equal(options.method, 'POST')
    assert.ok(String(options.body).includes('pf_payment_id=PF-1001'))
    assert.ok(!String(options.body).includes('signature='))
    return { text: async () => 'VALID' }
  }
  try {
    const res = await h.invoke(signedBody())
    assert.equal(res.code, 200)
    assert.equal(workspaces.u1.data.invoices[0].status, 'paid')
    assert.equal(workspaces.u1.data.invoices[0].amountPaid, 100)
    assert.equal(workspaces.u1.data.payments.length, 1)
    assert.equal(workspaces.u1.data.journal.length, 1)
    assert.equal(validationUrl, 'https://sandbox.payfast.co.za/eng/query/validate')
    assert.equal(h.persisted(), 1)
  } finally { global.fetch = previousFetch }
}))

test('repeated valid ITN with same PayFast payment id is idempotent', async () => withEnv(async () => {
  const workspaces = { u1: { version: 1, data: { invoices: [{ id: 'invoice-1', total: 100, amountPaid: 0, amountDue: 100, status: 'unpaid' }] } } }
  const h = makeHarness(workspaces)
  const previousFetch = global.fetch
  global.fetch = async () => ({ text: async () => 'VALID' })
  try {
    await h.invoke(signedBody())
    await h.invoke(signedBody())
    assert.equal(workspaces.u1.data.payments.length, 1)
    assert.equal(workspaces.u1.data.journal.length, 1)
    assert.equal(h.persisted(), 1)
  } finally { global.fetch = previousFetch }
}))

test('invalid signature is rejected before contacting PayFast or writing data', async () => withEnv(async () => {
  const workspaces = { u1: { data: { invoices: [{ id: 'invoice-1', total: 100, amountDue: 100, status: 'unpaid' }] } } }
  const h = makeHarness(workspaces)
  const previousFetch = global.fetch
  let called = false
  global.fetch = async () => { called = true; return { text: async () => 'VALID' } }
  try {
    const body = signedBody()
    body.signature = '0'.repeat(32)
    const res = await h.invoke(body)
    assert.equal(res.code, 400)
    assert.equal(called, false)
    assert.equal(h.persisted(), 0)
    assert.equal(workspaces.u1.data.invoices[0].status, 'unpaid')
  } finally { global.fetch = previousFetch }
}))

test('verified payment above remaining balance is rejected without posting', async () => withEnv(async () => {
  const workspaces = { u1: { data: { invoices: [{ id: 'invoice-1', total: 100, amountPaid: 50, amountDue: 50, status: 'partial' }], payments: [{ id: 'p1', invoiceId: 'invoice-1', amount: 50 }] } } }
  const h = makeHarness(workspaces)
  const previousFetch = global.fetch
  global.fetch = async () => ({ text: async () => 'VALID' })
  try {
    const res = await h.invoke(signedBody({ amount_gross: '75.00' }))
    assert.equal(res.code, 409)
    assert.equal(workspaces.u1.data.payments.length, 1)
    assert.equal(workspaces.u1.data.invoices[0].amountPaid, 50)
    assert.equal(h.persisted(), 0)
  } finally { global.fetch = previousFetch }
}))
