/**
 * Self-contained mountAdmin — multi-tenant admin API + portal.
 */
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

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
    strongPassword,
    safeEmail,
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

  function uuid() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    return crypto.randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
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
      updated_at: u.updated_at,
      has_workspace: !!workspaces[u.id],
      google: !!u.google_id,
      linkedWorkspaceOwnerId: u.linkedWorkspaceOwnerId || null,
      teamRole: u.teamRole || null,
    }))
    res.json({ ok: true, users: list })
  })

  /** Create a new cloud user (admin-only). Optional workspace shell. */
  app.post('/api/admin/users', adminAuth, (req, res) => {
    const email = typeof safeEmail === 'function' ? safeEmail(req.body?.email) : String(req.body?.email || '').toLowerCase().trim()
    if (!email) return res.status(400).json({ error: 'Valid email required' })
    if (users[email]) return res.status(409).json({ error: 'Email already registered', code: 'email_exists' })

    const password = String(req.body?.password || '')
    const pwCheck = typeof strongPassword === 'function'
      ? strongPassword(password)
      : { ok: password.length >= 8, error: 'Password must be at least 8 characters' }
    if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.error || 'Weak password' })

    const role = String(req.body?.role || 'user').trim().toLowerCase()
    if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid system role' })

    const name = String(req.body?.name || '').trim().slice(0, 120) || null
    const id = uuid()
    const ts = typeof now === 'function' ? now() : new Date().toISOString()
    users[email] = {
      id,
      email,
      password_hash: bcrypt.hashSync(password, 12),
      name,
      role,
      created_at: ts,
      updated_at: ts,
    }
    const createWorkspace = req.body?.createWorkspace !== false
    if (createWorkspace) {
      workspaces[id] = {
        data: { clients: [], invoices: [], tickets: [], settings: {} },
        version: 1,
        updated_at: ts,
      }
      persistWorkspaces()
    }
    persistUsers()

    try {
      const DATA_DIR = ctx.DATA_DIR || path.join(__dirname, 'data')
      const auditFile = path.join(DATA_DIR, 'admin_audit.json')
      let events = []
      try { if (fs.existsSync(auditFile)) events = JSON.parse(fs.readFileSync(auditFile, 'utf8')) } catch {}
      events.push({
        action: 'admin.user_created',
        actorId: req.user.id,
        actorEmail: req.user.email,
        targetId: id,
        targetEmail: email,
        role,
        at: ts,
      })
      fs.mkdirSync(path.dirname(auditFile), { recursive: true })
      const tmp = auditFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(events.slice(-2000), null, 2), 'utf8')
      fs.renameSync(tmp, auditFile)
    } catch (e) {
      console.warn('[admin] audit write failed', e.message)
    }

    res.status(201).json({
      ok: true,
      user: { id, email, name, role, has_workspace: !!workspaces[id] },
      message: 'User created. Share the password through a trusted channel; it is not returned.',
    })
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
    res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role, name: user.name } })
  })

  app.delete('/api/admin/users/:id', adminAuth, (req, res) => {
    const user = Object.values(users).find((u) => u.id === req.params.id)
    if (!user) return res.status(404).json({ error: 'Not found' })
    if (user.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own admin account' })
    if (user.role === 'admin') return res.status(400).json({ error: 'Cannot delete another admin — demote to user first' })
    const emailKey = user.email
    delete users[emailKey]
    for (const k of Object.keys(users)) {
      if (users[k] && users[k].id === user.id) delete users[k]
    }
    if (workspaces[user.id]) delete workspaces[user.id]
    for (const k of Object.keys(workspaces)) {
      if (String(k).startsWith(user.id + '::')) delete workspaces[k]
    }
    persistUsers()
    persistWorkspaces()
    res.json({ ok: true, message: 'User and workspace removed' })
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

  console.log('[admin] multi-tenant admin API mounted (create/delete/patch users)')
}

module.exports = { mountAdmin }
