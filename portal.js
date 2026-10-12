/**
 * Client Portal – secure per-client links + print/PDF
 */
const crypto = require('crypto');
const path = require('path');

function moneyR(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'R0.00';
  return 'R' + v.toFixed(2);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"');
}

function statusBadge(st) {
  const s = String(st || '—').toLowerCase();
  let bg = '#64748b';
  if (s === 'paid' || s === 'closed' || s === 'resolved' || s === 'accepted') bg = '#007A4D';
  else if (s === 'overdue' || s === 'cancelled') bg = '#dc2626';
  else if (s === 'partial' || s === 'open' || s === 'in_progress') bg = '#d97706';
  return `<span class="badge" style="background:${bg}">${esc(st || '—')}</span>`;
}

function tableRows(rows, cols) {
  if (!rows.length) return `<tr><td colspan="${cols.length}" class="empty">None</td></tr>`;
  return rows.map((r) => '<tr>' + cols.map((c) => `<td>${c(r)}</td>`).join('') + '</tr>').join('');
}

function renderPortalPage({ companyName, client, invoices, quotes, tickets, payments, portalMeta, token }) {
  const openInv = invoices.filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()));
  const ar = openInv.reduce((s, i) => s + (Number(i.amountDue ?? i.total) || 0), 0);
  const paidTotal = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const openTickets = tickets.filter((t) => !['closed', 'resolved', 'cancelled'].includes(String(t.status || '').toLowerCase()));
  const pdfUrl = `/portal/${token}/statement.pdf`;
  const printUrl = `/portal/${token}/print`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Account · ${esc(client.name)} · ${esc(companyName)}</title>
<style>
:root { --green:#007A4D; --card:#fff; --muted:#64748b; --border:#e2e8f0; }
* { box-sizing: border-box; }
body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: linear-gradient(160deg,#0f172a 0%,#0b3d2e 100%); min-height:100vh; color:#0f172a; }
.wrap { max-width: 960px; margin: 0 auto; padding: 20px 16px 48px; }
.hero { background: var(--green); color:#fff; border-radius: 16px; padding: 22px 20px; margin-bottom: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.25); }
.hero h1 { margin: 0 0 6px; font-size: 1.35rem; }
.hero p { margin: 0; opacity: .92; font-size: .92rem; }
.actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; }
.actions a, .actions button { display:inline-block; background:rgba(255,255,255,.2); color:#fff; border:1px solid rgba(255,255,255,.4); border-radius:10px; padding:10px 14px; font-weight:700; font-size:13px; text-decoration:none; cursor:pointer; }
.actions a:hover, .actions button:hover { background:rgba(255,255,255,.3); }
.grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(140px,1fr)); gap: 10px; margin-bottom: 16px; }
.stat { background: var(--card); border-radius: 12px; padding: 14px; box-shadow: 0 4px 16px rgba(0,0,0,.12); }
.stat .l { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.stat .v { font-size: 1.2rem; font-weight: 700; margin-top: 4px; }
.card { background: var(--card); border-radius: 14px; padding: 16px; margin-bottom: 14px; box-shadow: 0 4px 16px rgba(0,0,0,.12); }
.card h2 { margin: 0 0 12px; font-size: 1.05rem; }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.tabs button { border: 1px solid var(--border); background: #f8fafc; border-radius: 999px; padding: 8px 14px; font-weight: 600; cursor: pointer; font-size: 13px; }
.tabs button.active { background: var(--green); color:#fff; border-color: var(--green); }
.panel { display: none; }
.panel.active { display: block; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
.badge { display: inline-block; color:#fff; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 999px; }
.empty { color: var(--muted); text-align: center; padding: 18px !important; }
.foot { text-align: center; color: rgba(255,255,255,.75); font-size: 12px; margin-top: 18px; }
.meta { font-size: 12px; color: var(--muted); margin-top: 8px; }
@media (max-width: 600px) { th:nth-child(3), td:nth-child(3) { display: none; } }
@media print {
  body { background: #fff; }
  .wrap { max-width: 100%; padding: 0; }
  .hero { box-shadow: none; border-radius: 0; }
  .actions, .tabs, .foot { display: none !important; }
  .panel { display: block !important; page-break-inside: avoid; }
  .card { box-shadow: none; border: 1px solid #ddd; }
}
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <h1>${esc(client.name)}</h1>
    <p>${esc(companyName)} · Client account portal</p>
    <p style="margin-top:8px;font-size:13px">${[client.email, client.phone, client.company].filter(Boolean).map(esc).join(' · ') || 'Verified client access'}</p>
    <div class="actions">
      <button type="button" onclick="window.print()">🖨 Print / Save PDF</button>
      <a href="${printUrl}" target="_blank" rel="noopener">Full statement print</a>
      <a href="${pdfUrl}">⬇ Statement file</a>
    </div>
  </div>

  <div class="grid">
    <div class="stat"><div class="l">Outstanding</div><div class="v">${moneyR(ar)}</div></div>
    <div class="stat"><div class="l">Open invoices</div><div class="v">${openInv.length}</div></div>
    <div class="stat"><div class="l">Payments logged</div><div class="v">${moneyR(paidTotal)}</div></div>
    <div class="stat"><div class="l">Open jobs</div><div class="v">${openTickets.length}</div></div>
    <div class="stat"><div class="l">Quotes</div><div class="v">${quotes.length}</div></div>
    <div class="stat"><div class="l">All invoices</div><div class="v">${invoices.length}</div></div>
  </div>

  <div class="card">
    <div class="tabs" role="tablist">
      <button type="button" class="active" data-tab="inv">Invoices</button>
      <button type="button" data-tab="quotes">Quotes</button>
      <button type="button" data-tab="jobs">Job cards</button>
      <button type="button" data-tab="pay">Payments</button>
      <button type="button" data-tab="summary">Summary</button>
    </div>

    <div id="inv" class="panel active">
      <h2>Invoices</h2>
      <table>
        <thead><tr><th>Number</th><th>Date</th><th>Due</th><th>Status</th><th>Total</th><th>Balance</th></tr></thead>
        <tbody>
          ${tableRows(invoices, [
            (r) => esc(r.number || r.id),
            (r) => esc(String(r.date || '').slice(0, 10)),
            (r) => esc(String(r.dueDate || '').slice(0, 10)),
            (r) => statusBadge(r.status),
            (r) => moneyR(r.total),
            (r) => moneyR(r.amountDue ?? r.total),
          ])}
        </tbody>
      </table>
    </div>

    <div id="quotes" class="panel">
      <h2>Quotes</h2>
      <table>
        <thead><tr><th>Number</th><th>Date</th><th>Status</th><th>Total</th></tr></thead>
        <tbody>
          ${tableRows(quotes, [
            (r) => esc(r.number || r.id),
            (r) => esc(String(r.date || r.createdAt || '').slice(0, 10)),
            (r) => statusBadge(r.status || 'draft'),
            (r) => moneyR(r.total),
          ])}
        </tbody>
      </table>
    </div>

    <div id="jobs" class="panel">
      <h2>Job cards</h2>
      <table>
        <thead><tr><th>Ref</th><th>Device</th><th>Issue</th><th>Status</th><th>Updated</th></tr></thead>
        <tbody>
          ${tableRows(tickets, [
            (r) => esc(r.number || (r.id && String(r.id).slice(0, 8)) || '—'),
            (r) => esc(r.device || r.title || '—'),
            (r) => esc(String(r.issue || r.description || '').slice(0, 80)),
            (r) => statusBadge(r.status),
            (r) => esc(String(r.updatedAt || r.createdAt || '').slice(0, 10)),
          ])}
        </tbody>
      </table>
    </div>

    <div id="pay" class="panel">
      <h2>Payments</h2>
      <table>
        <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Reference</th></tr></thead>
        <tbody>
          ${tableRows(payments, [
            (r) => esc(String(r.date || '').slice(0, 10)),
            (r) => moneyR(r.amount),
            (r) => esc(r.method || '—'),
            (r) => esc(r.reference || '—'),
          ])}
        </tbody>
      </table>
    </div>

    <div id="summary" class="panel">
      <h2>Account summary</h2>
      <p><strong>Outstanding AR:</strong> ${moneyR(ar)}</p>
      <p><strong>Payments received (logged):</strong> ${moneyR(paidTotal)}</p>
      <p><strong>Open job cards:</strong> ${openTickets.length}</p>
      <p><strong>Active quotes:</strong> ${quotes.filter((q) => String(q.status || '').toLowerCase() !== 'rejected').length}</p>
      <p class="meta">This portal is private. Do not share your link. Use Print / Save PDF for a local copy.</p>
    </div>
  </div>

  <p class="foot">
    Secure client portal · ${esc(companyName)}<br/>
    Link ${portalMeta.expires ? 'expires ' + esc(String(portalMeta.expires).slice(0, 10)) : 'active'} · SA Invoice Pro
  </p>
</div>
<script>
document.querySelectorAll('.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.getAttribute('data-tab'))?.classList.add('active');
  });
});
</script>
</body>
</html>`;
}

function renderPrintStatement({ companyName, client, invoices, payments }) {
  const openInv = invoices.filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()));
  const ar = openInv.reduce((s, i) => s + (Number(i.amountDue ?? i.total) || 0), 0);
  const rows = openInv.map((r) =>
    `<tr><td>${esc(r.number || r.id)}</td><td>${esc(String(r.dueDate || r.date || '').slice(0, 10))}</td><td>${esc(r.status)}</td><td>${moneyR(r.amountDue ?? r.total)}</td></tr>`
  ).join('') || '<tr><td colspan="4">No outstanding invoices</td></tr>';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Statement · ${esc(client.name)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:800px;margin:24px auto;padding:0 16px;color:#111}
h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.1rem;margin:20px 0 8px}
.muted{color:#64748b;font-size:13px}table{width:100%;border-collapse:collapse;margin-top:8px}
th,td{border-bottom:1px solid #e2e8f0;padding:8px;text-align:left;font-size:13px}
.total{font-size:1.2rem;font-weight:700;margin-top:16px}
@media print{body{margin:0}}
</style></head><body onload="setTimeout(function(){window.print()},400)">
<h1>Account statement</h1>
<p class="muted">${esc(companyName)} · ${new Date().toISOString().slice(0, 10)}</p>
<p><strong>${esc(client.name)}</strong><br/>${[client.email, client.phone].filter(Boolean).map(esc).join(' · ')}</p>
<h2>Outstanding invoices</h2>
<table><thead><tr><th>Invoice</th><th>Due</th><th>Status</th><th>Balance</th></tr></thead>
<tbody>${rows}</tbody></table>
<p class="total">Total outstanding: ${moneyR(ar)}</p>
<p class="muted">Generated from your secure client portal. Use browser Print → Save as PDF.</p>
</body></html>`;
}

/** Minimal PDF (text-based) without external deps */
function buildSimplePdf({ companyName, client, invoices }) {
  const openInv = invoices.filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()));
  const ar = openInv.reduce((s, i) => s + (Number(i.amountDue ?? i.total) || 0), 0);
  const lines = [
    `Account statement — ${companyName}`,
    `Client: ${client.name || ''}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    '',
    'Outstanding invoices:',
  ];
  for (const inv of openInv) {
    lines.push(`${inv.number || inv.id} | ${String(inv.dueDate || inv.date || '').slice(0, 10)} | ${inv.status} | ${moneyR(inv.amountDue ?? inv.total)}`);
  }
  if (!openInv.length) lines.push('None');
  lines.push('', `Total outstanding: ${moneyR(ar)}`);
  const content = lines.join('\n');

  // Very small valid PDF with one page of text
  const escaped = content.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 10 Tf 40 750 Td 14 TL (${escaped.split('\n').map((l) => l.slice(0, 90)).join(') Tj T* (')}) Tj ET`;
  const objs = [];
  objs.push('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n');
  objs.push('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n');
  objs.push('3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n');
  objs.push(`4 0 obj<< /Length ${stream.length} >>stream\n${stream}\nendstream\nendobj\n`);
  objs.push('5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n');
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const o of objs) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += o;
  }
  const xrefStart = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

function mountPortal(app, ctx) {
  const { DATA_DIR, loadJson, saveJson, workspaces, auth, PUBLIC_BASE, now } = ctx;
  const PORTALS_FILE = path.join(DATA_DIR, 'portals.json');
  let portals = loadJson(PORTALS_FILE, {});

  function persistPortals() {
    saveJson(PORTALS_FILE, portals);
  }

  function buildClientSnapshot(ownerUserId, clientId) {
    const ws = workspaces[ownerUserId]?.data || {};
    const clients = ws.clients || [];
    const client = clients.find((c) => String(c.id) === String(clientId));
    if (!client) return null;
    const invoices = (ws.invoices || []).filter((i) => String(i.clientId) === String(clientId))
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const quotes = (ws.quotes || []).filter((q) => String(q.clientId) === String(clientId))
      .sort((a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || '')));
    const tickets = (ws.tickets || []).filter((t) => String(t.clientId) === String(clientId))
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    const invIds = new Set(invoices.map((i) => String(i.id)));
    const payments = (ws.payments || []).filter((p) =>
      String(p.clientId) === String(clientId) || invIds.has(String(p.invoiceId))
    ).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const companyName = ws.company?.name || 'SA Invoice Pro';
    return { client, invoices, quotes, tickets, payments, companyName };
  }

  function resolvePortal(token) {
    const rec = portals[token];
    if (!rec || rec.revoked) return { error: 'invalid', status: 404 };
    if (rec.expires && new Date(rec.expires) < new Date()) return { error: 'expired', status: 410 };
    const snap = buildClientSnapshot(rec.owner_user_id, rec.client_id);
    if (!snap) return { error: 'no_data', status: 404 };
    return { rec, snap };
  }

  app.post('/api/portal/create', auth, (req, res) => {
    const clientId = req.body?.client_id || req.body?.clientId;
    if (!clientId) return res.status(400).json({ error: 'client_id required' });
    const snap = buildClientSnapshot(req.user.id, clientId);
    if (!snap) return res.status(404).json({ error: 'Client not found in synced workspace. Push cloud data first.' });

    const days = Math.min(365, Math.max(1, Number(req.body?.days) || 90));
    const token = crypto.randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    for (const rec of Object.values(portals)) {
      if (rec.owner_user_id === req.user.id && String(rec.client_id) === String(clientId) && !rec.revoked) {
        rec.revoked = true;
        rec.revoked_at = now();
      }
    }

    portals[token] = {
      token,
      owner_user_id: req.user.id,
      client_id: clientId,
      client_name: snap.client.name,
      client_phone: snap.client.phone || null,
      created_at: now(),
      expires,
      revoked: false,
      views: 0,
    };
    persistPortals();
    res.json({ ok: true, url: `${PUBLIC_BASE}/portal/${token}`, token, expires, client_name: snap.client.name });
  });

  app.post('/api/portal/revoke', auth, (req, res) => {
    const token = req.body?.token;
    if (!token || !portals[token]) return res.status(404).json({ error: 'Not found' });
    if (portals[token].owner_user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    portals[token].revoked = true;
    portals[token].revoked_at = now();
    persistPortals();
    res.json({ ok: true });
  });

  app.get('/api/portal/list', auth, (req, res) => {
    const list = Object.values(portals)
      .filter((p) => p.owner_user_id === req.user.id && !p.revoked)
      .map((p) => ({
        token: p.token,
        url: `${PUBLIC_BASE}/portal/${p.token}`,
        client_id: p.client_id,
        client_name: p.client_name,
        expires: p.expires,
        views: p.views || 0,
        created_at: p.created_at,
      }));
    res.json({ ok: true, count: list.length, portals: list });
  });

  app.get('/portal/:token', (req, res) => {
    const r = resolvePortal(req.params.token);
    if (r.error) {
      const msg = r.error === 'expired'
        ? '<h1>Link expired</h1><p>Ask the business for a new account link.</p>'
        : '<h1>Link invalid</h1><p>This portal link was revoked or does not exist.</p>';
      return res.status(r.status).type('html').send(msg);
    }
    r.rec.views = (r.rec.views || 0) + 1;
    r.rec.last_viewed_at = now();
    persistPortals();
    res.type('html').send(renderPortalPage({
      companyName: r.snap.companyName,
      client: r.snap.client,
      invoices: r.snap.invoices,
      quotes: r.snap.quotes,
      tickets: r.snap.tickets,
      payments: r.snap.payments,
      portalMeta: { expires: r.rec.expires },
      token: req.params.token,
    }));
  });

  app.get('/portal/:token/print', (req, res) => {
    const r = resolvePortal(req.params.token);
    if (r.error) return res.status(r.status).type('html').send('<h1>Unavailable</h1>');
    res.type('html').send(renderPrintStatement({
      companyName: r.snap.companyName,
      client: r.snap.client,
      invoices: r.snap.invoices,
      payments: r.snap.payments,
    }));
  });

  app.get('/portal/:token/statement.pdf', (req, res) => {
    const r = resolvePortal(req.params.token);
    if (r.error) return res.status(r.status).send('Unavailable');
    const buf = buildSimplePdf({
      companyName: r.snap.companyName,
      client: r.snap.client,
      invoices: r.snap.invoices,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="statement-${(r.snap.client.name || 'client').replace(/[^a-z0-9]+/gi, '-')}.pdf"`);
    res.send(buf);
  });

  app.get('/api/portal/:token', (req, res) => {
    const r = resolvePortal(req.params.token);
    if (r.error) return res.status(r.status).json({ error: r.error });
    r.rec.views = (r.rec.views || 0) + 1;
    persistPortals();
    res.json({
      ok: true,
      company: r.snap.companyName,
      client: { name: r.snap.client.name, email: r.snap.client.email, phone: r.snap.client.phone },
      invoices: r.snap.invoices,
      quotes: r.snap.quotes,
      tickets: r.snap.tickets,
      payments: r.snap.payments,
    });
  });
}

module.exports = { mountPortal };
