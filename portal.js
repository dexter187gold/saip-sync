/**
 * Customer portal — public invoice view + create links.
 */
const crypto = require('crypto')

function mountPortal(app, ctx) {
  const { workspaces, auth, PUBLIC_BASE } = ctx
  const portals = global.__saip_portals || (global.__saip_portals = {})

  app.post('/api/portal/create', auth, (req, res) => {
    const { clientId, days = 90 } = req.body || {}
    if (!clientId) return res.status(400).json({ error: 'clientId required' })
    const uid = req.user.id
    const ws = workspaces[uid]
    if (!ws?.data) return res.status(400).json({ error: 'Push workspace first' })
    const token = crypto.randomBytes(24).toString('hex')
    const expires = new Date(Date.now() + (Number(days) || 90) * 86400000).toISOString()
    portals[token] = { userId: uid, clientId: String(clientId), expires, createdAt: new Date().toISOString() }
    const url = `${PUBLIC_BASE}/p/${token}`
    res.json({ ok: true, token, url, expires, clientId: String(clientId) })
  })

  app.get('/api/portal/list', auth, (req, res) => {
    const uid = req.user.id
    const list = Object.entries(portals)
      .filter(([, v]) => v.userId === uid)
      .map(([token, v]) => ({ token, ...v, url: `${PUBLIC_BASE}/p/${token}` }))
    res.json({ ok: true, portals: list })
  })

  app.post('/api/portal/revoke', auth, (req, res) => {
    const { token } = req.body || {}
    if (token && portals[token]?.userId === req.user.id) delete portals[token]
    res.json({ ok: true })
  })

  app.get('/api/portal/:token', (req, res) => {
    const row = portals[req.params.token]
    if (!row) return res.status(404).json({ error: 'Invalid or expired portal link' })
    if (row.expires && new Date(row.expires) < new Date()) {
      delete portals[req.params.token]
      return res.status(410).json({ error: 'Portal link expired' })
    }
    const ws = workspaces[row.userId]
    if (!ws?.data) return res.status(404).json({ error: 'Workspace unavailable' })
    const data = ws.data
    const clients = data.clients || []
    const client = (Array.isArray(clients) ? clients : []).find((c) => String(c.id) === String(row.clientId))
    const invoices = (data.invoices || []).filter((i) => String(i.clientId) === String(row.clientId))
    const company = data.company || {}
    res.json({
      ok: true,
      company: { name: company.name, phone: company.phone, email: company.email },
      client: client ? { id: client.id, name: client.name, company: client.company } : { id: row.clientId, name: 'Client' },
      invoices: invoices.map((i) => ({
        id: i.id, number: i.number, date: i.date, dueDate: i.dueDate,
        status: i.status, total: i.total, amountDue: i.amountDue ?? i.total,
      })),
      expires: row.expires,
    })
  })

  app.get('/p/:token', (req, res) => {
    const token = req.params.token
    res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Client portal</title>
<style>
:root{--bg:#0f1419;--card:#1a2332;--text:#e7ecf3;--muted:#8b9bb4}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);padding:16px}
.card{background:var(--card);border-radius:12px;padding:16px;margin-bottom:12px}
h1{font-size:1.25rem;margin:0 0 4px}.muted{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:8px;text-align:left;border-bottom:1px solid #2a3544}
.badge{font-size:11px;padding:2px 8px;border-radius:99px;background:#243044}.err{color:#f87171}
</style></head><body>
<div id="app"><p class="muted">Loading…</p></div>
<script>
(async()=>{
  const el=document.getElementById('app');
  try{
    const r=await fetch('/api/portal/${token}');
    const j=await r.json();
    if(!r.ok) throw new Error(j.error||'Failed');
    const inv=(j.invoices||[]).map(i=>'<tr><td>'+(i.number||'')+'</td><td>'+(i.date||'')+'</td><td><span class="badge">'+(i.status||'')+'</span></td><td>R'+Number(i.amountDue??i.total||0).toFixed(2)+'</td></tr>').join('')||'<tr><td colspan="4" class="muted">No invoices</td></tr>';
    el.innerHTML='<div class="card"><h1>'+(j.company&&j.company.name||'Client portal')+'</h1><p class="muted">For '+(j.client&&j.client.name||'you')+'</p></div><div class="card"><table><thead><tr><th>Invoice</th><th>Date</th><th>Status</th><th>Balance</th></tr></thead><tbody>'+inv+'</tbody></table></div><p class="muted">SA Invoice Pro</p>';
  }catch(e){el.innerHTML='<p class="err">'+(e.message||'Error')+'</p>';}
})();
</script></body></html>`)
  })

  console.log('[portal] customer portal mounted')
}

module.exports = { mountPortal }
