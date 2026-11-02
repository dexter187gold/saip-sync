/**
 * Developer operations API: release orchestration and durable user broadcasts.
 * Developer JWTs have their own audience and cannot be used as admin sessions.
 */
const fs = require('fs')
const path = require('path')
const jwt = require('jsonwebtoken')

function mountDevops(app, ctx) {
  const { DATA_DIR, JWT_SECRET, users, now = () => new Date().toISOString() } = ctx
  const file = path.join(DATA_DIR || path.join(__dirname, 'data'), 'announcements.json')
  let announcements = []
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      announcements = Array.isArray(parsed) ? parsed : []
    }
  } catch (e) { console.warn('[devops] announcement store could not be read:', e.message) }
  global.__saip_announcements = announcements

  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(announcements.slice(0, 500), null, 2), 'utf8')
      fs.renameSync(tmp, file)
      global.__saip_announcements = announcements
      return true
    } catch (e) {
      console.error('[devops] announcement persistence failed:', e.message)
      return false
    }
  }

  function developerAuth(req, res, next) {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token) return res.status(401).json({ error: 'Developer session required' })
    try {
      const payload = jwt.verify(token, JWT_SECRET, { issuer: 'saip-sync', audience: 'saip-developer-portal' })
      if (payload.developer_portal !== true || payload.role !== 'developer' || payload.email !== 'sainvoicepro@gmail.com') {
        return res.status(403).json({ error: 'Developer access required' })
      }
      req.developer = { email: payload.email, role: 'developer' }
      next()
    } catch {
      return res.status(401).json({ error: 'Developer session expired or invalid' })
    }
  }

  const active = (a) => a.active !== false && (!a.expiresAt || new Date(a.expiresAt).getTime() > Date.now())
  const githubHeaders = () => ({
    Authorization: 'Bearer ' + process.env.SAIP_GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  })

  app.get('/api/dev/overview', developerAuth, async (_req, res) => {
    let release = { configured: false, latest: null, workflow: null }
    if (process.env.SAIP_GITHUB_TOKEN) {
      release.configured = true
      try {
        const [releasesRes, runsRes] = await Promise.all([
          fetch('https://api.github.com/repos/dexter187gold/sa-invoice-pro/releases?per_page=5', { headers: githubHeaders() }),
          fetch('https://api.github.com/repos/dexter187gold/sa-invoice-pro/actions/workflows/release.yml/runs?per_page=1', { headers: githubHeaders() }),
        ])
        const releases = releasesRes.ok ? await releasesRes.json() : []
        const runs = runsRes.ok ? await runsRes.json() : { workflow_runs: [] }
        release.latest = Array.isArray(releases) ? releases[0] || null : null
        release.workflow = runs.workflow_runs?.[0] || null
      } catch (e) { release.error = 'GitHub release status unavailable' }
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      ok: true,
      overview: {
        users: Object.keys(users || {}).length,
        announcements: announcements.filter(active).length,
        totalAnnouncements: announcements.length,
        release,
        githubConfigured: !!process.env.SAIP_GITHUB_TOKEN,
        services: [
          { name: 'Sync API', url: 'https://saip-sync.onrender.com/health' },
          { name: 'Production app', url: 'https://sa-invoice-pro.pcrepairdex.workers.dev' },
          { name: 'Licence server', url: 'https://saip-license.onrender.com' },
        ],
        generatedAt: now(),
      },
    })
  })

  app.get('/api/dev/announcements', developerAuth, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ok: true, announcements })
  })

  app.post('/api/dev/announcements', developerAuth, (req, res) => {
    const title = String(req.body?.title || '').trim().slice(0, 120)
    const body = String(req.body?.body || '').trim().slice(0, 3000)
    const severity = String(req.body?.severity || 'info').toLowerCase()
    const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt).toISOString() : null
    if (title.length < 3 || body.length < 5) return res.status(400).json({ error: 'A title and message are required' })
    if (!['info', 'success', 'warning', 'critical'].includes(severity)) return res.status(400).json({ error: 'Invalid alert severity' })
    if (req.body?.expiresAt && (!expiresAt || new Date(expiresAt).getTime() <= Date.now())) return res.status(400).json({ error: 'Expiry must be in the future' })
    const item = {
      id: require('crypto').randomUUID(),
      title,
      body,
      severity,
      active: true,
      audience: 'all',
      createdAt: now(),
      createdBy: req.developer.email,
      expiresAt,
      readBy: [],
    }
    announcements.unshift(item)
    if (!persist()) {
      announcements.shift()
      return res.status(500).json({ error: 'Could not save broadcast. No alert was sent.' })
    }
    res.status(201).json({ ok: true, announcement: item, deliveredTo: Object.keys(users || {}).length, delivery: 'in_app_broadcast' })
  })

  app.patch('/api/dev/announcements/:id', developerAuth, (req, res) => {
    const item = announcements.find((a) => a.id === req.params.id)
    if (!item) return res.status(404).json({ error: 'Announcement not found' })
    if (req.body?.active != null) item.active = !!req.body.active
    if (req.body?.title != null) item.title = String(req.body.title).trim().slice(0, 120)
    if (req.body?.body != null) item.body = String(req.body.body).trim().slice(0, 3000)
    item.updatedAt = now()
    if (!persist()) return res.status(500).json({ error: 'Could not save announcement change' })
    res.json({ ok: true, announcement: item })
  })

  app.delete('/api/dev/announcements/:id', developerAuth, (req, res) => {
    const index = announcements.findIndex((a) => a.id === req.params.id)
    if (index < 0) return res.status(404).json({ error: 'Announcement not found' })
    const [removed] = announcements.splice(index, 1)
    if (!persist()) {
      announcements.splice(index, 0, removed)
      return res.status(500).json({ error: 'Could not remove announcement' })
    }
    res.json({ ok: true })
  })

  app.post('/api/dev/releases/dispatch', developerAuth, async (req, res) => {
    const token = process.env.SAIP_GITHUB_TOKEN
    if (!token) return res.status(503).json({ error: 'Release controls are not configured yet. Add SAIP_GITHUB_TOKEN to Render saip-sync environment.' })
    const ref = String(req.body?.ref || 'main')
    if (!['main', 'beta'].includes(ref)) return res.status(400).json({ error: 'Only main and beta release channels are allowed' })
    const response = await fetch('https://api.github.com/repos/dexter187gold/sa-invoice-pro/actions/workflows/release.yml/dispatches', {
      method: 'POST',
      headers: githubHeaders(),
      body: JSON.stringify({ ref }),
    })
    if (!response.ok) {
      const detail = await response.text()
      return res.status(502).json({ error: 'GitHub rejected the release request', detail: detail.slice(0, 500) })
    }
    res.status(202).json({ ok: true, message: 'Release workflow dispatched', ref, requestedAt: now() })
  })

  app.get('/api/dev/releases', developerAuth, async (_req, res) => {
    const token = process.env.SAIP_GITHUB_TOKEN
    if (!token) return res.status(503).json({ error: 'Set SAIP_GITHUB_TOKEN in Render to enable release history' })
    const [releasesRes, runsRes] = await Promise.all([
      fetch('https://api.github.com/repos/dexter187gold/sa-invoice-pro/releases?per_page=10', { headers: githubHeaders() }),
      fetch('https://api.github.com/repos/dexter187gold/sa-invoice-pro/actions/workflows/release.yml/runs?per_page=10', { headers: githubHeaders() }),
    ])
    if (!releasesRes.ok || !runsRes.ok) return res.status(502).json({ error: 'Could not retrieve GitHub release history' })
    const [releases, runs] = await Promise.all([releasesRes.json(), runsRes.json()])
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ok: true, releases, runs: runs.workflow_runs || [] })
  })

  app.get('/api/notifications', ctx.auth, (req, res) => {
    const email = String(req.user?.email || '').toLowerCase()
    const items = announcements.filter(active).map((a) => ({
      id: a.id,
      title: a.title,
      body: a.body,
      severity: a.severity,
      createdAt: a.createdAt,
      read: Array.isArray(a.readBy) && a.readBy.includes(email),
    }))
    res.json({ ok: true, count: items.length, unread: items.filter((n) => !n.read).length, notifications: items })
  })

  app.post('/api/notifications/read', ctx.auth, (req, res) => {
    const email = String(req.user?.email || '').toLowerCase()
    for (const item of announcements) {
      if (!Array.isArray(item.readBy)) item.readBy = []
      if (!item.readBy.includes(email)) item.readBy.push(email)
    }
    persist()
    res.json({ ok: true })
  })
}

module.exports = { mountDevops }
