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

    // With no FRONTEND_PUBLIC_URL configured, the hosted route intentionally
    // renders a small setup/fallback page instead of the SPA shell.
    assert.match(html, /Open the SPA portal link from the shop/)
    assert.match(html, /set FRONTEND_PUBLIC_URL/)
    assert.match(html, /href="\\/api\\/portal\\/0123456789abcdef0123456789abcdef0123456789abcdef"/)
    assert.doesNotMatch(html, /<script>/)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
