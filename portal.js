/**
 * Customer portal — invoices, quotes, approve/reject (P4).
 */
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')

function mountPortal(app, ctx) {
  const { workspaces, auth, PUBLIC_BASE, persistWorkspaces, DATA_DIR } = ctx
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
  }

  let portals = loadPortals()
  global.__saip_portals = portals

  function ownerWorkspace(userId) {
    return workspaces[userId]
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
    const url = (PUBLIC_BASE || '').replace(/\/$/, '') + '/p/' + token
    res.json({ ok: true, token, url, expires, clientId: String(clientId) })
  })

  app.get('/api/portal/list', auth, (req, res) => {
    const uid = req.user.id
    const base = (PUBLIC_BASE || '').replace(/\/$/, '')
    const list = Object.entries(portals)
      .filter(([, v]) => v.userId === uid)
      .map(([token, v]) => ({ token, ...v, url: base + '/p/' + token }))
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

  app.get('/api/portal/:token', (req, res) => {
    portals = loadPortals()
    const row = portals[req.params.token]
    if (!row) return res.status(404).json({ error: 'Invalid or expired portal link' })
    if (row.expires && new Date(row.expires) < new Date()) {
      delete portals[req.params.token]
      savePortals(portals)
      return res.status(410).json({ error: 'Portal link expired' })
    }
    const ws = ownerWorkspace(row.userId)
    const data = ws?.data || {}
    const client = (data.clients || []).find((c) => String(c.id) === String(row.clientId))
    const invoices = (data.invoices || []).filter((i) => String(i.clientId) === String(row.clientId))
    const quotes = (data.quotes || []).filter((q) => String(q.clientId) === String(row.clientId))
    const company = data.company && !Array.isArray(data.company) ? data.company : (data.company && data.company[0]) || {}
    res.json({
      ok: true,
      company: { name: company.name, phone: company.phone, email: company.email },
      client: client
        ? { id: client.id, name: client.name, company: client.company }
        : { id: row.clientId, name: 'Client' },
      invoices: invoices.map((i) => ({
        id: i.id, number: i.number, date: i.date, dueDate: i.dueDate,
        status: i.status, total: i.total, amountDue: i.amountDue ?? i.total,
      })),
      quotes: quotes.map((q) => ({
        id: q.id, number: q.number, date: q.date, status: q.status || 'sent', total: q.total,
        portalDecision: q.portalDecision || null, portalDecisionAt: q.portalDecisionAt || null,
      })),
      expires: row.expires,
    })
  })

  app.post('/api/portal/:token/quote/:quoteId/decision', (req, res) => {
    portals = loadPortals()
    const row = portals[req.params.token]
    if (!row) return res.status(404).json({ error: 'Invalid portal link' })
    if (row.expires && new Date(row.expires) < new Date()) {
      return res.status(410).json({ error: 'Portal link expired' })
    }
    const decision = String(req.body?.decision || '').toLowerCase()
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be approved or rejected' })
    }
    const reason = String(req.body?.reason || '').slice(0, 500)
    const ws = ownerWorkspace(row.userId)
    if (!ws?.data) return res.status(400).json({ error: 'Workspace missing' })
    const quotes = ws.data.quotes || []
    const idx = quotes.findIndex((q) => String(q.id) === String(req.params.quoteId))
    if (idx < 0) return res.status(404).json({ error: 'Quote not found' })
    const q = quotes[idx]
    if (String(q.clientId) !== String(row.clientId)) {
      return res.status(403).json({ error: 'Quote not in this portal' })
    }
    const ts = new Date().toISOString()
    quotes[idx] = {
      ...q,
      status: decision === 'approved' ? 'accepted' : 'rejected',
      portalDecision: decision,
      portalDecisionAt: ts,
      portalDecisionReason: reason || null,
    }
    ws.data.quotes = quotes
    ws.version = (ws.version || 0) + 1
    ws.updated_at = ts
    if (typeof persistWorkspaces === 'function') persistWorkspaces()
    res.json({ ok: true, quote: quotes[idx] })
  })

  app.get('/p/:token', (req, res) => {
    const token = String(req.params.token || '').replace(/[^a-f0-9]/gi, '')
    const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Client portal</title>
<style>
:root{--bg:#0f1419;--card:#1a2332;--text:#e7ecf3;--muted:#8b9bb4;--ok:#10b981;--bad:#ef4444}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);padding:16px}
.card{background:var(--card);border-radius:12px;padding:16px;margin-bottom:12px}
h1{font-size:1.25rem;margin:0 0 4px}h2{font-size:1rem;margin:0 0 10px}
.muted{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:8px;text-align:left;border-bottom:1px solid #2a3544}
.badge{font-size:11px;padding:2px 8px;border-radius:99px;background:#243044}
.err{color:#f87171}.row-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
button{appearance:none;border:0;border-radius:8px;padding:8px 12px;font:inherit;font-weight:600;cursor:pointer}
.btn-ok{background:var(--ok);color:#052e16}.btn-bad{background:var(--bad);color:#fff}
textarea{width:100%;padding:8px;border-radius:8px;border:1px solid #2a3544;background:#0f172a;color:var(--text);margin-top:6px}
</style></head><body>
<div id="app"><p class="muted">Loading…</p></div>
<script>
(async()=>{
  const el=document.getElementById('app');
  const token=${JSON.stringify(token)};
  async function load(){
    const r=await fetch('/api/portal/'+token);
    const j=await r.json();
    if(!r.ok) throw new Error(j.error||'Failed');
    const inv=(j.invoices||[]).map(i=>'<tr><td>'+(i.number||'')+'</td><td>'+(i.date||'')+'</td><td><span class="badge">'+(i.status||'')+'</span></td><td>R'+Number(i.amountDue!=null?i.amountDue:i.total||0).toFixed(2)+'</td></tr>').join('')||'<tr><td colspan="4" class="muted">No invoices</td></tr>';
    const quotes=(j.quotes||[]).map(q=>{
      const decided=q.portalDecision;
      const actions=decided
        ? '<span class="badge">'+decided+'</span>'
        : '<div class="row-actions"><button type="button" class="btn-ok" data-q="'+q.id+'" data-d="approved">Approve</button><button type="button" class="btn-bad" data-q="'+q.id+'" data-d="rejected">Reject</button></div><textarea id="reason-'+q.id+'" rows="2" placeholder="Optional reason"></textarea>';
      return '<div class="card" style="margin:0 0 10px"><strong>'+(q.number||'Quote')+'</strong> · R'+Number(q.total||0).toFixed(2)+' · <span class="badge">'+(q.status||'')+'</span><div class="muted">'+(q.date||'')+'</div>'+actions+'</div>';
    }).join('')||'<p class="muted">No quotes</p>';
    el.innerHTML='<div class="card"><h1>'+(j.company&&j.company.name||'Client portal')+'</h1><p class="muted">For '+(j.client&&j.client.name||'you')+'</p></div><div class="card"><h2>Quotes</h2>'+quotes+'</div><div class="card"><h2>Invoices</h2><table><thead><tr><th>Invoice</th><th>Date</th><th>Status</th><th>Balance</th></tr></thead><tbody>'+inv+'</tbody></table></div><p class="muted">SA Invoice Pro</p>';
    el.querySelectorAll('button[data-q]').forEach(btn=>{
      btn.addEventListener('click',async()=>{
        const id=btn.getAttribute('data-q');
        const decision=btn.getAttribute('data-d');
        const reason=(document.getElementById('reason-'+id)||{}).value||'';
        btn.disabled=true;
        try{
          const rr=await fetch('/api/portal/'+token+'/quote/'+id+'/decision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision:decision,reason:reason})});
          const jj=await rr.json();
          if(!rr.ok) throw new Error(jj.error||'Failed');
          await load();
        }catch(e){alert(e.message||'Error');btn.disabled=false;}
      });
    });
  }
  try{await load();}catch(e){el.innerHTML='<p class="err">'+(e.message||'Error')+'</p>';}
})();
</script></body></html>`
    res.type('html').send(html)
  })

  console.log('[portal] invoices + quote approve/reject')
}

module.exports = { mountPortal }
