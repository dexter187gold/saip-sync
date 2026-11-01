/**
 * WhatsApp Cloud API scaffold (Meta).
 * Env:
 *   WA_TOKEN / WHATSAPP_TOKEN
 *   WA_PHONE_NUMBER_ID
 *   WA_VERIFY_TOKEN (webhook challenge)
 * Never expose tokens to the SPA — only this server.
 */
function mountWaCloud(app, ctx = {}) {
  const { auth } = ctx
  const token = process.env.WA_TOKEN || process.env.WHATSAPP_TOKEN || ''
  const phoneId = process.env.WA_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || ''
  const verify = process.env.WA_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN || 'saip-wa-verify'
  const graph = process.env.WA_GRAPH_VERSION || 'v21.0'

  const statusHandler = (_req, res) => {
    res.json({
      ok: true,
      configured: !!(token && phoneId),
      phoneNumberId: phoneId ? String(phoneId).slice(0, 4) + '…' : '',
      graph,
    })
  }
  app.get('/api/wa/status', statusHandler)
  app.get('/api/whatsapp/status', statusHandler)

  // Meta webhook verification (wa + whatsapp aliases)
  const webhookGet = (req, res) => {
    const mode = req.query['hub.mode']
    const challenge = req.query['hub.challenge']
    const vt = req.query['hub.verify_token']
    if (mode === 'subscribe' && String(vt) === String(verify)) {
      return res.status(200).send(challenge)
    }
    res.status(403).send('Forbidden')
  }
  const webhookPost = (req, res) => {
    try {
      const body = req.body || {}
      if (body.object === 'whatsapp_business_account') {
        console.log('[wa-cloud] inbound', JSON.stringify(body).slice(0, 400))
      }
    } catch (e) {
      console.warn('[wa-cloud] webhook', e.message)
    }
    res.sendStatus(200)
  }
  app.get('/api/wa/webhook', webhookGet)
  app.get('/api/whatsapp/webhook', webhookGet)
  app.post('/api/wa/webhook', webhookPost)
  app.post('/api/whatsapp/webhook', webhookPost)

  async function sendText(to, body) {
    if (!token || !phoneId) {
      const err = new Error('WA Cloud not configured — set WA_TOKEN and WA_PHONE_NUMBER_ID')
      err.status = 503
      throw err
    }
    let digits = String(to || '').replace(/\D/g, '')
    if (digits.startsWith('0') && digits.length >= 9) digits = '27' + digits.slice(1)
    const url = `https://graph.facebook.com/${graph}/${phoneId}/messages`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: digits,
        type: 'text',
        text: { body: String(body || '').slice(0, 4096) },
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(data.error?.message || data.message || 'WA send failed')
      err.status = res.status
      err.data = data
      throw err
    }
    return data
  }

  const sendHandler = async (req, res) => {
    try {
      const to = req.body?.to || req.body?.phone
      const body = req.body?.body || req.body?.text || req.body?.message
      if (!to || !body) return res.status(400).json({ error: 'to and body required' })
      const data = await sendText(to, body)
      res.json({ ok: true, data })
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'send failed', details: e.data })
    }
  }
  const maybeAuth = auth || ((_, __, next) => next())
  app.post('/api/wa/send', maybeAuth, sendHandler)
  app.post('/api/whatsapp/send', maybeAuth, sendHandler)

  console.log('[wa-cloud] scaffold · configured=' + !!(token && phoneId))
}

module.exports = { mountWaCloud }
