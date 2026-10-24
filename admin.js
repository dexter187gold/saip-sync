/**
 * SA Invoice Pro Sync — Admin console API (v6.0.0)
 * Self-contained mountAdmin — aggregates real workspace data.
 */
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

function mountAdmin(app, ctx) {
  const {
    users,
    persistUsers,
    workspaces,
    persistWorkspaces,
    auth,
    now,
    JWT_SECRET,
    ADMIN_EMAIL,
    loadJson,
    saveJson,
    DATA_DIR,
    git,
    gitMeta,
  } = ctx

  const DEFAULT_EMAIL = 'admin@sainvoice.pro'
  const adminEmail = String(ADMIN_EMAIL || process.env.ADMIN_EMAIL || DEFAULT_EMAIL || '').toLowerCase().trim()

  function isAdminUser(user) {
    if (!user) return false
    if (adminEmail && String(user.email || '').toLowerCase() === adminEmail) return true
    if (String(user.email || '').toLowerCase() === DEFAULT_EMAIL) return true
    if (user.role === 'admin') return true
    return false
  }

  function adminAuth(req, res, next) {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) return res.status(401).json({ error: 'Missing token' })
    try {
      const payload = jwt.verify(token, JWT_SECRET)
      const user = Object.values(users).find((u) => u.id === payload.id)
      if (!user || !isAdminUser(user)) {
        return res.status(403).json({ error: 'Admin access required' })
      }
      req.user = payload
      req.adminUser = user
      next()
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }
  }

  function emailByUserId() {
    const map = {}
    for (const u of Object.values(users || {})) map[u.id] = u.email
    return map
  }

  app.get('/api/admin/me', adminAuth, (req, res) => {
    res.json({
      ok: true,
      admin: {
        id: req.adminUser.id,
        email: req.adminUser.email,
        name: req.adminUser.name,
      },
    })
  })

  app.get('/api/admin/stats', adminAuth, (req, res) => {
    let invCount = 0, clientCount = 0, ticketCount = 0, openAr = 0
    for (const w of Object.values(workspaces || {})) {
      const d = w?.data || {}
      if (Array.isArray(d.invoices)) {
        invCount += d.invoices.length
        for (const i of d.invoices) {
          if (['unpaid', 'partial', 'overdue'].includes(String(i.status || 'unpaid'))) {
            openAr += Number(i.amountDue ?? i.balance_due ?? i.total) || 0
          }
        }
      }
      if (Array.isArray(d.clients)) clientCount += d.clients.length
      if (Array.isArray(d.tickets)) ticketCount += d.tickets.length
    }
    res.json({
      ok: true,
      stats: {
        users: Object.keys(users || {}).length,
        workspaces: Object.keys(workspaces || {}).length,
        invoices: invCount,
        clients: clientCount,
        tickets: ticketCount,
        outstanding_ar: openAr,
      },
      generated_at: typeof now === 'function' ? now() : new Date().toISOString(),
    })
  })

  app.get('/api/admin/users', adminAuth, (req, res) => {
    const list = Object.values(users).map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name || null,
      role: isAdminUser(u) ? 'admin' : u.role || 'user',
      created_at: u.created_at,
      updated_at: u.updated_at,
      has_workspace: !!(workspaces && workspaces[u.id]),
      workspace_version: workspaces?.[u.id]?.version || 0,
    }))
    list.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    res.json({ ok: true, count: list.length, users: list })
  })

  app.post('/api/admin/users/:id/reset-password', adminAuth, (req, res) => {
    const user = Object.values(users).find((u) => u.id === req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found' })
    let password = (req.body && req.body.password) || ''
    if (!password || password.length < 6) password = crypto.randomBytes(4).toString('hex') + 'A1'
    user.password_hash = bcrypt.hashSync(password, 10)
    user.updated_at = typeof now === 'function' ? now() : new Date().toISOString()
    persistUsers()
    res.json({ ok: true, message: 'Password reset', email: user.email, temporary_password: password })
  })

  app.delete('/api/admin/users/:id', adminAuth, (req, res) => {
    const user = Object.values(users).find((u) => u.id === req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (user.id === req.adminUser.id) return res.status(400).json({ error: 'Cannot delete your own admin account' })
    const key = Object.keys(users).find((k) => users[k].id === user.id)
    if (key) delete users[key]
    if (workspaces && workspaces[user.id]) delete workspaces[user.id]
    persistUsers()
    if (persistWorkspaces) persistWorkspaces()
    res.json({ ok: true, deleted: user.email })
  })

  app.patch('/api/admin/users/:id', adminAuth, (req, res) => {
    const user = Object.values(users).find((u) => u.id === req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found' })
    const b = req.body || {}
    if (b.name != null) user.name = String(b.name).trim() || null
    if (b.role === 'admin' || b.role === 'user') user.role = b.role
    user.updated_at = typeof now === 'function' ? now() : new Date().toISOString()
    persistUsers()
    res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
  })

  app.get('/api/admin/invoices', adminAuth, (req, res) => {
    const rows = []
    const emails = emailByUserId()
    for (const [uid, w] of Object.entries(workspaces || {})) {
      const invs = w?.data?.invoices
      if (!Array.isArray(invs)) continue
      for (const i of invs) {
        rows.push({
          number: i.number || i.invoice_number,
          client_name: i.clientName || i.client_name,
          total: i.total,
          balance_due: i.amountDue ?? i.balance_due ?? i.total,
          status: i.status,
          owner_email: emails[uid] || null,
        })
      }
    }
    res.json({ ok: true, invoices: rows.slice(0, 500) })
  })

  app.get('/api/admin/tickets', adminAuth, (req, res) => {
    const rows = []
    const emails = emailByUserId()
    for (const [uid, w] of Object.entries(workspaces || {})) {
      const tickets = w?.data?.tickets
      if (!Array.isArray(tickets)) continue
      for (const t of tickets) {
        rows.push({
          ...t,
          customer_name: t.customer_name || t.clientName || t.title,
          issue: t.issue || t.summary || t.description,
          owner_email: emails[uid] || null,
        })
      }
    }
    res.json({ ok: true, tickets: rows.slice(0, 500) })
  })

  app.get('/api/admin/clients', adminAuth, (req, res) => {
    const rows = []
    const emails = emailByUserId()
    for (const [uid, w] of Object.entries(workspaces || {})) {
      const clients = w?.data?.clients
      if (!Array.isArray(clients)) continue
      for (const c of clients) {
        rows.push({
          id: c.id,
          name: c.name,
          email: c.email,
          phone: c.phone,
          company: c.company,
          owner_email: emails[uid] || null,
        })
      }
    }
    res.json({ ok: true, clients: rows.slice(0, 500) })
  })

  app.get('/api/admin/wa-clients', adminAuth, (_req, res) => res.json({ ok: true, count: 0, clients: [] }))
  app.get('/api/admin/outbox', adminAuth, (_req, res) => res.json({ ok: true, pending: 0, messages: [] }))
  app.post('/api/admin/outbox/queue', adminAuth, (_req, res) => res.json({ ok: true }))

  const CONFIG_FILE = path.join(DATA_DIR || path.join(__dirname, 'data'), 'app_config.json')
  app.get('/api/admin/config', adminAuth, (_req, res) => {
    const cfg = loadJson ? loadJson(CONFIG_FILE, { public: {} }) : { public: {} }
    res.json({ ok: true, public: cfg.public || {} })
  })
  app.put('/api/admin/config', adminAuth, (req, res) => {
    const cfg = loadJson ? loadJson(CONFIG_FILE, { public: {} }) : { public: {} }
    if (req.body?.public && typeof req.body.public === 'object') cfg.public = req.body.public
    if (saveJson) saveJson(CONFIG_FILE, cfg)
    res.json({ ok: true, public: cfg.public })
  })
  app.put('/api/admin/config/secrets', adminAuth, (req, res) => {
    const cfg = loadJson ? loadJson(CONFIG_FILE, { public: {}, secrets: {} }) : { public: {}, secrets: {} }
    if (!cfg.secrets) cfg.secrets = {}
    if (req.body?.status_api_token) cfg.secrets.status_api_token = String(req.body.status_api_token)
    if (saveJson) saveJson(CONFIG_FILE, cfg)
    res.json({ ok: true })
  })

  app.get('/api/admin/lookup', adminAuth, (req, res) => {
    const phone = String(req.query.phone || '').replace(/\D/g, '')
    const emails = emailByUserId()
    const hits = { clients: [], invoices: [], tickets: [] }
    for (const [uid, w] of Object.entries(workspaces || {})) {
      const d = w?.data || {}
      for (const c of d.clients || []) {
        if (String(c.phone || '').replace(/\D/g, '').includes(phone)) {
          hits.clients.push({ ...c, owner_email: emails[uid] })
        }
      }
    }
    res.json({ ok: true, phone, ...hits })
  })

  app.post('/api/admin/git-flush', adminAuth, (req, res) => {
    if (!git || typeof git.flushPush !== 'function') {
      return res.json({ ok: false, error: 'Git not configured' })
    }
    git.flushPush('admin-manual').then((r) => res.json({ ok: !!r?.ok, result: r, meta: gitMeta || {} })).catch((e) => {
      res.status(500).json({ error: e.message })
    })
  })

  app.get('/admin', (_req, res) => {
    try {
      res.type('html').send(fs.readFileSync(path.join(__dirname, 'admin-portal.html'), 'utf8'))
    } catch (e) {
      res.status(404).type('text').send('Admin portal HTML missing')
    }
  })

  console.log('[admin] portal v6.0.0 mounted')
}

module.exports = { mountAdmin }
