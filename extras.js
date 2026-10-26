const crypto = require('crypto')

function mountExtras(app, ctx) {
  const { workspaces, persistWorkspaces, auth, PUBLIC_BASE } = ctx
  const devices = global.__saip_devices || (global.__saip_devices = {})

  app.post('/api/sms/send', auth, async (req, res) => {
    const { to, message, from, provider, apiKey, username } = req.body || {}
    if (!to || !message) return res.status(400).json({ error: 'to and message required' })
    const key = apiKey || process.env.SMS_API_KEY
    const user = username || process.env.SMS_USERNAME
    const sender = from || process.env.SMS_FROM || ''
    const prov = provider || process.env.SMS_PROVIDER || 'africastalking'
    try {
      if (prov === 'africastalking') {
        if (!key || !user) return res.status(400).json({ error: 'SMS credentials missing (apiKey + username or env)' })
        const form = new URLSearchParams()
        form.set('username', user)
        form.set('to', String(to).startsWith('+') ? String(to) : '+' + String(to))
        form.set('message', String(message).slice(0, 480))
        if (sender) form.set('from', sender)
        const r = await fetch('https://api.africastalking.com/version1/messaging', {
          method: 'POST',
          headers: { Accept: 'application/json', apiKey: key, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        })
        const text = await r.text()
        if (!r.ok) return res.status(502).json({ error: 'Upstream SMS failed', detail: text.slice(0, 300) })
        return res.json({ ok: true, provider: 'africastalking' })
      }
      if (prov === 'clickatell') {
        if (!key) return res.status(400).json({ error: 'Clickatell API key missing' })
        const r = await fetch('https://platform.clickatell.com/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: key },
          body: JSON.stringify({ content: String(message).slice(0, 480), to: [String(to).replace(/\D/g, '')], from: sender || undefined }),
        })
        if (!r.ok) return res.status(502).json({ error: 'Clickatell failed' })
        return res.json({ ok: true, provider: 'clickatell' })
      }
      return res.status(400).json({ error: 'Unknown provider' })
    } catch (e) {
      return res.status(500).json({ error: e.message || 'SMS send error' })
    }
  })

  app.post('/api/device/register', auth, (req, res) => {
    const { fingerprint, label, userAgent, platform } = req.body || {}
    if (!fingerprint) return res.status(400).json({ error: 'fingerprint required' })
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim()
    const id = require('crypto').createHash('sha256').update(req.user.id + ':' + fingerprint).digest('hex').slice(0, 32)
    devices[id] = {
      id,
      userId: req.user.id,
      fingerprint: String(fingerprint).slice(0, 128),
      label: String(label || platform || 'Device').slice(0, 80),
      userAgent: String(userAgent || '').slice(0, 200),
      platform: String(platform || '').slice(0, 40),
      ip,
      boundAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    }
    res.json({
      ok: true,
      device: devices[id],
      note: 'Browsers cannot read MAC addresses. We bind fingerprint + IP to your account for activation.',
    })
  })

  app.get('/api/device/list', auth, (req, res) => {
    res.json({ ok: true, devices: Object.values(devices).filter((d) => d.userId === req.user.id) })
  })

  app.post('/api/device/heartbeat', auth, (req, res) => {
    const { fingerprint } = req.body || {}
    const id = require('crypto').createHash('sha256').update(req.user.id + ':' + String(fingerprint || '')).digest('hex').slice(0, 32)
    if (devices[id]) {
      devices[id].lastSeen = new Date().toISOString()
      devices[id].ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim()
    }
    res.json({ ok: true, known: !!devices[id] })
  })

  app.get('/api/workspace/branch/:branchId', auth, (req, res) => {
    const key = req.user.id + '::' + String(req.params.branchId)
    const row = workspaces[key]
    if (!row) return res.status(404).json({ error: 'No branch workspace' })
    res.json({ ok: true, version: row.version, updated_at: row.updated_at, data: row.data, branchId: req.params.branchId })
  })

  app.put('/api/workspace/branch/:branchId', auth, (req, res) => {
    const { data } = req.body || {}
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data object required' })
    const key = req.user.id + '::' + String(req.params.branchId)
    const current = workspaces[key] || { version: 0 }
    const newVersion = (current.version || 0) + 1
    const ts = new Date().toISOString()
    workspaces[key] = { data, version: newVersion, updated_at: ts, branchId: req.params.branchId, parentUserId: req.user.id }
    if (typeof persistWorkspaces === 'function') persistWorkspaces()
    res.json({ ok: true, version: newVersion, updated_at: ts, branchId: req.params.branchId })
  })

  app.get('/api/wa/ticket-link', auth, (req, res) => {
    const ticketId = req.query.ticketId
    const base = String(req.query.appBase || process.env.APP_PUBLIC_URL || 'https://sa-invoice-pro.pcrepairdex.workers.dev').replace(/\/$/, '')
    if (!ticketId) return res.status(400).json({ error: 'ticketId required' })
    const path = `/tickets?open=${encodeURIComponent(ticketId)}`
    res.json({ ok: true, appUrl: base + path, waText: `Open job card: ${base}${path}` })
  })

  console.log('[extras] SMS · device · branch WS · WA links')
}

module.exports = { mountExtras }
