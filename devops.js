/**
 * Developer operations API: release orchestration and durable user broadcasts.
 * Developer JWTs have their own audience and cannot be used as admin sessions.
 */
const fs = require('fs')
const path = require('path')
const jwt = require('jsonwebtoken')
let webpush = null
try { webpush = require('web-push') } catch { /* disabled until dependency is installed */ }

function mountDevops(app, ctx) {
  const { DATA_DIR, JWT_SECRET, users, git, now = () => new Date().toISOString() } = ctx
  const file = path.join(DATA_DIR || path.join(__dirname, 'data'), 'announcements.json')
  let announcements = []
  let loaded = false
  const subscriptionsFile = path.join(DATA_DIR || path.join(__dirname, 'data'), 'push-subscriptions.json')
  let pushSubscriptions = []
  let subscriptionsLoaded = false
  let pushConfigured = false
  if (webpush && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
    try { webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY); pushConfigured = true }
    catch (e) { console.warn('[devops] Web Push configuration invalid:', e.message) }
  }
  global.__saip_announcements = announcements

  // The server mounts this module before boot() pulls the Git-backed data repo.
  // Load lazily on the first API request so the durable file has already arrived.
  function ensureLoaded() {
    if (loaded) return
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        announcements = Array.isArray(parsed) ? parsed : []
      }
    } catch (e) {
      console.warn('[devops] announcement store could not be read:', e.message)
      announcements = []
    }
    loaded = true
    global.__saip_announcements = announcements
  }

  function persist() {
    ensureLoaded()
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(announcements.slice(0, 500), null, 2), 'utf8')
      fs.renameSync(tmp, file)
      global.__saip_announcements = announcements
      git?.schedulePush?.('announcements')
      return true
    } catch (e) {
      console.error('[devops] announcement persistence failed:', e.message)
      return false
    }
  }

  function ensureSubscriptionsLoaded() {
    if (subscriptionsLoaded) return
    try {
      if (fs.existsSync(subscriptionsFile)) {
        const parsed = JSON.parse(fs.readFileSync(subscriptionsFile, 'utf8'))
        pushSubscriptions = Array.isArray(parsed) ? parsed : []
      }
    } catch (e) {
      console.warn('[devops] push subscription store could not be read:', e.message)
      pushSubscriptions = []
    }
    subscriptionsLoaded = true
  }

  function persistSubscriptions() {
    ensureSubscriptionsLoaded()
    try {
      fs.mkdirSync(path.dirname(subscriptionsFile), { recursive: true })
      const tmp = subscriptionsFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(pushSubscriptions.slice(-10000), null, 2), 'utf8')
      fs.renameSync(tmp, subscriptionsFile)
      git?.schedulePush?.('push-subscriptions')
      return true
    } catch (e) {
      console.error('[devops] push subscription persistence failed:', e.message)
      return false
    }
  }

  async function dispatchPush(announcement) {
    ensureSubscriptionsLoaded()
    if (!pushConfigured) return { configured: false, sent: 0, failed: 0 }
    const payload = JSON.stringify({
      title: announcement.title,
      body: announcement.body,
      severity: announcement.severity,
      url: '/',
      tag: 'saip-' + announcement.id,
    })
    let sent = 0
    let failed = 0
    const expired = new Set()
    for (let i = 0; i < pushSubscriptions.length; i += 50) {
      const batch = pushSubscriptions.slice(i, i + 50)
      await Promise.all(batch.map(async (row) => {
        try {
          await webpush.sendNotification(row.subscription, payload, { TTL: 60 * 60, urgency: announcement.severity === 'critical' ? 'high' : 'normal' })
          sent++
        } catch (e) {
          failed++
          if (e.statusCode === 404 || e.statusCode === 410) expired.add(row.endpoint)
        }
      }))
    }
    if (expired.size) {
      pushSubscriptions = pushSubscriptions.filter((row) => !expired.has(row.endpoint))
      persistSubscriptions()
    }
    return { configured: true, sent, failed, removedExpired: expired.size }
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


  const controlsFile = path.join(DATA_DIR || path.join(__dirname, 'data'), 'ops-controls.json')
  const auditFile = path.join(DATA_DIR || path.join(__dirname, 'data'), 'ops-audit.json')
  const incidentsFile = path.join(DATA_DIR || path.join(__dirname, 'data'), 'ops-incidents.json')
  const defaultControls = {
    maintenance: { enabled: false, message: 'SA Invoice Pro is undergoing scheduled maintenance. Please try again shortly.', updatedAt: null, updatedBy: null },
    flags: { bankImport: true, clientPortal: true, betaFeatures: false, newDashboard: false },
    updatedAt: null,
    updatedBy: null,
  }
  let controls = JSON.parse(JSON.stringify(defaultControls))
  let audit = []
  let incidents = []
  let controlsLoaded = false

  function ensureControlsLoaded() {
    if (controlsLoaded) return
    try {
      if (fs.existsSync(controlsFile)) {
        const parsed = JSON.parse(fs.readFileSync(controlsFile, 'utf8'))
        if (parsed && typeof parsed === 'object') controls = {
          ...defaultControls,
          ...parsed,
          maintenance: { ...defaultControls.maintenance, ...(parsed.maintenance || {}) },
          flags: { ...defaultControls.flags, ...(parsed.flags || {}) },
        }
      }
    } catch (e) { console.warn('[devops] controls store could not be read:', e.message) }
    try {
      if (fs.existsSync(auditFile)) {
        const parsed = JSON.parse(fs.readFileSync(auditFile, 'utf8'))
        audit = Array.isArray(parsed) ? parsed.slice(0, 500) : []
      }
    } catch (e) { console.warn('[devops] audit store could not be read:', e.message) }
    try {
      if (fs.existsSync(incidentsFile)) {
        const parsed = JSON.parse(fs.readFileSync(incidentsFile, 'utf8'))
        incidents = Array.isArray(parsed) ? parsed.slice(0, 300) : []
      }
    } catch (e) { console.warn('[devops] incident store could not be read:', e.message) }
    controlsLoaded = true
  }

  function writeJsonAtomic(target, value) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = target + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, target)
  }

  function persistControls() {
    try {
      writeJsonAtomic(controlsFile, controls)
      git?.schedulePush?.('ops-controls')
      return true
    } catch (e) { console.error('[devops] control persistence failed:', e.message); return false }
  }

  function persistIncidents() {
    try { writeJsonAtomic(incidentsFile, incidents.slice(0, 300)); git?.schedulePush?.('ops-incidents'); return true }
    catch (e) { console.error('[devops] incident persistence failed:', e.message); return false }
  }

  function recordAudit(action, details, actor) {
    ensureControlsLoaded()
    audit.unshift({ id: require('crypto').randomUUID(), action, details, actor: actor || 'unknown', createdAt: now() })
    audit = audit.slice(0, 500)
    try {
      writeJsonAtomic(auditFile, audit)
      git?.schedulePush?.('ops-audit')
      return true
    } catch (e) { console.error('[devops] audit persistence failed:', e.message); return false }
  }

  function publicSystemStatus() {
    ensureControlsLoaded()
    return {
      maintenance: { enabled: controls.maintenance.enabled === true, message: controls.maintenance.message },
      flags: { ...controls.flags },
      updatedAt: controls.updatedAt,
    }
  }

  const active = (a) => a.active !== false && (!a.expiresAt || new Date(a.expiresAt).getTime() > Date.now())
  const githubHeaders = () => ({
    Authorization: 'Bearer ' + process.env.SAIP_GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  })


  app.get('/api/system/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ok: true, status: publicSystemStatus() })
  })

  app.get('/api/dev/controls', developerAuth, (_req, res) => {
    ensureControlsLoaded()
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ok: true, controls, audit: audit.slice(0, 100) })
  })

  app.patch('/api/dev/controls', developerAuth, (req, res) => {
    ensureControlsLoaded()
    const patch = req.body || {}
    const changes = []
    if (patch.maintenance && typeof patch.maintenance === 'object') {
      if (typeof patch.maintenance.enabled === 'boolean' && patch.maintenance.enabled !== controls.maintenance.enabled) {
        controls.maintenance.enabled = patch.maintenance.enabled
        changes.push({ field: 'maintenance.enabled', value: patch.maintenance.enabled })
      }
      if (patch.maintenance.message != null) {
        const message = String(patch.maintenance.message).trim().slice(0, 500)
        if (message.length < 10) return res.status(400).json({ error: 'Maintenance message must be at least 10 characters' })
        if (message !== controls.maintenance.message) {
          controls.maintenance.message = message
          changes.push({ field: 'maintenance.message', value: message })
        }
      }
    }
    if (patch.flags && typeof patch.flags === 'object') {
      const allowed = Object.keys(defaultControls.flags)
      for (const key of allowed) {
        if (typeof patch.flags[key] === 'boolean' && patch.flags[key] !== controls.flags[key]) {
          controls.flags[key] = patch.flags[key]
          changes.push({ field: 'flags.' + key, value: patch.flags[key] })
        }
      }
    }
    if (!changes.length) return res.json({ ok: true, controls, audit: audit.slice(0, 100), unchanged: true })
    controls.updatedAt = now()
    controls.updatedBy = req.developer.email
    if (patch.maintenance && changes.some((c) => c.field.startsWith('maintenance.'))) {
      controls.maintenance.updatedAt = now()
      controls.maintenance.updatedBy = req.developer.email
    }
    if (!persistControls()) return res.status(500).json({ error: 'Could not persist operational controls' })
    recordAudit('controls.updated', { changes }, req.developer.email)
    res.json({ ok: true, controls, audit: audit.slice(0, 100) })
  })

  app.get('/api/dev/incidents', developerAuth, (_req, res) => {
    ensureControlsLoaded()
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ok: true, incidents })
  })

  app.post('/api/dev/incidents', developerAuth, (req, res) => {
    ensureControlsLoaded()
    const title = String(req.body?.title || '').trim().slice(0, 140)
    const summary = String(req.body?.summary || '').trim().slice(0, 2000)
    const severity = String(req.body?.severity || 'medium').toLowerCase()
    if (title.length < 4 || summary.length < 10) return res.status(400).json({ error: 'Incident title and summary are required' })
    if (!['low', 'medium', 'high', 'critical'].includes(severity)) return res.status(400).json({ error: 'Invalid incident severity' })
    const incident = { id: require('crypto').randomUUID(), title, summary, severity, status: 'open', createdAt: now(), updatedAt: now(), createdBy: req.developer.email, resolvedAt: null, resolution: '' }
    incidents.unshift(incident)
    if (!persistIncidents()) { incidents.shift(); return res.status(500).json({ error: 'Could not save incident' }) }
    recordAudit('incident.created', { id: incident.id, title, severity }, req.developer.email)
    res.status(201).json({ ok: true, incident, incidents })
  })

  app.patch('/api/dev/incidents/:id', developerAuth, (req, res) => {
    ensureControlsLoaded()
    const incident = incidents.find((item) => item.id === req.params.id)
    if (!incident) return res.status(404).json({ error: 'Incident not found' })
    const changes = []
    if (req.body?.status != null) {
      const status = String(req.body.status).toLowerCase()
      if (!['open', 'investigating', 'monitoring', 'resolved'].includes(status)) return res.status(400).json({ error: 'Invalid incident status' })
      if (status !== incident.status) { incident.status = status; changes.push({ field: 'status', value: status }) }
      incident.resolvedAt = status === 'resolved' ? now() : null
    }
    if (req.body?.resolution != null) {
      incident.resolution = String(req.body.resolution).trim().slice(0, 2000)
      changes.push({ field: 'resolution', value: incident.resolution })
    }
    incident.updatedAt = now()
    if (!persistIncidents()) return res.status(500).json({ error: 'Could not update incident' })
    if (changes.length) recordAudit('incident.updated', { id: incident.id, changes }, req.developer.email)
    res.json({ ok: true, incident, incidents })
  })

  app.get('/api/dev/audit', developerAuth, (_req, res) => {
    ensureControlsLoaded()
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ok: true, audit: audit.slice(0, 200) })
  })

  app.get('/api/dev/overview', developerAuth, async (_req, res) => {
    ensureLoaded()
    ensureSubscriptionsLoaded()
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
        push: { configured: pushConfigured, subscriptions: pushSubscriptions.length },
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
    ensureLoaded()
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ok: true, announcements })
  })

  app.post('/api/dev/announcements', developerAuth, async (req, res) => {
    ensureLoaded()
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
    const push = await dispatchPush(item)
    res.status(201).json({ ok: true, announcement: item, deliveredTo: Object.keys(users || {}).length, delivery: push.configured ? 'in_app_and_web_push' : 'in_app_only', push })
  })

  app.patch('/api/dev/announcements/:id', developerAuth, (req, res) => {
    ensureLoaded()
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
    ensureLoaded()
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
    const channel = String(req.body?.channel || 'beta').toLowerCase()
    if (!['main', 'beta', 'stable'].includes(channel)) return res.status(400).json({ error: 'Only beta and stable release channels are allowed' })
    const response = await fetch('https://api.github.com/repos/dexter187gold/sa-invoice-pro/actions/workflows/release.yml/dispatches', {
      method: 'POST',
      headers: githubHeaders(),
      body: JSON.stringify({ ref: 'main', inputs: { channel: channel === 'main' ? 'stable' : channel } }),
    })
    if (!response.ok) {
      const detail = await response.text()
      return res.status(502).json({ error: 'GitHub rejected the release request', detail: detail.slice(0, 500) })
    }
    res.status(202).json({ ok: true, message: 'Release workflow dispatched', channel: channel === 'main' ? 'stable' : channel, ref: 'main', requestedAt: now() })
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
    ensureLoaded()
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

  app.get('/api/push/config', ctx.auth, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ok: true, enabled: pushConfigured, publicKey: pushConfigured ? process.env.VAPID_PUBLIC_KEY : null })
  })

  app.post('/api/push/subscribe', ctx.auth, (req, res) => {
    ensureSubscriptionsLoaded()
    if (!pushConfigured) return res.status(503).json({ error: 'Browser push is not configured on the sync server yet' })
    const subscription = req.body?.subscription
    const endpoint = String(subscription?.endpoint || '')
    const p256dh = String(subscription?.keys?.p256dh || '')
    const authKey = String(subscription?.keys?.auth || '')
    if (!endpoint.startsWith('https://') || endpoint.length > 2048 || !p256dh || !authKey) {
      return res.status(400).json({ error: 'A valid browser push subscription is required' })
    }
    const userId = String(req.user?.id || '')
    if (!userId) return res.status(401).json({ error: 'Sign in required' })
    pushSubscriptions = pushSubscriptions.filter((row) => row.endpoint !== endpoint && !(row.userId === userId && row.createdAt && Date.now() - new Date(row.createdAt).getTime() > 365 * 86400000))
    const existingForUser = pushSubscriptions.filter((row) => row.userId === userId)
    if (existingForUser.length >= 10) return res.status(429).json({ error: 'This account has reached its 10-device notification limit' })
    pushSubscriptions.push({ userId, endpoint, subscription: { endpoint, keys: { p256dh, auth: authKey } }, createdAt: now() })
    if (!persistSubscriptions()) return res.status(500).json({ error: 'Could not save this device subscription' })
    res.status(201).json({ ok: true })
  })

  app.delete('/api/push/subscribe', ctx.auth, (req, res) => {
    ensureSubscriptionsLoaded()
    const endpoint = String(req.body?.endpoint || '')
    const before = pushSubscriptions.length
    pushSubscriptions = pushSubscriptions.filter((row) => !(row.userId === req.user?.id && row.endpoint === endpoint))
    if (before !== pushSubscriptions.length) persistSubscriptions()
    res.json({ ok: true, removed: before - pushSubscriptions.length })
  })

  app.post('/api/notifications/read', ctx.auth, (req, res) => {
    ensureLoaded()
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
