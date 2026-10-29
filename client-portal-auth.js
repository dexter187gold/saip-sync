/**
 * Customer client portal — login with shop-issued email + PIN.
 * Shop (desk) issues accounts via Bearer workspace token.
 * Customers use a separate JWT (aud: client_portal).
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')

function mountClientPortal(app, ctx) {
  const {
    DATA_DIR,
    loadJson,
    saveJson,
    workspaces,
    auth,
    now,
    JWT_SECRET,
    loginRateLimit,
    safeEmail,
    git,
  } = ctx

  const ACCOUNTS_FILE = path.join(DATA_DIR, 'client_portal_accounts.json')
  const SESSIONS_FILE = path.join(DATA_DIR, 'client_portal_sessions.json')

  function loadAccounts() {
    return loadJson(ACCOUNTS_FILE, {})
  }
  function saveAccounts(obj) {
    saveJson(ACCOUNTS_FILE, obj)
    if (git && typeof git.schedulePush === 'function') git.schedulePush('client_portal')
  }

  function accountKey(workspaceOwnerId, email) {
    return `${workspaceOwnerId}::${String(email).toLowerCase().trim()}`
  }

  function genPin() {
    return String(crypto.randomInt(100000, 999999))
  }

  function clientToken(payload) {
    return jwt.sign(
      { ...payload, aud: 'client_portal' },
      JWT_SECRET,
      { expiresIn: '30d' },
    )
  }

  function clientAuth(req, res, next) {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) return res.status(401).json({ error: 'Missing token' })
    try {
      const decoded = jwt.verify(token, JWT_SECRET)
      if (decoded.aud !== 'client_portal') {
        return res.status(401).json({ error: 'Not a client portal session' })
      }
      req.clientUser = decoded
      next()
    } catch {
      return res.status(401).json({ error: 'Invalid or expired session' })
    }
  }

  function filterByClient(list, clientId, email) {
    const arr = Array.isArray(list) ? list : []
    const em = String(email || '').toLowerCase().trim()
    return arr.filter((row) => {
      if (!row) return false
      if (clientId && (row.clientId === clientId || row.client_id === clientId)) return true
      const rowEmail = String(row.clientEmail || row.email || '').toLowerCase().trim()
      if (em && rowEmail && rowEmail === em) return true
      return false
    })
  }

  function auditPortal(ownerId, action, email, details = {}) {
    try {
      const file = path.join(DATA_DIR, 'client_portal_audit.json')
      let rows = []
      try { rows = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
      rows.unshift({ at: now(), ownerId, action, email, ...details })
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(rows.slice(0, 1000), null, 2), 'utf8')
      fs.renameSync(tmp, file)
    } catch (err) {
      console.warn('[client-portal] audit write failed', err.message)
    }
  }

  function safeAccountSummary(acc) {
    return {
      email: acc.email,
      name: acc.name,
      clientId: acc.clientId,
      active: acc.active !== false,
      createdAt: acc.createdAt || null,
      updatedAt: acc.updatedAt || null,
      lastLoginAt: acc.lastLoginAt || null,
      counts: {
        invoices: Array.isArray(acc.snapshot?.invoices) ? acc.snapshot.invoices.length : 0,
        quotes: Array.isArray(acc.snapshot?.quotes) ? acc.snapshot.quotes.length : 0,
        tickets: Array.isArray(acc.snapshot?.tickets) ? acc.snapshot.tickets.length : 0,
        payments: Array.isArray(acc.snapshot?.payments) ? acc.snapshot.payments.length : 0,
      },
    }
  }

  // Workspace-owner console: list only this owner's portal accounts and never
  // return PIN hashes, JWTs, or the underlying customer financial snapshots.
  app.get('/api/client-portal/accounts', auth, (req, res) => {
    const ownerId = req.user.id
    const accounts = loadAccounts()
    const rows = Object.values(accounts)
      .filter((acc) => acc.workspaceOwnerId === ownerId)
      .map(safeAccountSummary)
      .sort((a, b) => String(a.email).localeCompare(String(b.email)))
    res.json({ ok: true, accounts: rows })
  })

  app.patch('/api/client-portal/accounts/:email/status', auth, (req, res) => {
    const ownerId = req.user.id
    const email = safeEmail(req.params?.email)
    if (!email) return res.status(400).json({ error: 'Valid client email required' })
    if (typeof req.body?.active !== 'boolean') return res.status(400).json({ error: 'active must be true or false' })
    const accounts = loadAccounts()
    const key = accountKey(ownerId, email)
    const acc = accounts[key]
    if (!acc) return res.status(404).json({ error: 'Portal account not found in this workspace' })
    acc.active = req.body.active
    acc.updatedAt = now()
    accounts[key] = acc
    saveAccounts(accounts)
    auditPortal(ownerId, req.body.active ? 'client_portal.account_enabled' : 'client_portal.account_disabled', email)
    res.json({ ok: true, account: safeAccountSummary(acc) })
  })

  app.post('/api/client-portal/accounts/:email/reset-pin', auth, (req, res) => {
    const ownerId = req.user.id
    const email = safeEmail(req.params?.email)
    if (!email) return res.status(400).json({ error: 'Valid client email required' })
    const accounts = loadAccounts()
    const key = accountKey(ownerId, email)
    const acc = accounts[key]
    if (!acc) return res.status(404).json({ error: 'Portal account not found in this workspace' })
    const pin = genPin()
    acc.pin_hash = bcrypt.hashSync(pin, 10)
    acc.updatedAt = now()
    accounts[key] = acc
    saveAccounts(accounts)
    auditPortal(ownerId, 'client_portal.pin_reset', email)
    // The replacement PIN is returned once so the owner can securely share it.
    res.json({ ok: true, email, pin, message: 'Replacement PIN generated. Share it with the client through a trusted channel.' })
  })

  /** Shop issues / refreshes portal login for one client */
  app.post('/api/client-portal/issue', auth, (req, res) => {
    const body = req.body || {}
    const email = safeEmail(body.email)
    if (!email) return res.status(400).json({ error: 'Valid client email required' })
    const clientId = String(body.clientId || body.id || '').trim()
    if (!clientId) return res.status(400).json({ error: 'clientId required' })

    const ownerId = req.user.id
    const pin = body.pin ? String(body.pin).trim() : genPin()
    if (pin.length < 4 || pin.length > 12) {
      return res.status(400).json({ error: 'PIN must be 4–12 characters' })
    }

    const accounts = loadAccounts()
    const key = accountKey(ownerId, email)
    const prev = accounts[key] || {}
    const ts = now()

    const snapshot = {
      company: body.company || prev.snapshot?.company || {},
      client: body.client || prev.snapshot?.client || { id: clientId, email, name: body.name },
      invoices: Array.isArray(body.invoices) ? body.invoices : prev.snapshot?.invoices || [],
      quotes: Array.isArray(body.quotes) ? body.quotes : prev.snapshot?.quotes || [],
      tickets: Array.isArray(body.tickets) ? body.tickets : prev.snapshot?.tickets || [],
      payments: Array.isArray(body.payments) ? body.payments : prev.snapshot?.payments || [],
      updatedAt: ts,
    }

    // Prefer live workspace data when available
    const ws = workspaces[ownerId]
    if (ws && ws.data) {
      const d = ws.data
      snapshot.invoices = filterByClient(d.invoices, clientId, email)
      snapshot.quotes = filterByClient(d.quotes, clientId, email)
      snapshot.tickets = filterByClient(d.tickets, clientId, email)
      snapshot.payments = filterByClient(d.payments, clientId, email)
      if (Array.isArray(d.clients)) {
        const found = d.clients.find((c) => c.id === clientId || safeEmail(c.email) === email)
        if (found) snapshot.client = found
      }
      if (d.settings || d.company) snapshot.company = d.company || d.settings?.company || snapshot.company
    }

    accounts[key] = {
      workspaceOwnerId: ownerId,
      clientId,
      email,
      name: body.name || snapshot.client?.name || email,
      pin_hash: bcrypt.hashSync(pin, 10),
      active: body.active !== false,
      createdAt: prev.createdAt || ts,
      updatedAt: ts,
      lastLoginAt: prev.lastLoginAt || null,
      snapshot,
    }
    saveAccounts(accounts)

    const portalBase =
      process.env.CLIENT_PORTAL_URL ||
      'https://sa-invoice-pro-client-portal.pages.dev'

    res.json({
      ok: true,
      email,
      pin,
      clientId,
      portalUrl: portalBase,
      loginHint: `Sign in at ${portalBase} with ${email} and PIN ${pin}`,
      message: 'Share email + PIN with the customer. PIN shown once — store it securely.',
    })
  })

  /** Refresh snapshot only (no new PIN) */
  app.post('/api/client-portal/push-snapshot', auth, (req, res) => {
    const body = req.body || {}
    const email = safeEmail(body.email)
    if (!email) return res.status(400).json({ error: 'email required' })
    const ownerId = req.user.id
    const accounts = loadAccounts()
    const key = accountKey(ownerId, email)
    const acc = accounts[key]
    if (!acc) return res.status(404).json({ error: 'No portal account for this email — issue first' })

    const clientId = acc.clientId
    const ws = workspaces[ownerId]
    if (ws && ws.data) {
      const d = ws.data
      acc.snapshot = {
        company: d.company || d.settings?.company || acc.snapshot?.company || {},
        client: (d.clients || []).find((c) => c.id === clientId) || acc.snapshot?.client,
        invoices: filterByClient(d.invoices, clientId, email),
        quotes: filterByClient(d.quotes, clientId, email),
        tickets: filterByClient(d.tickets, clientId, email),
        payments: filterByClient(d.payments, clientId, email),
        updatedAt: now(),
      }
    }
    acc.updatedAt = now()
    accounts[key] = acc
    saveAccounts(accounts)
    res.json({ ok: true, updatedAt: acc.updatedAt, counts: {
      invoices: acc.snapshot.invoices.length,
      quotes: acc.snapshot.quotes.length,
      tickets: acc.snapshot.tickets.length,
      payments: acc.snapshot.payments.length,
    }})
  })

  app.post('/api/client-portal/login', loginRateLimit || ((_r, _s, n) => n()), (req, res) => {
    const email = safeEmail(req.body?.email)
    const pin = String(req.body?.pin || req.body?.password || '').trim()
    if (!email || !pin) return res.status(400).json({ error: 'Email and PIN required' })

    const accounts = loadAccounts()
    // Find by email across workspaces (unique email per shop preferred)
    const matches = Object.values(accounts).filter(
      (a) => a.email === email && a.active !== false,
    )
    if (!matches.length) {
      return res.status(401).json({ error: 'No portal access for this email. Ask your service provider to enable portal login.' })
    }

    let acc = null
    for (const a of matches) {
      try {
        if (bcrypt.compareSync(pin, a.pin_hash)) {
          acc = a
          break
        }
      } catch {}
    }
    if (!acc) return res.status(401).json({ error: 'Wrong PIN' })

    acc.lastLoginAt = now()
    accounts[accountKey(acc.workspaceOwnerId, email)] = acc
    saveAccounts(accounts)

    const token = clientToken({
      email: acc.email,
      clientId: acc.clientId,
      workspaceOwnerId: acc.workspaceOwnerId,
      name: acc.name,
    })

    res.json({
      ok: true,
      token,
      user: {
        email: acc.email,
        name: acc.name,
        clientId: acc.clientId,
      },
      company: acc.snapshot?.company || {},
    })
  })

  app.get('/api/client-portal/me', clientAuth, (req, res) => {
    const accounts = loadAccounts()
    const key = accountKey(req.clientUser.workspaceOwnerId, req.clientUser.email)
    const acc = accounts[key]
    if (!acc || acc.active === false) return res.status(404).json({ error: 'Account inactive' })
    res.json({
      ok: true,
      user: { email: acc.email, name: acc.name, clientId: acc.clientId },
      company: acc.snapshot?.company || {},
    })
  })

  app.get('/api/client-portal/dashboard', clientAuth, (req, res) => {
    const accounts = loadAccounts()
    const key = accountKey(req.clientUser.workspaceOwnerId, req.clientUser.email)
    const acc = accounts[key]
    if (!acc || acc.active === false) return res.status(404).json({ error: 'Account inactive' })

    // Live filter from workspace when possible
    let snap = acc.snapshot || {}
    const ws = workspaces[acc.workspaceOwnerId]
    if (ws && ws.data) {
      const d = ws.data
      const clientId = acc.clientId
      const email = acc.email
      snap = {
        company: d.company || d.settings?.company || snap.company || {},
        client: (d.clients || []).find((c) => c.id === clientId) || snap.client,
        invoices: filterByClient(d.invoices, clientId, email),
        quotes: filterByClient(d.quotes, clientId, email),
        tickets: filterByClient(d.tickets, clientId, email),
        payments: filterByClient(d.payments, clientId, email),
        updatedAt: now(),
      }
    }

    const invoices = snap.invoices || []
    const openBal = invoices
      .filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()))
      .reduce((s, i) => s + (Number(i.amountDue ?? i.total) || 0), 0)

    res.json({
      ok: true,
      company: snap.company || {},
      client: snap.client || { name: acc.name, email: acc.email },
      summary: {
        invoices: invoices.length,
        quotes: (snap.quotes || []).length,
        tickets: (snap.tickets || []).length,
        payments: (snap.payments || []).length,
        openBalance: openBal,
      },
      invoices,
      quotes: snap.quotes || [],
      tickets: snap.tickets || [],
      payments: snap.payments || [],
      updatedAt: snap.updatedAt,
    })
  })

  app.post('/api/client-portal/quote-decision', clientAuth, (req, res) => {
    const { quoteId, decision } = req.body || {}
    const d = String(decision || '').toLowerCase()
    if (!quoteId || !['accepted', 'rejected', 'accept', 'reject'].includes(d)) {
      return res.status(400).json({ error: 'quoteId and decision (accepted|rejected) required' })
    }
    const status = d.startsWith('accept') ? 'accepted' : 'rejected'
    const accounts = loadAccounts()
    const key = accountKey(req.clientUser.workspaceOwnerId, req.clientUser.email)
    const acc = accounts[key]
    if (!acc) return res.status(404).json({ error: 'Account not found' })

    // Update snapshot quote status
    if (acc.snapshot && Array.isArray(acc.snapshot.quotes)) {
      acc.snapshot.quotes = acc.snapshot.quotes.map((q) =>
        q.id === quoteId || q.number === quoteId ? { ...q, status, portalDecidedAt: now() } : q,
      )
    }
    // Update workspace quote if present
    const ws = workspaces[acc.workspaceOwnerId]
    if (ws && ws.data && Array.isArray(ws.data.quotes)) {
      ws.data.quotes = ws.data.quotes.map((q) =>
        q.id === quoteId || q.number === quoteId ? { ...q, status, portalDecidedAt: now() } : q,
      )
      workspaces[acc.workspaceOwnerId] = ws
      if (typeof ctx.persistWorkspaces === 'function') ctx.persistWorkspaces()
    }
    acc.updatedAt = now()
    accounts[key] = acc
    saveAccounts(accounts)
    res.json({ ok: true, quoteId, status })
  })

  app.get('/api/client-portal/health', (_req, res) => {
    res.json({
      ok: true,
      feature: 'client_portal_login',
      portalUrl: process.env.CLIENT_PORTAL_URL || 'https://sa-invoice-pro-client-portal.pages.dev',
    })
  })

  console.log('[client-portal-auth] mounted')
}

module.exports = { mountClientPortal }
