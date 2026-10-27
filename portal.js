/**
 * Customer portal — invoices, quotes, approve/reject, PayFast, NPS feedback.
 * Paths used by hosted /p/:token UI AND SPA (/api/portal/view, /quote-decision).
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
    // SPA uses approve/reject; hosted UI uses approved/rejected
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

    // Decision log for desk pull
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
    portals[token] = {
      userId: uid,
      clientId: String(clientId),
      expires,
      createdAt: new Date().toISOString(),
    }
    savePortals(portals)
    const base = (PUBLIC_BASE || '').replace(/\/$/, '')
    // Prefer SPA portal path when FRONTEND_PUBLIC_URL set; else hosted /p/
    const spaOrigin = (process.env.FRONTEND_PUBLIC_URL || process.env.PORTAL_PUBLIC_URL || '').replace(/\/$/, '')
    const url = spaOrigin
      ? `${spaOrigin}/portal/${token}`
      : `${base}/p/${token}`
    res.json({ ok: true, token, url, expires, clientId: String(clientId) })
  })

  app.get('/api/portal/list', auth, (req, res) => {
    const uid = req.user.id
    const base = (PUBLIC_BASE || '').replace(/\/$/, '')
    const spaOrigin = (process.env.FRONTEND_PUBLIC_URL || process.env.PORTAL_PUBLIC_URL || '').replace(/\/$/, '')
    const list = Object.entries(portals)
      .filter(([, v]) => v.userId === uid)
      .map(([token, v]) => ({
        token,
        ...v,
        url: spaOrigin ? `${spaOrigin}/portal/${token}` : `${base}/p/${token}`,
      }))
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

  /** SPA + external clients */
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
    if (!token || !quoteId) {
      return res.status(400).json({ error: 'token and quoteId required' })
    }
    const result = applyDecision(token, quoteId, decision, note)
    if (result.error) {
      return res.status(result.status || 400).json({
        error: result.error,
        quote: result.quote || undefined,
      })
    }
    res.json({
      ok: true,
      quote: result.quote,
      status: result.quote.status,
      message:
        result.quote.status === 'accepted' ? 'Quote accepted' : 'Quote declined',
    })
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

  /** Original hosted API */
  app.get('/api/portal/:token', (req, res) => {
    // Avoid capturing /view /decisions /list as tokens
    const t = req.params.token
    if (['view', 'decisions', 'list', 'create', 'revoke', 'quote-decision', 'register'].includes(t)) {
      return res.status(404).json({ error: 'Not found' })
    }
    const resolved = resolveToken(t)
    if (resolved.error) return res.status(resolved.status || 404).json({ error: resolved.error })
    res.json(portalPayload(resolved.token, resolved.row))
  })

  app.post('/api/portal/:token/quote/:quoteId/decision', (req, res) => {
    const result = applyDecision(
      req.params.token,
      req.params.quoteId,
      req.body?.decision || req.body?.action,
      req.body?.reason || req.body?.note || '',
    )
    if (result.error) {
      return res.status(result.status || 400).json({ error: result.error })
    }
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
    ws.data.nps.unshift({
      id: 'nps-' + Date.now(),
      clientId: row.clientId,
      score,
      note,
      source: 'portal',
      at: new Date().toISOString(),
    })
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
    if (row.expires && new Date(row.expires) < new Date()) {
      return res.status(410).json({ error: 'Portal link expired' })
    }
    const ws = ownerWorkspace(row.userId)
    const data = ws?.data || {}
    const inv = (data.invoices || []).find((i) => String(i.id) === String(req.params.invoiceId))
    if (!inv || String(inv.clientId) !== String(row.clientId)) {
      return res.status(404).json({ error: 'Invoice not found' })
    }
    const settings = data.settings || {}
    const company =
      data.company && !Array.isArray(data.company)
        ? data.company
        : (data.company && data.company[0]) || {}
    const merchantId = process.env.PAYFAST_MERCHANT_ID || settings.payfastMerchantId || ''
    const merchantKey = process.env.PAYFAST_MERCHANT_KEY || settings.payfastMerchantKey || ''
    const passphrase = process.env.PAYFAST_PASSPHRASE || settings.payfastPassphrase || ''
    const sandbox = String(process.env.PAYFAST_SANDBOX || settings.payfastSandbox || 'true') !== 'false'
    const amount = Number(inv.amountDue != null ? inv.amountDue : inv.total != null ? inv.total : 0)
    if (!(amount > 0)) return res.status(400).json({ error: 'Nothing due on this invoice' })
    if (!merchantId || !merchantKey) {
      return res.json({
        ok: true,
        configured: false,
        amount,
        number: inv.number,
        message:
          'PayFast not configured. Pay via EFT using company banking details, or ask the shop to enable PayFast.',
        company: { name: company.name, email: company.email, phone: company.phone },
      })
    }
    const base = (PUBLIC_BASE || '').replace(/\/$/, '')
    const pf = {
      merchant_id: String(merchantId),
      merchant_key: String(merchantKey),
      return_url: base + '/p/' + req.params.token + '?paid=1',
      cancel_url: base + '/p/' + req.params.token + '?paid=0',
      amount: amount.toFixed(2),
      item_name: String(inv.number || inv.id).slice(0, 100),
      custom_str1: String(inv.id),
    }
    try {
      pf.signature = buildSignature(pf, passphrase)
    } catch (e) {
      console.warn('[portal] payfast sign', e.message)
    }
    res.json({
      ok: true,
      configured: true,
      sandbox,
      signed: !!pf.signature,
      processUrl: sandbox
        ? 'https://sandbox.payfast.co.za/eng/process'
        : 'https://www.payfast.co.za/eng/process',
      fields: pf,
    })
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
textarea,input[type=text]{width:100%;padding:8px;border-radius:8px;border:1px solid #2a3544;background:#0f172a;color:var(--text);margin-top:6px}
input[type=range]{width:100%}
</style></head><body>
<div id="app"><p class="muted">Loading…</p></div>
<script>
(async()=>{
  const el=document.getElementById('app');
  const token=${JSON.stringify(token)};
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(ch){return ch==='&'?'&amp;':ch==='<'?'&lt;':ch==='>'?'&gt;':ch==='"'?'&quot;':'&#39;'})}
  function showError(message){
    el.replaceChildren();
    const box=document.createElement('div');box.className='card';
    const heading=document.createElement('h1');heading.textContent='We could not load your account';box.appendChild(heading);
    const detail=document.createElement('p');detail.className='err';detail.textContent=message||'The portal could not connect to the server.';box.appendChild(detail);
    const retry=document.createElement('button');retry.type='button';retry.className='btn-ok';retry.textContent='Try again';retry.onclick=()=>{el.innerHTML='<p class="muted">Loading your account…</p>';load().catch(showError)};box.appendChild(retry);
    const help=document.createElement('p');help.className='muted';help.textContent='If this keeps happening, contact the business that sent you this link.';box.appendChild(help);el.appendChild(box);
  }
  async function load(){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),12000);
    let r, j;
    try {
      r=await fetch('/api/portal/'+token,{signal:controller.signal,cache:'no-store'});
      j=await r.json().catch(()=>({error:'The server returned an invalid response.'}));
    } catch(e){ if(e&&e.name==='AbortError') throw new Error('The server took too long to respond. Please try again in a moment.'); throw new Error('Could not connect to the portal server. Check your connection and try again.'); }
    finally { clearTimeout(timeout); }
    if(!r.ok) throw new Error(j.error||'Failed');
    const inv=(j.invoices||[]).map(i=>'<tr><td>'+esc(i.number||'')+'</td><td>'+esc(i.date||'')+'</td><td><span class="badge">'+esc(i.status||'')+'</span></td><td>R'+Number(i.amountDue!=null?i.amountDue:i.total||0).toFixed(2)+'</td><td><button type="button" class="btn-ok" data-pay="'+esc(i.id)+'">Pay</button></td></tr>').join('')||'<tr><td colspan="5" class="muted">No invoices</td></tr>';
    const quotes=(j.quotes||[]).map(q=>{
      const decided=q.portalDecision;
      const actions=decided
        ? '<span class="badge">'+esc(decided)+'</span>'
        : '<div class="row-actions"><button type="button" class="btn-ok" data-q="'+esc(q.id)+'" data-d="approved">Approve</button><button type="button" class="btn-bad" data-q="'+esc(q.id)+'" data-d="rejected">Reject</button></div><textarea id="reason-'+esc(q.id)+'" rows="2" placeholder="Optional reason"></textarea>';
      return '<div class="card" style="margin:0 0 10px"><strong>'+esc(q.number||'Quote')+'</strong> · R'+Number(q.total||0).toFixed(2)+' · <span class="badge">'+esc(q.status||'')+'</span><div class="muted">'+esc(q.date||'')+'</div>'+actions+'</div>';
    }).join('')||'<p class="muted">No quotes</p>';
    el.innerHTML='<div class="card"><h1>'+esc(j.company&&j.company.name||'Client portal')+'</h1><p class="muted">For '+esc(j.client&&j.client.name||'you')+'</p></div><div class="card"><h2>Quotes</h2>'+quotes+'</div><div class="card"><h2>Invoices</h2><table><thead><tr><th>Invoice</th><th>Date</th><th>Status</th><th>Balance</th><th></th></tr></thead><tbody>'+inv+'</tbody></table></div><div class="card" id="fb-card"><h2>Rate this service</h2><p class="muted">0–10 · helps us improve</p><input id="fb-score" type="range" min="0" max="10" value="9"/><div style="font-weight:700;margin:8px 0" id="fb-val">9</div><input id="fb-note" type="text" placeholder="Optional note"/><button type="button" id="fb-send" class="btn-ok" style="margin-top:10px">Send feedback</button><p id="fb-msg" class="muted"></p></div><p class="muted">SA Invoice Pro</p>';
    var sc=document.getElementById('fb-score');if(sc){sc.oninput=function(){document.getElementById('fb-val').textContent=sc.value};}
    var btn=document.getElementById('fb-send');if(btn){btn.onclick=async function(){try{var rr=await fetch('/api/portal/'+token+'/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({score:Number(sc&&sc.value||0),note:(document.getElementById('fb-note')||{}).value||''})});var bb=await rr.json().catch(function(){return{}});document.getElementById('fb-msg').textContent=rr.ok?('Thanks — score '+bb.score):(bb.error||'Failed');}catch(e){document.getElementById('fb-msg').textContent=e.message||'Error';}};}
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
    el.querySelectorAll('button[data-pay]').forEach(btn=>{
      btn.addEventListener('click',async()=>{
        btn.disabled=true;
        try{
          const rr=await fetch('/api/portal/'+token+'/pay/'+btn.getAttribute('data-pay'));
          const jj=await rr.json();
          if(!rr.ok) throw new Error(jj.error||'Failed');
          if(!jj.configured){alert(jj.message||'PayFast not configured');btn.disabled=false;return;}
          const form=document.createElement('form');
          form.method='POST';form.action=jj.processUrl;
          Object.keys(jj.fields||{}).forEach(k=>{
            const inp=document.createElement('input');inp.type='hidden';inp.name=k;inp.value=jj.fields[k];form.appendChild(inp);
          });
          document.body.appendChild(form);form.submit();
        }catch(e){alert(e.message||'Error');btn.disabled=false;}
      });
    });
  }
  try{await load();}catch(e){showError(e&&e.message||'The portal could not be loaded.')}
})();
</script></body></html>`
    res.type('html').send(html)
  })

  console.log('[portal] SPA aliases · quotes · PayFast · invoices · NPS · git persist')
}

module.exports = { mountPortal }
