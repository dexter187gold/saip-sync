/**
 * Customer portal — invoices, quotes, tickets, approve/reject, PayFast, NPS.
 * SPA: /api/portal/view, /quote-decision · Hosted: /p/:token
 */
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const { buildSignature } = require('./payfastSign')

function mountPortal(app, ctx) {
  const { workspaces, auth, PUBLIC_BASE, persistWorkspaces, DATA_DIR, git } = ctx
  const PORTALS_FILE = path.join(DATA_DIR || path.join(__dirname, 'data'), 'portals.json')

  function loadPortals() {
    try {
      if (fs.existsSync(PORTALS_FILE)) return JSON.parse(fs.readFileSync(PORTALS_FILE, 'utf8'))
    } catch (e) {
      console.warn('[portal] load', e.message)
    }
    return global.__saip_portals || {}
  }
  function savePortals(obj) {
    global.__saip_portals = obj
    try {
      fs.mkdirSync(path.dirname(PORTALS_FILE), { recursive: true })
      const tmp = PORTALS_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
      fs.renameSync(tmp, PORTALS_FILE)
    } catch (e) {
      console.warn('[portal] save', e.message)
    }
    try {
      if (git && typeof git.schedulePush === 'function') git.schedulePush('portals')
    } catch {}
  }

  let portals = loadPortals()
  global.__saip_portals = portals

  function ownerWorkspace(userId) {
    return workspaces[userId]
  }

  function portalPayload(token, row) {
    const ws = ownerWorkspace(row.userId)
    const data = ws?.data || {}
    const client = (data.clients || []).find((c) => String(c.id) === String(row.clientId))
    const invoices = (data.invoices || []).filter((i) => String(i.clientId) === String(row.clientId))
    const quotes = (data.quotes || []).filter((q) => String(q.clientId) === String(row.clientId))
    const tickets = (data.tickets || []).filter((t) => String(t.clientId) === String(row.clientId))
    const company =
      data.company && !Array.isArray(data.company)
        ? data.company
        : (data.company && data.company[0]) || {}
    return {
      ok: true,
      company: {
        name: company.name,
        phone: company.phone,
        email: company.email,
        whatsapp: company.whatsapp || company.phone,
      },
      client: client
        ? { id: client.id, name: client.name, company: client.company }
        : { id: row.clientId, name: 'Client' },
      invoices: invoices.map((i) => ({
        id: i.id,
        number: i.number,
        date: i.date,
        dueDate: i.dueDate,
        status: i.status,
        total: i.total,
        amountDue: i.amountDue != null ? i.amountDue : i.total,
      })),
      quotes: quotes.map((q) => ({
        id: q.id,
        number: q.number,
        date: q.date,
        validUntil: q.validUntil,
        status: q.status || 'sent',
        total: q.total,
        lines: Array.isArray(q.lines) ? q.lines.slice(0, 20) : [],
        portalDecision: q.portalDecision || null,
        portalDecisionAt: q.portalDecisionAt || null,
        portalNote: q.portalNote || q.portalDecisionReason || null,
      })),
      tickets: tickets.slice(0, 30).map((t) => ({
        id: t.id,
        number: t.number,
        title: t.title,
        status: t.status || 'open',
        device: t.device || t.deviceLabel || '',
        imei: t.imei || '',
        promisedAt: t.promisedAt || t.dueDate || t.slaDue || null,
        publicNote: t.publicNote || t.customerNote || '',
      })),
      expires: row.expires,
      token,
    }
  }

  function resolveToken(raw) {
    portals = loadPortals()
    const token = String(raw || '').trim()
    const row = portals[token]
    if (!row) return { error: 'Invalid or expired portal link', status: 404 }
    if (row.expires && new Date(row.expires) < new Date()) {
      delete portals[token]
      savePortals(portals)
      return { error: 'Portal link expired', status: 410 }
    }
    return { token, row }
  }

  function applyDecision(token, quoteId, decisionRaw, reason) {
    const resolved = resolveToken(token)
    if (resolved.error) return resolved
    const { row } = resolved
    let decision = String(decisionRaw || '').toLowerCase()
    if (decision === 'approve' || decision === 'accept') decision = 'approved'
    if (decision === 'reject' || decision === 'decline') decision = 'rejected'
    if (!['approved', 'rejected'].includes(decision)) {
      return { error: 'decision must be approve/reject (or approved/rejected)', status: 400 }
    }
    const note = String(reason || '').slice(0, 500)
    const ws = ownerWorkspace(row.userId)
    if (!ws?.data) return { error: 'Workspace missing — shop must Sync Now first', status: 400 }
    const quotes = ws.data.quotes || []
    const idx = quotes.findIndex((q) => String(q.id) === String(quoteId))
    if (idx < 0) return { error: 'Quote not found', status: 404 }
    const q = quotes[idx]
    if (String(q.clientId) !== String(row.clientId)) {
      return { error: 'Quote not in this portal', status: 403 }
    }
    const prev = String(q.status || '').toLowerCase()
    if (['accepted', 'rejected', 'converted'].includes(prev) || q.portalDecision) {
      return { error: 'Quote already decided', status: 409, quote: q }
    }
    const ts = new Date().toISOString()
    quotes[idx] = {
      ...q,
      status: decision === 'approved' ? 'accepted' : 'rejected',
      portalDecision: decision === 'approved' ? 'accepted' : 'rejected',
      portalDecisionAt: ts,
      portalDecisionReason: note || null,
      portalNote: note || null,
      updatedAt: ts,
    }
    ws.data.quotes = quotes
    ws.version = (ws.version || 0) + 1
    ws.updated_at = ts
    if (typeof persistWorkspaces === 'function') persistWorkspaces()
    try {
      const logFile = path.join(DATA_DIR || path.join(__dirname, 'data'), 'portal_decisions.json')
      let log = []
      try {
        if (fs.existsSync(logFile)) log = JSON.parse(fs.readFileSync(logFile, 'utf8')) || []
      } catch {}
      if (!Array.isArray(log)) log = []
      log.push({
        id: 'dec_' + Date.now().toString(36),
        token,
        quoteId: String(quoteId),
        action: decision === 'approved' ? 'accepted' : 'rejected',
        note,
        clientId: row.clientId,
        userId: row.userId,
        at: ts,
      })
      if (log.length > 500) log = log.slice(-500)
      fs.writeFileSync(logFile, JSON.stringify(log, null, 2), 'utf8')
      if (git && typeof git.schedulePush === 'function') git.schedulePush('portal_decisions')
    } catch (e) {
      console.warn('[portal] decision log', e.message)
    }
    return { ok: true, quote: quotes[idx] }
  }

  app.post('/api/portal/create', auth, (req, res) => {
    const { clientId, days = 90 } = req.body || {}
    if (!clientId) return res.status(400).json({ error: 'clientId required' })
    const uid = req.user.id
    const ws = ownerWorkspace(uid)
    if (!ws?.data) return res.status(400).json({ error: 'Push workspace first' })
    const token = crypto.randomBytes(24).toString('hex')
    const expires = new Date(Date.now() + (Number(days) || 90) * 86400000).toISOString()
    portals[token] = { userId: uid, clientId: String(clientId), expires, createdAt: new Date().toISOString() }
    savePortals(portals)
    const base = (PUBLIC_BASE || '').replace(/\/$/, '')
    const spaOrigin = (process.env.FRONTEND_PUBLIC_URL || process.env.PORTAL_PUBLIC_URL || '').replace(/\/$/, '')
    const url = spaOrigin ? `${spaOrigin}/portal/${token}` : `${base}/p/${token}`
    res.json({ ok: true, token, url, expires, clientId: String(clientId) })
  })

  app.get('/api/portal/list', auth, (req, res) => {
    const uid = req.user.id
    const base = (PUBLIC_BASE || '').replace(/\/$/, '')
    const spaOrigin = (process.env.FRONTEND_PUBLIC_URL || process.env.PORTAL_PUBLIC_URL || '').replace(/\/$/, '')
    const list = Object.entries(portals)
      .filter(([, v]) => v.userId === uid)
      .map(([token, v]) => ({ token, ...v, url: spaOrigin ? `${spaOrigin}/portal/${token}` : `${base}/p/${token}` }))
    res.json({ ok: true, portals: list })
  })

  app.post('/api/portal/revoke', auth, (req, res) => {
    const token = req.body?.token
    if (token && portals[token]?.userId === req.user.id) {
      delete portals[token]
      savePortals(portals)
    }
    res.json({ ok: true })
  })

  app.get('/api/portal/view/:token', (req, res) => {
    const resolved = resolveToken(req.params.token)
    if (resolved.error) return res.status(resolved.status || 404).json({ error: resolved.error })
    res.json(portalPayload(resolved.token, resolved.row))
  })

  app.post('/api/portal/quote-decision', (req, res) => {
    const body = req.body || {}
    const token = body.token || body.portalToken
    const quoteId = body.quoteId || body.quote_id
    const decision = body.action || body.decision
    const note = body.note || body.reason || ''
    if (!token || !quoteId) return res.status(400).json({ error: 'token and quoteId required' })
    const result = applyDecision(token, quoteId, decision, note)
    if (result.error) return res.status(result.status || 400).json({ error: result.error, quote: result.quote || undefined })
    res.json({ ok: true, quote: result.quote, status: result.quote.status, message: result.quote.status === 'accepted' ? 'Quote accepted' : 'Quote declined' })
  })

  app.get('/api/portal/decisions', auth, (req, res) => {
    try {
      const logFile = path.join(DATA_DIR || path.join(__dirname, 'data'), 'portal_decisions.json')
      let log = []
      if (fs.existsSync(logFile)) log = JSON.parse(fs.readFileSync(logFile, 'utf8')) || []
      if (!Array.isArray(log)) log = []
      const uid = req.user.id
      const mine = log.filter((d) => String(d.userId) === String(uid))
      const limit = Math.min(200, Number(req.query.limit) || 50)
      res.json({ ok: true, data: mine.slice(-limit).reverse() })
    } catch (e) {
      res.json({ ok: true, data: [] })
    }
  })

  app.get('/api/portal/:token', (req, res) => {
    const t = req.params.token
    if (['view', 'decisions', 'list', 'create', 'revoke', 'quote-decision', 'register'].includes(t)) {
      return res.status(404).json({ error: 'Not found' })
    }
    const resolved = resolveToken(t)
    if (resolved.error) return res.status(resolved.status || 404).json({ error: resolved.error })
    res.json(portalPayload(resolved.token, resolved.row))
  })

  app.post('/api/portal/:token/quote/:quoteId/decision', (req, res) => {
    const result = applyDecision(req.params.token, req.params.quoteId, req.body?.decision || req.body?.action, req.body?.reason || req.body?.note || '')
    if (result.error) return res.status(result.status || 400).json({ error: result.error })
    res.json({ ok: true, quote: result.quote })
  })

  app.post('/api/portal/:token/feedback', (req, res) => {
    portals = loadPortals()
    const row = portals[req.params.token]
    if (!row) return res.status(404).json({ error: 'Invalid portal link' })
    const score = Math.max(0, Math.min(10, Number(req.body?.score)))
    const note = String(req.body?.note || '').slice(0, 400)
    if (!Number.isFinite(score)) return res.status(400).json({ error: 'score 0-10 required' })
    const ws = ownerWorkspace(row.userId)
    if (!ws?.data) return res.status(400).json({ error: 'Workspace missing' })
    if (!Array.isArray(ws.data.nps)) ws.data.nps = []
    ws.data.nps.unshift({ id: 'nps-' + Date.now(), clientId: row.clientId, score, note, source: 'portal', at: new Date().toISOString() })
    ws.data.nps = ws.data.nps.slice(0, 200)
    ws.version = (ws.version || 0) + 1
    ws.updated_at = new Date().toISOString()
    if (typeof persistWorkspaces === 'function') persistWorkspaces()
    res.json({ ok: true, score })
  })

  app.get('/api/portal/:token/pay/:invoiceId', (req, res) => {
    portals = loadPortals()
    const row = portals[req.params.token]
    if (!row) return res.status(404).json({ error: 'Invalid portal link' })
    if (row.expires && new Date(row.expires) < new Date()) return res.status(410).json({ error: 'Portal link expired' })
    const ws = ownerWorkspace(row.userId)
    const data = ws?.data || {}
    const inv = (data.invoices || []).find((i) => String(i.id) === String(req.params.invoiceId))
    if (!inv || String(inv.clientId) !== String(row.clientId)) return res.status(404).json({ error: 'Invoice not found' })
    const settings = data.settings || {}
    const company = data.company && !Array.isArray(data.company) ? data.company : (data.company && data.company[0]) || {}
    const merchantId = process.env.PAYFAST_MERCHANT_ID || settings.payfastMerchantId || ''
    const merchantKey = process.env.PAYFAST_MERCHANT_KEY || settings.payfastMerchantKey || ''
    const passphrase = process.env.PAYFAST_PASSPHRASE || settings.payfastPassphrase || ''
    const sandbox = String(process.env.PAYFAST_SANDBOX || settings.payfastSandbox || 'true') !== 'false'
    const amount = Number(inv.amountDue != null ? inv.amountDue : inv.total != null ? inv.total : 0)
    if (!(amount > 0)) return res.status(400).json({ error: 'Nothing due on this invoice' })
    if (!merchantId || !merchantKey) {
      return res.json({ ok: true, configured: false, amount, number: inv.number, message: 'PayFast not configured. Pay via EFT using company banking details, or ask the shop to enable PayFast.', company: { name: company.name, email: company.email, phone: company.phone } })
    }
    const base = (PUBLIC_BASE || '').replace(/\/$/, '')
    const pf = { merchant_id: String(merchantId), merchant_key: String(merchantKey), return_url: base + '/p/' + req.params.token + '?paid=1', cancel_url: base + '/p/' + req.params.token + '?paid=0', amount: amount.toFixed(2), item_name: String(inv.number || inv.id).slice(0, 100), custom_str1: String(inv.id) }
    try { pf.signature = buildSignature(pf, passphrase) } catch (e) { console.warn('[portal] payfast sign', e.message) }
    res.json({ ok: true, configured: true, sandbox, signed: !!pf.signature, processUrl: sandbox ? 'https://sandbox.payfast.co.za/eng/process' : 'https://www.payfast.co.za/eng/process', fields: pf })
  })

  app.get('/p/:token', (req, res) => {
    const token = String(req.params.token || '').replace(/[^a-f0-9]/gi, '')
    const spa = (process.env.FRONTEND_PUBLIC_URL || process.env.PORTAL_PUBLIC_URL || '').replace(/\/$/, '')
    if (spa) return res.redirect(302, spa + '/portal/' + token)
    res.type('html').send('<!DOCTYPE html><html><body style="font-family:system-ui;background:#0f1419;color:#e7ecf3;padding:24px"><p>Open the SPA portal link from the shop, or set FRONTEND_PUBLIC_URL.</p><p><a style="color:#e879f9" href="/api/portal/' + token + '">API JSON</a></p></body></html>')
  })

  console.log('[portal] SPA multi-page · tickets · quotes · PayFast · NPS')
}

module.exports = { mountPortal }
