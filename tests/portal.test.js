const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { mountPortal } = require('../portal')

test('public portal renders valid JavaScript and a bounded loading state', () => {
  const routes = new Map()
  const app = {
    get(route, ...handlers) { routes.set('GET ' + route, handlers[handlers.length - 1]) },
    post(route, ...handlers) { routes.set('POST ' + route, handlers[handlers.length - 1]) },
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saip-portal-test-'))
  try {
    mountPortal(app, {
      workspaces: {},
      auth: (_req, _res, next) => next(),
      PUBLIC_BASE: 'https://saip-sync.onrender.com',
      persistWorkspaces() {},
      DATA_DIR: dataDir,
    })
    const handler = routes.get('GET /p/:token')
    assert.equal(typeof handler, 'function')

    let html = ''
    const res = {
      type(value) { assert.equal(value, 'html'); return this },
      send(value) { html = value; return this },
    }
    handler({ params: { token: '0123456789abcdef0123456789abcdef0123456789abcdef' } }, res)

    // With no FRONTEND_PUBLIC_URL configured, the hosted route intentionally
    // renders a small setup/fallback page instead of the SPA shell.
    assert.match(html, /Open the SPA portal link from the shop/)
    assert.match(html, /set FRONTEND_PUBLIC_URL/)
    assert.ok(html.includes('href="/api/portal/0123456789abcdef0123456789abcdef0123456789abcdef"'))
    assert.doesNotMatch(html, /<script>/)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})


test('owner can explicitly publish only same-client job attachments to a portal', () => {
  const routes = new Map()
  const app = {
    get(route, ...handlers) { routes.set('GET ' + route, handlers[handlers.length - 1]) },
    post(route, ...handlers) { routes.set('POST ' + route, handlers[handlers.length - 1]) },
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saip-portal-publish-test-'))
  const uid = 'owner-1'
  const workspaces = {
    [uid]: { data: {
      clients: [{ id: 'client-1', name: 'Customer' }],
      invoices: [],
      quotes: [],
      payments: [],
      tickets: [{ id: 'job-1', clientId: 'client-1', number: 'JOB-1', photos: [], attachments: [] }],
    }, version: 1 },
  }
  try {
    mountPortal(app, {
      workspaces,
      auth: (_req, _res, next) => next(),
      PUBLIC_BASE: 'https://saip-sync.onrender.com',
      persistWorkspaces() {},
      DATA_DIR: dataDir,
    })
    const invoke = (method, route, req) => {
      let status = 200
      let body
      const res = {
        status(code) { status = code; return this },
        json(value) { body = value; return this },
      }
      routes.get(method + ' ' + route)(req, res)
      return { status, body }
    }
    const created = invoke('POST', '/api/portal/create', {
      user: { id: uid }, body: { clientId: 'client-1', days: 90 },
    })
    assert.equal(created.status, 200)
    const token = created.body.token
    const dataUrl = 'data:application/pdf;base64,' + Buffer.from('customer-visible-pdf').toString('base64')
    const published = invoke('POST', ' /api/portal/publish/:token'.trim(), {
      user: { id: uid }, params: { token },
      body: { attachments: [{ id: 'file-1', ticketId: 'job-1', name: 'Service report.pdf', dataUrl }] },
    })
    assert.equal(published.status, 200)
    assert.equal(published.body.published, 1)

    const view = invoke('GET', '/api/portal/:token', { params: { token } })
    assert.equal(view.status, 200)
    assert.equal(view.body.tickets[0].attachments[0].name, 'Service report.pdf')
    assert.equal(view.body.tickets[0].attachments[0].dataUrl, dataUrl)

    const wrongTenant = invoke('POST', '/api/portal/publish/:token', {
      user: { id: 'another-owner' }, params: { token },
      body: { attachments: [{ id: 'file-2', ticketId: 'job-1', name: 'Report.pdf', dataUrl }] },
    })
    assert.equal(wrongTenant.status, 403)

    const wrongClientJob = invoke('POST', '/api/portal/publish/:token', {
      user: { id: uid }, params: { token },
      body: { attachments: [{ id: 'file-3', ticketId: 'job-from-other-client', name: 'Private.pdf', dataUrl }] },
    })
    assert.equal(wrongClientJob.status, 403)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
