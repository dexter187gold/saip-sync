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
    get(route, handler) { routes.set('GET ' + route, handler) },
    post(route, handler) { routes.set('POST ' + route, handler) },
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

    assert.match(html, /We could not load your account/)
    assert.match(html, /AbortController/)
    assert.match(html, /12000/)
    assert.match(html, /Try again/)
    assert.match(html, /function esc\(value\)/)
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    assert.ok(script, 'portal script exists')
    assert.doesNotThrow(() => new vm.Script(script), 'portal JavaScript parses')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
