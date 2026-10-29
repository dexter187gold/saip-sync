/**
 * Self-contained mountAdmin — no external admin-seed dependency.
 */
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const path = require('path')
const fs = require('fs')

function mountAdmin(app, ctx) {
  const {
    users,
    workspaces,
    persistUsers,
    persistWorkspaces,
    auth,
    JWT_SECRET,
    PUBLIC_BASE,
    now,
    git,
    gitMeta,
  } = ctx

  function adminAuth(req, res, next) {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) return res.status(401).json({ error: 'Missing token' })
    try {
      const payload = jwt.verify(token, JWT_SECRET)
      const user = Object.values(users).find((u) => u.id === payload.id || u.email === payload.email)
      if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
      req.user = user
      next()
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }
  }

  app.get('/admin', (_req, res) => {
    try {
      res.type('html').send(fs.readFileSync(path.join(__dirname, 'admin-portal.html'), 'utf8'))
    } catch (e) {
      res.status(404).type('text').send('Admin portal missing')
    }
  })
  app.get('/admin/', (_req, res) => res.redirect(302, '/admin'))

  app.get('/api/admin/me', adminAuth, (req, res) => {
    res.json({ ok: true, user: { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role } })
  })

  app.get('/api/admin/stats', adminAuth, (req, res) => {
    let invoices = 0, tickets = 0, clients = 0
    for (const row of Object.values(workspaces)) {
      const d = row?.data || {}
      invoices += (d.invoices || []).length
      tickets += (d.tickets || []).length
      clients += (d.clients || []).length
    }
    res.json({
      ok: true,
      stats: {
        users: Object.keys(users).length,
        workspaces: Object.keys(workspaces).length,
        invoices,
        tickets,
        clients,
        devices: Object.keys(global.__saip_devices || {}).length,
        portals: Object.keys(global.__saip_portals || {}).length,
        branch_workspaces: Object.keys(workspaces).filter((k) => String(k).includes('::')).length,
      },
    })
  })

  app.get('/api/admin/users', adminAuth, (req, res) => {
    const list = Object.values(users).map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      created_at: u.created_at,
      has_workspace: !!workspaces[u.id],
      google: !!u.google_id,
    }))
    res.json({ ok: true, users: list })
  })

  app.post('/api/admin/users/:id/reset-password', adminAuth, (req, res) => {
    const user = Object.values(users).find((u) => u.id === req.params.id)
    if (!user) return res.status(404).json({ error: 'Not found' })
    const pw = String(req.body?.password || '')
    if (pw.length < 12) return res.status(400).json({ error: 'Provide a new password of at least 12 characters' })
    user.password_hash = bcrypt.hashSync(pw, 12)
    user.updated_at = typeof now === 'function' ? now() : new Date().toISOString()
    persistUsers()
    res.json({ ok: true, message: 'Password reset. Share the new password through a trusted channel; it is not returned by the server.' })
  })

  app.patch('/api/admin/users/:id', adminAuth, (req, res) => {
    const user = Object.values(users).find((u) => u.id === req.params.id)
    if (!user) return res.status(404).json({ error: 'Not found' })
    if (req.body?.role != null) {
      const role = String(req.body.role).trim().toLowerCase()
      if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid system role' })
      if (user.id === req.user.id && role !== 'admin') return res.status(400).json({ error: 'You cannot remove your own admin access here' })
      user.role = role
    }
    if (req.body?.name != null) user.name = String(req.body.name).slice(0, 120)
    user.updated_at = typeof now === 'function' ? now() : new Date().toISOString()
    persistUsers()
    res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role } })
  })

  app.delete('/api/admin/users/:id', adminAuth, (req, res) => {
    const user = Object.values(users).find((u) => u.id === req.params.id)
    if (!user) return res.status(404).json({ error: 'Not found' })
    if (user.role === 'admin') return res.status(400).json({ error: 'Cannot delete admin' })
    delete users[user.email]
    delete workspaces[user.id]
    persistUsers()
    persistWorkspaces()
    res.json({ ok: true })
  })

  app.get('/api/admin/tickets', adminAuth, (req, res) => {
    const out = []
    for (const [uid, row] of Object.entries(workspaces)) {
      if (String(uid).includes('::')) continue
      const owner = Object.values(users).find((u) => u.id === uid)
      for (const t of row?.data?.tickets || []) {
        out.push({ ...t, owner_email: owner?.email || uid })
      }
    }
    res.json({ ok: true, tickets: out.slice(0, 500) })
  })

  app.get('/api/admin/invoices', adminAuth, (req, res) => {
    const out = []
    for (const [uid, row] of Object.entries(workspaces)) {
      if (String(uid).includes('::')) continue
      const owner = Object.values(users).find((u) => u.id === uid)
      for (const i of row?.data?.invoices || []) {
        out.push({
          ...i,
          owner_email: owner?.email || uid,
          client_name: (row.data.clients || []).find((c) => String(c.id) === String(i.clientId))?.name,
          balance_due: i.amountDue ?? i.total,
        })
      }
    }
    res.json({ ok: true, invoices: out.slice(0, 500) })
  })

  app.get('/api/admin/clients', adminAuth, (req, res) => {
    const out = []
    for (const [uid, row] of Object.entries(workspaces)) {
      if (String(uid).includes('::')) continue
      const owner = Object.values(users).find((u) => u.id === uid)
      for (const c of row?.data?.clients || []) {
        out.push({ ...c, owner_email: owner?.email || uid })
      }
    }
    res.json({ ok: true, clients: out.slice(0, 500) })
  })

  app.get('/api/admin/wa-clients', adminAuth, (_req, res) => res.json({ ok: true, clients: [] }))
  app.get('/api/admin/outbox', adminAuth, (_req, res) => res.json({ ok: true, items: [] }))
  app.get('/api/admin/config', adminAuth, (_req, res) => res.json({ ok: true, config: {} }))
  app.put('/api/admin/config', adminAuth, (req, res) => res.json({ ok: true }))

  app.get('/api/admin/devices', adminAuth, (req, res) => {
    const devices = global.__saip_devices || {}
    const list = Object.values(devices).map((d) => {
      const owner = Object.values(users).find((u) => u.id === d.userId)
      return { ...d, owner_email: owner?.email || d.userId }
    })
    res.json({ ok: true, devices: list, count: list.length })
  })

  app.get('/api/admin/portals', adminAuth, (req, res) => {
    const portals = global.__saip_portals || {}
    const list = Object.entries(portals).map(([token, v]) => {
      const owner = Object.values(users).find((u) => u.id === v.userId)
      return {
        token: token.slice(0, 8) + '…',
        clientId: v.clientId,
        expires: v.expires,
        createdAt: v.createdAt,
        owner_email: owner?.email || v.userId,
        url: (PUBLIC_BASE || '').replace(/\/$/, '') + '/p/' + token,
      }
    })
    res.json({ ok: true, portals: list, count: list.length })
  })

  app.get('/api/admin/branches', adminAuth, (req, res) => {
    const keys = Object.keys(workspaces).filter((k) => String(k).includes('::'))
    const rows = keys.map((k) => {
      const [uid, branchId] = String(k).split('::')
      const owner = Object.values(users).find((u) => u.id === uid)
      const row = workspaces[k]
      return {
        key: k,
        branchId,
        owner_email: owner?.email || uid,
        version: row?.version || 0,
        updated_at: row?.updated_at,
      }
    })
    res.json({ ok: true, branches: rows, count: rows.length })
  })

  app.post('/api/admin/git-flush', adminAuth, async (req, res) => {
    if (!git?.flushPush) return res.json({ ok: false, error: 'Git not configured' })
    try {
      const r = await git.flushPush('admin')
      res.json({ ok: !!r?.ok, result: r, meta: gitMeta })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  console.log('[admin] multi-tenant admin API mounted')
}

module.exports = { mountAdmin }
