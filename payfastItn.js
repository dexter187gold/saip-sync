/**
 * PayFast ITN — verify the signed notification with PayFast before posting.
 * Requires PAYFAST_MERCHANT_ID and PAYFAST_PASSPHRASE on the server.
 */
const crypto = require('crypto')

function encode(value) {
  return encodeURIComponent(String(value).trim()).replace(/%20/g, '+')
}

function buildItnParamString(body = {}) {
  return Object.keys(body)
    .filter((key) => key !== 'signature' && body[key] !== undefined && body[key] !== null && String(body[key]) !== '')
    .map((key) => key + '=' + encode(body[key]))
    .join('&')
}

function buildItnSignature(body = {}, passphrase = '') {
  let value = buildItnParamString(body)
  if (passphrase) value += '&passphrase=' + encode(passphrase)
  return crypto.createHash('md5').update(value, 'utf8').digest('hex')
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || '').toLowerCase(), 'utf8')
  const right = Buffer.from(String(b || '').toLowerCase(), 'utf8')
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function invoiceIdFromItn(body) {
  const raw = String(body.custom_str1 || body.m_payment_id || '').trim()
  return raw.startsWith('INV-') ? raw.slice(4) : raw
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100
}

function mountPayfastItn(app, ctx) {
  const { workspaces, persistWorkspaces, now = () => new Date().toISOString() } = ctx

  app.post('/api/payfast/itn', async (req, res) => {
    const body = req.body || {}
    const merchantId = String(process.env.PAYFAST_MERCHANT_ID || '').trim()
    const passphrase = String(process.env.PAYFAST_PASSPHRASE || '')
    const sandbox = String(process.env.PAYFAST_SANDBOX || '').toLowerCase() === 'true'
    if (!merchantId || !passphrase) {
      return res.status(503).send('PayFast server verification is not configured')
    }

    if (String(body.merchant_id || '').trim() !== merchantId) {
      return res.status(400).send('Invalid merchant')
    }
    if (!body.signature || !safeEqual(buildItnSignature(body, passphrase), body.signature)) {
      return res.status(400).send('Invalid ITN signature')
    }

    const pfPaymentId = String(body.pf_payment_id || '').trim()
    const paymentStatus = String(body.payment_status || '').toUpperCase()
    if (!pfPaymentId || !paymentStatus) return res.status(400).send('Missing payment identity or status')

    // PayFast requires merchants to confirm the notification with its server.
    const host = sandbox ? 'sandbox.payfast.co.za' : 'www.payfast.co.za'
    let validation
    try {
      const response = await fetch('https://' + host + '/eng/query/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildItnParamString(body),
        signal: AbortSignal.timeout(10000),
      })
      validation = (await response.text()).trim()
    } catch (error) {
      console.error('[payfast itn] server validation request failed:', error.message)
      return res.status(502).send('PayFast validation unavailable')
    }
    if (validation !== 'VALID') {
      console.warn('[payfast itn] PayFast rejected notification', pfPaymentId)
      return res.status(400).send('PayFast validation failed')
    }

    if (paymentStatus !== 'COMPLETE') {
      console.log('[payfast itn] verified non-complete status', paymentStatus, pfPaymentId)
      return res.status(200).send('OK')
    }

    const invoiceId = invoiceIdFromItn(body)
    const amount = roundMoney(body.amount_gross)
    if (!invoiceId || !pfPaymentId || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).send('Invalid invoice or amount')
    }

    let found = null
    for (const [uid, ws] of Object.entries(workspaces || {})) {
      const data = ws?.data || {}
      const duplicate = (data.payments || []).find((p) =>
        String(p.payfastPaymentId || p.providerPaymentId || '') === pfPaymentId
      )
      if (duplicate) {
        if (String(duplicate.invoiceId) === invoiceId) return res.status(200).send('OK')
        return res.status(409).send('Payment identity already used')
      }
      const invoices = data.invoices || []
      const idx = invoices.findIndex((i) => String(i.id) === invoiceId || String(i.number) === invoiceId)
      if (idx >= 0) {
        found = { uid, ws, data, idx, invoice: invoices[idx] }
        break
      }
    }

    if (!found) {
      console.warn('[payfast itn] verified payment references unknown invoice', invoiceId)
      return res.status(404).send('Invoice not found')
    }

    const inv = found.invoice
    const total = roundMoney(inv.total)
    const paid = roundMoney(Math.max(Number(inv.amountPaid) || 0, (found.data.payments || [])
      .filter((p) => String(p.invoiceId) === String(inv.id))
      .reduce((sum, p) => sum + (Number(p.amount) || 0), 0)))
    const due = roundMoney(Math.max(0, total - paid))
    if (amount - due > 0.01) {
      console.warn('[payfast itn] amount exceeds invoice balance', invoiceId, amount, due)
      return res.status(409).send('Payment exceeds invoice balance')
    }
    if (due <= 0.01) {
      console.warn('[payfast itn] invoice already settled with different payment identity', invoiceId)
      return res.status(409).send('Invoice already settled')
    }

    const timestamp = typeof now === 'function' ? now() : new Date().toISOString()
    const payment = {
      id: 'payfast-' + pfPaymentId,
      invoiceId: inv.id,
      clientId: inv.clientId,
      amount,
      method: 'PayFast',
      date: timestamp.slice(0, 10),
      reference: pfPaymentId,
      payfastPaymentId: pfPaymentId,
      idempotencyKey: 'payfast-' + pfPaymentId,
      createdAt: timestamp,
    }
    const nextPaid = roundMoney(paid + amount)
    const nextDue = roundMoney(Math.max(0, total - nextPaid))
    found.data.payments = [...(found.data.payments || []), payment]
    found.data.journal = [...(found.data.journal || []), {
      id: 'journal-payfast-' + pfPaymentId,
      date: payment.date,
      memo: 'PayFast payment · ' + (inv.number || inv.id),
      debitCode: '1000',
      creditCode: '1100',
      debit: amount,
      credit: amount,
      amount,
      autoPost: true,
      sourceKey: 'pay-' + payment.id,
      paymentId: payment.id,
      invoiceId: inv.id,
      clientId: inv.clientId,
      createdAt: timestamp,
    }]
    found.data.invoices[found.idx] = {
      ...inv,
      amountPaid: nextPaid,
      amountDue: nextDue,
      status: nextDue <= 0.01 ? 'paid' : 'partial',
      ...(nextDue <= 0.01 ? { paidAt: timestamp, paidDate: timestamp.slice(0, 10) } : {}),
      payfastPaymentId: pfPaymentId,
    }
    found.ws.version = (found.ws.version || 0) + 1
    found.ws.updated_at = timestamp
    if (typeof persistWorkspaces === 'function') persistWorkspaces()
    console.log('[payfast itn] verified and posted payment', pfPaymentId, invoiceId, amount)
    return res.status(200).send('OK')
  })

  console.log('[payfast] verified ITN /api/payfast/itn')
}

module.exports = { mountPayfastItn, buildItnParamString, buildItnSignature, invoiceIdFromItn }
