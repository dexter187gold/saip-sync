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
const { buildSignature } = require('./payfastSign')

function mountClientPortal(app, ctx) {
  const {
    DATA_DIR,
    loadJson,
    saveJson,
    workspaces,
    auth,
    now,
    JWT_SECRET,
    PUBLIC_BASE,
    loginRateLimit,
    safeEmail,
    git,
  } = ctx

  const ACCOUNTS_FILE = path.join(DATA_DIR, 'client_portal_accounts.json')
  const SESSIONS_FILE = path.join(DATA_DIR, 'client_portal_sessions.json')
  // Presence is ephemeral by design: a process restart correctly returns users to offline.
  const BUSINESS_PRESENCE = new Map()
  const CLIENT_PRESENCE = new Map()

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
      // Re-check account state on every request so disabling an account or
      // resetting its PIN immediately invalidates previously issued sessions.
      const accounts = loadAccounts()
      const acc = accounts[accountKey(decoded.workspaceOwnerId, decoded.email)]
      if (!acc || acc.active === false || String(acc.clientId) !== String(decoded.clientId)) {
        return res.status(401).json({ error: 'Client portal session is no longer active' })
      }
      req.clientUser = decoded
      next()
    } catch {
      return res.status(401).json({ error: 'Invalid or expired session' })
    }
  }

  function companyFromWorkspace(data, fallback = {}) {
    const raw = data?.company
    const selected = Array.isArray(raw) ? raw[0] : raw
    if (selected && typeof selected === 'object') return selected
    const settingsCompany = data?.settings?.company
    return settingsCompany && typeof settingsCompany === 'object' ? settingsCompany : (fallback || {})
  }

  function findWorkspaceClient(data, clientId, email) {
    const rows = Array.isArray(data?.clients) ? data.clients : []
    const em = String(email || '').toLowerCase().trim()
    return rows.find((client) => String(client.id) === String(clientId)) ||
      rows.find((client) => em && safeEmail(client.email) === em) || null
  }

  function filterByClient(list, clientId, email) {
    const arr = Array.isArray(list) ? list : []
    const em = String(email || '').toLowerCase().trim()
    return arr.filter((row) => {
      if (!row) return false
      const nestedClient = row.client && typeof row.client === 'object' ? row.client : {}
      const nestedCustomer = row.customer && typeof row.customer === 'object' ? row.customer : {}
      const rowClientId = row.clientId ?? row.client_id ?? row.customerId ?? row.customer_id ?? nestedClient.id ?? nestedCustomer.id
      const clientIds = Array.isArray(clientId) ? clientId : [clientId]
      if (rowClientId != null && clientIds.some((id) => id != null && String(rowClientId) === String(id))) return true
      const rowEmail = String(row.clientEmail || row.client_email || row.customerEmail || row.customer_email || row.email || nestedClient.email || nestedCustomer.email || '').toLowerCase().trim()
      return !!(em && rowEmail && rowEmail === em)
    })
  }

  // Payment records are frequently linked through invoiceId rather than a
  // clientId/email. Include only payments linked to this client's invoices.
  function paymentInvoiceReference(payment) {
    const nested = payment?.invoice && typeof payment.invoice === 'object' ? payment.invoice : {}
    const value = payment?.invoiceId ?? payment?.invoice_id ?? payment?.invoiceNumber ??
      payment?.invoice_number ?? payment?.invoiceRef ?? payment?.invoice_ref ??
      payment?.invoiceNo ?? payment?.invoice_no ?? payment?.relatedInvoiceId ??
      payment?.parentInvoiceId ?? nested.id ?? nested.number
    return value == null ? '' : String(value)
  }

  function embeddedInvoicePayments(invoices = []) {
    const rows = []
    for (const invoice of invoices || []) {
      for (const key of ['payments', 'paymentHistory', 'payment_history', 'transactions']) {
        for (const payment of (Array.isArray(invoice?.[key]) ? invoice[key] : [])) {
          if (!payment || typeof payment !== 'object') continue
          rows.push({
            ...payment,
            invoiceId: payment.invoiceId ?? payment.invoice_id ?? invoice.id,
            invoiceNumber: payment.invoiceNumber ?? payment.invoice_number ?? invoice.number,
            clientId: payment.clientId ?? payment.client_id ?? invoice.clientId,
            clientEmail: payment.clientEmail ?? payment.customerEmail ?? invoice.clientEmail ?? invoice.email,
          })
        }
      }
    }
    return rows
  }

  function filterPaymentsByClient(list, clientId, email, invoices = []) {
    const all = [...(Array.isArray(list) ? list : []), ...embeddedInvoicePayments(invoices)]
    const direct = filterByClient(all, clientId, email)
    const invoiceKeys = new Set()
    for (const invoice of invoices || []) {
      if (invoice?.id != null) invoiceKeys.add(String(invoice.id))
      if (invoice?.number != null) invoiceKeys.add(String(invoice.number))
    }
    const out = []
    const seen = new Set()
    for (const payment of [...direct, ...all]) {
      if (!payment) continue
      const key = String(payment.id || payment.reference || JSON.stringify(payment))
      if (seen.has(key)) continue
      if (direct.includes(payment) || invoiceKeys.has(paymentInvoiceReference(payment))) {
        seen.add(key)
        out.push(payment)
      }
    }
    return out
  }

  function paymentTotalsByInvoice(payments = []) {
    const totals = new Map()
    for (const payment of payments || []) {
      const id = paymentInvoiceReference(payment)
      if (!id) continue
      const status = String(payment.status || 'received').toLowerCase()
      if (['failed', 'declined', 'cancelled', 'canceled', 'void', 'voided', 'reversed', 'refunded'].includes(status)) continue
      const amount = Number(payment.amount ?? payment.paidAmount ?? payment.value) || 0
      totals.set(id, (totals.get(id) || 0) + amount)
    }
    return totals
  }

  function makeAccountStatement(invoices = [], payments = [], timestamp = new Date().toISOString()) {
    const paymentTotals = paymentTotalsByInvoice(payments)
    const invoiceRows = (invoices || []).map((invoice) => {
      const id = String(invoice.id ?? invoice.number ?? '')
      const linkedPaid = (paymentTotals.get(id) || 0) + (paymentTotals.get(String(invoice.number || '')) || 0)
      const recordedPaid = Math.max(Number(invoice.amountPaid) || 0, linkedPaid)
      const total = Math.max(0, Number(invoice.total ?? invoice.amount) || 0)
      const status = String(invoice.status || '').toLowerCase()
      const dueFromRecord = invoice.amountDue == null ? null : Math.max(0, Number(invoice.amountDue) || 0)
      const calculatedDue = Math.max(0, total - recordedPaid)
      const due = ['paid', 'settled', 'closed'].includes(status) ? 0 : (dueFromRecord == null ? calculatedDue : Math.min(dueFromRecord, calculatedDue))
      return { invoice, id, total, paid: Math.max(0, total - due), due }
    })
    const totalInvoiced = invoiceRows.reduce((sum, row) => sum + row.total, 0)
    const openBalance = invoiceRows.reduce((sum, row) => sum + row.due, 0)
    const totalPaid = invoiceRows.reduce((sum, row) => sum + row.paid, 0)
    const entries = []
    for (const row of invoiceRows) {
      const inv = row.invoice
      entries.push({
        id: 'invoice:' + row.id, type: 'invoice', date: inv.createdAt || inv.issuedAt || inv.date || inv.updatedAt || timestamp,
        reference: inv.number || inv.id, description: 'Invoice issued', debit: row.total, credit: 0,
        status: inv.status || 'issued', invoiceId: inv.id,
      })
    }
    const paymentSums = paymentTotalsByInvoice(payments)
    for (const payment of payments || []) {
      const amount = Math.max(0, Number(payment.amount ?? payment.paidAmount ?? payment.value) || 0)
      if (!amount) continue
      const status = String(payment.status || 'received').toLowerCase()
      const confirmed = !['failed', 'declined', 'cancelled', 'canceled', 'void', 'voided', 'reversed', 'refunded'].includes(status)
      entries.push({
        id: 'payment:' + String(payment.id || payment.reference || entries.length),
        type: 'payment', date: payment.createdAt || payment.paidAt || payment.date || timestamp,
        reference: payment.reference || payment.transactionId || payment.id || '',
        description: payment.method || payment.channel || 'Payment received',
        debit: 0, credit: confirmed ? amount : 0, status: payment.status || 'received',
        invoiceId: payment.invoiceId || payment.invoice_id || payment.invoiceNumber || payment.invoice_number || null,
      })
    }
    // Legacy invoices may contain amountPaid without a corresponding payment row.
    for (const row of invoiceRows) {
      const inv = row.invoice
      const recorded = paymentTotals.get(row.id) || paymentTotals.get(String(inv.number || '')) || 0
      const legacy = Math.max(0, (Number(inv.amountPaid) || 0) - recorded)
      if (legacy > 0.009) entries.push({
        id: 'legacy-payment:' + row.id, type: 'payment',
        date: inv.paidAt || inv.updatedAt || inv.date || timestamp,
        reference: inv.number || inv.id, description: 'Previously recorded payment',
        debit: 0, credit: legacy, status: 'recorded', invoiceId: inv.id,
      })
    }
    entries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    let balance = 0
    for (const entry of entries) {
      balance = Math.round((balance + entry.debit - entry.credit + Number.EPSILON) * 100) / 100
      entry.balance = balance
    }
    return { generatedAt: timestamp, currency: 'ZAR', totalInvoiced, totalPaid, openBalance, entries }
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
    const messages = loadPortalMessages().filter((row) => messageForClient(row, acc))
    const recent = (value) => !!value && (Date.now() - new Date(value).getTime()) < 90000
    return {
      email: acc.email, name: acc.name, clientId: acc.clientId,
      active: acc.active !== false, createdAt: acc.createdAt || null,
      updatedAt: acc.updatedAt || null, lastLoginAt: acc.lastLoginAt || null,
      clientOnline: recent(CLIENT_PRESENCE.get(accountKey(acc.workspaceOwnerId, acc.email))), businessOnline: recent(BUSINESS_PRESENCE.get(acc.workspaceOwnerId)),
      unreadMessages: messages.filter((row) => row.sender === 'client' && !row.readAt).length,
      lastMessage: messages.length ? safeMessage(messages[messages.length - 1]) : null,
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
    BUSINESS_PRESENCE.set(ownerId, Date.now())
    const rows = Object.values(accounts).filter((acc) => acc.workspaceOwnerId === ownerId)
      .map(safeAccountSummary).sort((a, b) => String(a.email).localeCompare(String(b.email)))
    res.json({ ok: true, accounts: rows })
  })

  app.post('/api/client-portal/refresh-snapshots', auth, (req, res) => {
    const ownerId = req.user.id
    const ws = workspaces[ownerId]
    if (!ws || !ws.data) return res.status(409).json({ error: 'Workspace data is not available yet; sync the workspace first' })
    const d = ws.data
    const accounts = loadAccounts()
    let refreshed = 0
    for (const acc of Object.values(accounts)) {
      if (acc.workspaceOwnerId !== ownerId) continue
      const workspaceClient = findWorkspaceClient(d, acc.clientId, acc.email)
      const clientId = workspaceClient?.id ?? acc.clientId
      const invoices = filterByClient(d.invoices, [clientId, acc.clientId], acc.email)
      acc.clientId = String(clientId)
      acc.snapshot = {
        company: companyFromWorkspace(d, acc.snapshot?.company || {}),
        client: workspaceClient || acc.snapshot?.client,
        invoices, quotes: filterByClient(d.quotes, [clientId, acc.clientId], acc.email),
        tickets: filterByClient(d.tickets, [clientId, acc.clientId], acc.email),
        payments: filterPaymentsByClient(d.payments, [clientId, acc.clientId], acc.email, invoices),
        updatedAt: now(),
      }
      acc.updatedAt = now()
      refreshed++
    }
    saveAccounts(accounts)
    res.json({ ok: true, refreshed })
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
    let clientId = String(body.clientId || body.id || '').trim()
    const requestedClientId = clientId
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
      const workspaceClient = findWorkspaceClient(d, clientId, email)
      if (workspaceClient?.id != null) clientId = String(workspaceClient.id)
      snapshot.invoices = filterByClient(d.invoices, [clientId, requestedClientId], email)
      snapshot.quotes = filterByClient(d.quotes, [clientId, requestedClientId], email)
      snapshot.tickets = filterByClient(d.tickets, [clientId, requestedClientId], email)
      snapshot.payments = filterPaymentsByClient(d.payments, [clientId, requestedClientId], email, snapshot.invoices)
      if (Array.isArray(d.clients)) {
        const found = d.clients.find((c) => c.id === clientId || safeEmail(c.email) === email)
        if (found) snapshot.client = found
      }
      if (d.settings || d.company) snapshot.company = companyFromWorkspace(d, snapshot.company)
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
      'https://sa-invoice-pro-client-portal.pcrepairdex.workers.dev'

    res.json({
      ok: true,
      email,
      username: email,
      pin,
      clientId,
      portalUrl: portalBase,
      loginHint: `Sign in at ${portalBase} with username ${email} and PIN ${pin}`,
      message: 'Share the portal URL, username and PIN with the customer. PIN shown once — store it securely.',
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

    const ws = workspaces[ownerId]
    if (ws && ws.data) {
      const d = ws.data
      const workspaceClient = findWorkspaceClient(d, acc.clientId, email)
      const clientId = workspaceClient?.id ?? acc.clientId
      const invoices = filterByClient(d.invoices, [clientId, acc.clientId], email)
      acc.clientId = String(clientId)
      acc.snapshot = {
        company: companyFromWorkspace(d, acc.snapshot?.company || {}),
        client: workspaceClient || acc.snapshot?.client,
        invoices,
        quotes: filterByClient(d.quotes, [clientId, acc.clientId], email),
        tickets: filterByClient(d.tickets, [clientId, acc.clientId], email),
        payments: filterPaymentsByClient(d.payments, [clientId, acc.clientId], email, invoices),
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
    const email = safeEmail(req.body?.email || req.body?.username)
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
      const workspaceClient = findWorkspaceClient(d, acc.clientId, acc.email)
      const clientId = workspaceClient?.id ?? acc.clientId
      const email = acc.email
      snap = {
        company: companyFromWorkspace(d, snap.company || {}),
        client: workspaceClient || snap.client,
        invoices: filterByClient(d.invoices, [clientId, acc.clientId], email),
        quotes: filterByClient(d.quotes, [clientId, acc.clientId], email),
        tickets: filterByClient(d.tickets, [clientId, acc.clientId], email),
        payments: filterPaymentsByClient(d.payments, [clientId, acc.clientId], email, filterByClient(d.invoices, [clientId, acc.clientId], email)),
        updatedAt: now(),
      }
    }

    const invoices = snap.invoices || []
    const quotes = snap.quotes || []
    const tickets = snap.tickets || []
    const payments = snap.payments || []
    const statement = makeAccountStatement(invoices, payments, now())
    res.json({
      ok: true,
      company: snap.company || {},
      client: snap.client || { name: acc.name, email: acc.email },
      summary: {
        invoices: invoices.length,
        paidInvoices: invoices.filter((i) => ['paid', 'settled', 'closed'].includes(String(i.status || '').toLowerCase())).length,
        quotes: quotes.length,
        tickets: tickets.length,
        payments: payments.length,
        totalInvoiced: statement.totalInvoiced,
        totalPaid: statement.totalPaid,
        openBalance: statement.openBalance,
      },
      invoices,
      quotes,
      tickets,
      payments,
      accountStatement: statement,
      updatedAt: snap.updatedAt,
    })
  })

  /** Secure PayFast checkout for the authenticated customer's own invoice. */
  app.post('/api/client-portal/pay/:invoiceId', clientAuth, (req, res) => {
    const accounts = loadAccounts()
    const key = accountKey(req.clientUser.workspaceOwnerId, req.clientUser.email)
    const acc = accounts[key]
    if (!acc || acc.active === false) return res.status(404).json({ error: 'Client portal account not found' })
    const ws = workspaces[acc.workspaceOwnerId]
    const data = ws?.data || {}
    const snap = acc.snapshot || {}
    const invoices = Array.isArray(data.invoices) ? data.invoices : (snap.invoices || [])
    const workspaceClient = findWorkspaceClient(data, acc.clientId, acc.email)
    const canonicalClientId = workspaceClient?.id ?? acc.clientId
    const clientInvoices = filterByClient(invoices, canonicalClientId, acc.email)
    const payments = filterPaymentsByClient(
      Array.isArray(data.payments) ? data.payments : (snap.payments || []),
      acc.clientId, acc.email, clientInvoices,
    )
    const invoice = clientInvoices.find((i) =>
      String(i.id) === String(req.params.invoiceId) || String(i.number) === String(req.params.invoiceId)
    )
    if (!invoice) return res.status(404).json({ error: 'Invoice not found for this client' })
    if (['cancelled', 'canceled', 'void', 'voided'].includes(String(invoice.status || '').toLowerCase())) {
      return res.status(409).json({ error: 'This invoice is cancelled or void and cannot be paid' })
    }
    const total = Math.max(0, Number(invoice.total ?? invoice.amount) || 0)
    const paidByPayments = payments
      .filter((p) => String(p.invoiceId ?? p.invoice_id ?? p.invoiceNumber ?? p.invoice_number ?? '') === String(invoice.id) ||
        String(p.invoiceId ?? p.invoice_id ?? p.invoiceNumber ?? p.invoice_number ?? '') === String(invoice.number))
      .reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
    const paid = Math.max(Number(invoice.amountPaid) || 0, paidByPayments)
    const calculatedDue = Math.max(0, total - paid)
    const due = invoice.amountDue == null ? calculatedDue : Math.min(calculatedDue, Math.max(0, Number(invoice.amountDue) || 0))
    if (due <= 0.009) return res.status(409).json({ error: 'This invoice has no outstanding balance' })

    const settings = data.settings || {}
    const company = companyFromWorkspace(data, snap.company || {})
    const merchantId = process.env.PAYFAST_MERCHANT_ID || settings.payfastMerchantId || ''
    const merchantKey = process.env.PAYFAST_MERCHANT_KEY || settings.payfastMerchantKey || ''
    const passphrase = process.env.PAYFAST_PASSPHRASE || settings.payfastPassphrase || ''
    const portalBase = String(process.env.CLIENT_PORTAL_URL || 'https://sa-invoice-pro-client-portal.pcrepairdex.workers.dev').replace(/\/$/, '')
    if (!merchantId || !merchantKey) {
      return res.status(200).json({
        ok: true, configured: false, amountDue: due,
        message: 'Online card payments are not configured yet. Please use the workshop EFT details or contact the workshop.',
        company: { name: company.name, email: company.email, phone: company.phone },
        bankDetails: {
          bankName: settings.bankName || company.bankName || '',
          accountName: settings.bankAccountName || settings.accountHolder || company.accountHolder || company.bankAccountName || company.name || '',
          accountNumber: settings.bankAccountNumber || settings.accountNumber || company.accountNumber || '',
          branchCode: settings.bankBranchCode || settings.branchCode || company.branchCode || '',
          accountType: settings.bankAccountType || company.bankAccountType || '',
          reference: invoice.number || invoice.id,
        },
      })
    }
    const sandbox = String(process.env.PAYFAST_SANDBOX || settings.payfastSandbox || 'true').toLowerCase() !== 'false'
    const fields = {
      merchant_id: String(merchantId),
      merchant_key: String(merchantKey),
      return_url: portalBase + '/?payment=processing',
      cancel_url: portalBase + '/?payment=cancelled',
      notify_url: String(PUBLIC_BASE || 'https://saip-sync.onrender.com').replace(/\/$/, '') + '/api/payfast/itn',
      amount: due.toFixed(2),
      item_name: String(invoice.number || invoice.id).slice(0, 100),
      item_description: ('Invoice payment ' + String(invoice.number || invoice.id)).slice(0, 255),
      custom_str1: String(invoice.id),
      custom_str2: String(acc.clientId),
      email_address: String(acc.email),
    }
    fields.signature = buildSignature(fields, passphrase)
    res.json({
      ok: true, configured: true, sandbox,
      processUrl: sandbox ? 'https://sandbox.payfast.co.za/eng/process' : 'https://www.payfast.co.za/eng/process',
      amount: due, invoiceId: invoice.id, invoiceNumber: invoice.number || invoice.id, fields,
    })
  })

  app.post('/api/client-portal/quote-decision', clientAuth, (req, res) => {
    const { quoteId, decision } = req.body || {}
    const note = String(req.body?.note || req.body?.reason || '').slice(0, 500)
    const d = String(decision || '').toLowerCase()
    if (!quoteId || !['accepted', 'rejected', 'accept', 'reject'].includes(d)) {
      return res.status(400).json({ error: 'quoteId and decision (accepted|rejected) required' })
    }
    const status = d.startsWith('accept') ? 'accepted' : 'rejected'
    const accounts = loadAccounts()
    const key = accountKey(req.clientUser.workspaceOwnerId, req.clientUser.email)
    const acc = accounts[key]
    if (!acc) return res.status(404).json({ error: 'Account not found' })

    // A client may decide only a quote explicitly linked to their own client
    // record. Never trust a quote ID/number alone: IDs can be guessed or shared.
    const belongsToAccount = (quote) => {
      if (!quote) return false
      if (String(quote.clientId ?? quote.client_id ?? '') === String(acc.clientId)) return true
      const quoteEmail = String(quote.clientEmail || quote.email || '').toLowerCase().trim()
      return !!quoteEmail && quoteEmail === String(acc.email || '').toLowerCase().trim()
    }
    const matchesQuote = (quote) => String(quote.id) === String(quoteId) || String(quote.number) === String(quoteId)
    const ws = workspaces[acc.workspaceOwnerId]
    const workspaceQuotes = ws?.data && Array.isArray(ws.data.quotes) ? ws.data.quotes : null
    const snapshotQuotes = Array.isArray(acc.snapshot?.quotes) ? acc.snapshot.quotes : []
    const sourceQuotes = workspaceQuotes || snapshotQuotes
    const target = sourceQuotes.find(matchesQuote)
    if (!target || !belongsToAccount(target)) {
      return res.status(404).json({ error: 'Quote not found' })
    }
    if (['accepted', 'rejected', 'converted'].includes(String(target.status || '').toLowerCase()) || target.portalDecision) {
      return res.status(409).json({ error: 'Quote already decided' })
    }

    const decisionAt = now()
    const updateOwnedQuote = (quotes) => quotes.map((q) =>
      matchesQuote(q) && belongsToAccount(q) ? {
        ...q,
        status,
        portalDecision: status,
        portalDecisionAt: decisionAt,
        portalDecidedAt: decisionAt,
        portalDecisionReason: note || null,
        portalNote: note || null,
        updatedAt: decisionAt,
      } : q,
    )
    if (workspaceQuotes) {
      ws.data.quotes = updateOwnedQuote(workspaceQuotes)
      workspaces[acc.workspaceOwnerId] = ws
      if (typeof ctx.persistWorkspaces === 'function') ctx.persistWorkspaces()
    }
    if (Array.isArray(acc.snapshot?.quotes)) {
      acc.snapshot.quotes = updateOwnedQuote(acc.snapshot.quotes)
    }
    acc.updatedAt = now()
    accounts[key] = acc
    saveAccounts(accounts)
    res.json({ ok: true, quoteId, status })
  })


  // Persistent, tenant-isolated two-way client messaging.
  const MESSAGES_FILE = path.join(DATA_DIR, 'client_portal_messages.json')
  function loadPortalMessages() {
    const rows = loadJson(MESSAGES_FILE, [])
    return Array.isArray(rows) ? rows : []
  }
  function savePortalMessages(rows) {
    saveJson(MESSAGES_FILE, rows)
    if (git && typeof git.schedulePush === 'function') git.schedulePush('client_portal_messages')
  }
  function messageForClient(row, acc) {
    return row && String(row.workspaceOwnerId) === String(acc.workspaceOwnerId) &&
      String(row.clientId) === String(acc.clientId) &&
      String(row.clientEmail || '').toLowerCase() === String(acc.email || '').toLowerCase()
  }
  function safeMessage(row) {
    return {
      id: row.id, sender: row.sender, senderName: row.senderName,
      message: row.message, createdAt: row.createdAt,
      readAt: row.readAt || null, relatedType: row.relatedType || null,
      relatedId: row.relatedId || null,
    }
  }

  app.get('/api/client-portal/messages', clientAuth, (req, res) => {
    const accounts = loadAccounts()
    const acc = accounts[accountKey(req.clientUser.workspaceOwnerId, req.clientUser.email)]
    if (!acc || acc.active === false) return res.status(404).json({ error: 'Portal account not found' })
    CLIENT_PRESENCE.set(accountKey(req.clientUser.workspaceOwnerId, req.clientUser.email), Date.now())
    const rows = loadPortalMessages().filter((row) => messageForClient(row, acc)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    let changed = false
    for (const row of rows) {
      if (row.sender === 'business' && !row.readAt) { row.readAt = now(); changed = true }
    }
    if (changed) savePortalMessages(loadPortalMessages().map((row) => {
      const match = rows.find((r) => r.id === row.id)
      return match ? { ...row, readAt: match.readAt } : row
    }))
    res.json({ ok: true, messages: rows.map(safeMessage), unread: rows.filter((row) => row.sender === 'business' && !row.readAt).length })
  })

  app.post('/api/client-portal/presence', clientAuth, (req, res) => {
    const accounts = loadAccounts()
    const acc = accounts[accountKey(req.clientUser.workspaceOwnerId, req.clientUser.email)]
    if (!acc || acc.active === false) return res.status(404).json({ error: 'Portal account not found' })
    CLIENT_PRESENCE.set(accountKey(req.clientUser.workspaceOwnerId, req.clientUser.email), Date.now())
    const businessSeenAt = BUSINESS_PRESENCE.get(acc.workspaceOwnerId) || 0
    const businessOnline = Date.now() - businessSeenAt < 90000
    res.json({ ok: true, clientOnline: true, businessOnline })
  })

  app.post('/api/client-portal/messages', clientAuth, loginRateLimit || ((_r, _s, n) => n()), (req, res) => {
    const accounts = loadAccounts()
    const acc = accounts[accountKey(req.clientUser.workspaceOwnerId, req.clientUser.email)]
    if (!acc || acc.active === false) return res.status(404).json({ error: 'Portal account not found' })
    const message = String(req.body?.message || '').trim()
    if (message.length < 1 || message.length > 4000) return res.status(400).json({ error: 'Message must contain 1–4000 characters' })
    const row = {
      id: crypto.randomUUID(), workspaceOwnerId: acc.workspaceOwnerId,
      clientId: String(acc.clientId), clientEmail: acc.email,
      sender: 'client', senderName: String(acc.name || acc.email).slice(0, 120),
      message, createdAt: now(), readAt: null,
      relatedType: ['invoice', 'quote', 'job'].includes(String(req.body?.relatedType)) ? String(req.body.relatedType) : null,
      relatedId: String(req.body?.relatedId || '').slice(0, 120) || null,
    }
    CLIENT_PRESENCE.set(accountKey(acc.workspaceOwnerId, acc.email), Date.now())
    const rows = loadPortalMessages()
    rows.push(row)
    savePortalMessages(rows.slice(-20000))
    res.status(201).json({ ok: true, message: safeMessage(row) })
  })

  // Business-side inbox: the authenticated workspace owner can only read/reply
  // to portal threads belonging to accounts issued from their own workspace.
  app.get('/api/client-portal/messages/business', auth, (req, res) => {
    const email = safeEmail(req.query?.email)
    if (!email) return res.status(400).json({ error: 'Valid client email required' })
    const accounts = loadAccounts()
    const acc = accounts[accountKey(req.user.id, email)]
    if (!acc) return res.status(404).json({ error: 'Client portal account not found in this workspace' })
    const rows = loadPortalMessages().filter((row) => messageForClient(row, acc)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    let changed = false
    for (const row of rows) {
      if (row.sender === 'client' && !row.readAt) { row.readAt = now(); changed = true }
    }
    if (changed) {
      const readIds = new Set(rows.filter((r) => r.readAt).map((r) => r.id))
      savePortalMessages(loadPortalMessages().map((row) => readIds.has(row.id) ? { ...row, readAt: row.readAt || now() } : row))
    }
    res.json({ ok: true, email, clientName: acc.name, messages: rows.map(safeMessage), unread: rows.filter((row) => row.sender === 'client' && !row.readAt).length })
  })

  app.post('/api/client-portal/messages/business/reply', auth, (req, res) => {
    const email = safeEmail(req.body?.email)
    const message = String(req.body?.message || '').trim()
    if (!email) return res.status(400).json({ error: 'Valid client email required' })
    if (message.length < 1 || message.length > 4000) return res.status(400).json({ error: 'Message must contain 1–4000 characters' })
    const accounts = loadAccounts()
    const acc = accounts[accountKey(req.user.id, email)]
    if (!acc || acc.active === false) return res.status(404).json({ error: 'Active client portal account not found in this workspace' })
    const row = {
      id: crypto.randomUUID(), workspaceOwnerId: acc.workspaceOwnerId,
      clientId: String(acc.clientId), clientEmail: acc.email,
      sender: 'business', senderName: 'Workshop',
      message, createdAt: now(), readAt: null,
      relatedType: ['invoice', 'quote', 'job'].includes(String(req.body?.relatedType)) ? String(req.body.relatedType) : null,
      relatedId: String(req.body?.relatedId || '').slice(0, 120) || null,
    }
    const rows = loadPortalMessages()
    rows.push(row)
    savePortalMessages(rows.slice(-20000))
    res.status(201).json({ ok: true, message: safeMessage(row) })
  })

  app.get('/api/client-portal/health', (_req, res) => {
    res.json({
      ok: true,
      feature: 'client_portal_login',
      portalUrl: process.env.CLIENT_PORTAL_URL || 'https://sa-invoice-pro-client-portal.pcrepairdex.workers.dev',
    })
  })

  console.log('[client-portal-auth] mounted')
}

module.exports = { mountClientPortal }
