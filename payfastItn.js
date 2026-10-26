/**
 * PayFast ITN — mark invoice paid in workspace.
 */
function mountPayfastItn(app, ctx) {
  const { workspaces, persistWorkspaces, now } = ctx

  app.post('/api/payfast/itn', (req, res) => {
    const body = req.body || {}
    const paymentStatus = String(body.payment_status || '')
    const invoiceId = String(body.custom_str1 || body.m_payment_id || '')
    const amount = Number(body.amount_gross || 0)

    let found = null
    for (const [uid, ws] of Object.entries(workspaces || {})) {
      const invs = ws?.data?.invoices || []
      const idx = invs.findIndex((i) => String(i.id) === invoiceId || String(i.number) === invoiceId)
      if (idx >= 0) {
        found = { uid, ws, idx, inv: invs[idx] }
        break
      }
    }

    if (found && paymentStatus === 'COMPLETE') {
      const inv = found.inv
      const total = Number(inv.total || 0)
      const paid = Math.max(Number(inv.amountPaid || 0), amount || total)
      const ts = typeof now === 'function' ? now() : new Date().toISOString()
      found.ws.data.invoices[found.idx] = {
        ...inv,
        amountPaid: paid,
        amountDue: Math.max(0, total - paid),
        status: paid >= total - 0.02 ? 'paid' : 'partial',
        paidAt: ts,
        payfastPaymentId: body.pf_payment_id || null,
      }
      found.ws.version = (found.ws.version || 0) + 1
      found.ws.updated_at = ts
      if (typeof persistWorkspaces === 'function') persistWorkspaces()
      console.log('[payfast itn] marked paid', invoiceId)
    } else {
      console.log('[payfast itn]', paymentStatus, invoiceId || 'no-id')
    }
    res.status(200).send('OK')
  })

  console.log('[payfast] ITN /api/payfast/itn')
}

module.exports = { mountPayfastItn }
