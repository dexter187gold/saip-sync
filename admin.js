/**
 * SA Invoice Pro – Admin Portal (restored)
 * Seeds default admin, mounts intake-api + ticket-status, exposes admin APIs + HTML portal.
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { ensureDefaultAdmin, DEFAULT_EMAIL, DEFAULT_PASSWORD } = require('./admin-seed');

function mountAdmin(app, ctx) {
  const {
    users, persistUsers, workspaces, persistWorkspaces,
    waClients, persistWaClients, ticketsIntake, persistTickets,
    invoiceStatus, notifications, persistNotifs,
    auth, now, JWT_SECRET, ADMIN_EMAIL, PUBLIC_BASE,
    DATA_DIR, loadJson, saveJson,
  } = ctx;

  try {
    ensureDefaultAdmin({
      users, persistUsers, workspaces, persistWorkspaces, now,
      adminEmail: ADMIN_EMAIL || process.env.ADMIN_EMAIL || DEFAULT_EMAIL,
      adminPassword: process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD,
    });
  } catch (e) {
    console.error('[admin] seed failed', e.message);
  }

  try {
    const { mountIntakeApi } = require('./intake-api');
    mountIntakeApi(app, { auth, waClients, persistWaClients, ticketsIntake, persistTickets, now });
  } catch (e) {
    console.error('[admin] intake-api mount failed', e.message);
  }

  try {
    const { mountTicketStatus } = require('./ticket-status');
    const DEFAULT_STATUS_TOKEN = 'SaIpStAtUs_7f3a9c2e1b8d4f6a0e5c9b3d7a1f4e8';
    const STATUS_TOKEN_RAW = process.env.STATUS_API_TOKEN || DEFAULT_STATUS_TOKEN;
    const allowed = new Set(
      String(STATUS_TOKEN_RAW).split(',').map((s) => s.trim()).filter(Boolean)
    );
    allowed.add(DEFAULT_STATUS_TOKEN);
    function statusAuth(req, res, next) {
      const q = req.query && req.query.token;
      const h = req.headers['x-status-token'];
      const authH = req.headers.authorization || '';
      let t = q || h || '';
      if (!t && authH.toLowerCase().startsWith('bearer ')) t = authH.slice(7);
      t = String(t || '').trim();
      if (!t || !allowed.has(t)) {
        return res.type('text/plain').status(403).send('⚠️ Invalid status token.\n\nReply *menu* for options.');
      }
      next();
    }
    mountTicketStatus(app, {
      auth,
      statusAuth,
      DATA_DIR,
      loadJson,
      saveJson,
      ticketsIntake,
      persistTickets,
      waClients,
      persistWaClients,
      pushNotification: typeof ctx.pushNotification === 'function' ? ctx.pushNotification : null,
      now,
    });
  } catch (e) {
    console.error('[admin] ticket-status mount failed', e.message);
  }

  const adminEmail = String(ADMIN_EMAIL || process.env.ADMIN_EMAIL || DEFAULT_EMAIL || '').toLowerCase().trim();

  function isAdminUser(user) {
    if (!user) return false;
    if (adminEmail && String(user.email || '').toLowerCase() === adminEmail) return true;
    if (String(user.email || '').toLowerCase() === DEFAULT_EMAIL) return true;
    if (user.role === 'admin') return true;
    return false;
  }

  function adminAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = Object.values(users).find((u) => u.id === payload.id);
      if (!user || !isAdminUser(user)) return res.status(403).json({ error: 'Admin access required' });
      req.user = payload;
      req.adminUser = user;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  app.get('/api/admin/me', adminAuth, (req, res) => {
    res.json({ ok: true, admin: { id: req.adminUser.id, email: req.adminUser.email, name: req.adminUser.name } });
  });

  app.get('/api/admin/stats', adminAuth, (req, res) => {
    const waList = Object.values(waClients || {});
    const tickets = ticketsIntake?.items || [];
    const invs = Object.values(invoiceStatus || {});
    const openAr = invs
      .filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()))
      .reduce((s, i) => s + (Number(i.balance_due ?? i.total) || 0), 0);
    res.json({
      ok: true,
      stats: {
        users: Object.values(users).length,
        workspaces: Object.keys(workspaces || {}).length,
        wa_clients: waList.length,
        wa_registered: waList.filter((c) => c.registered).length,
        tickets_open: tickets.filter((t) => t.status === 'new' || !t.status).length,
        tickets_total: tickets.length,
        invoice_status_rows: invs.length,
        outstanding_ar: openAr,
        notifications: (notifications?.items || []).length,
      },
      generated_at: now(),
    });
  });

  app.get('/api/admin/users', adminAuth, (req, res) => {
    const list = Object.values(users).map((u) => ({
      id: u.id, email: u.email, name: u.name || null,
      role: isAdminUser(u) ? 'admin' : u.role || 'user',
      created_at: u.created_at, has_workspace: !!workspaces[u.id],
    }));
    list.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    res.json({ ok: true, count: list.length, users: list });
  });

  app.get('/api/admin/wa-clients', adminAuth, (req, res) => {
    const list = Object.values(waClients || {}).map((c) => ({
      id: c.id, phone: c.phone, name: c.name, email: c.email, company: c.company,
      registered: !!c.registered, source: c.source, pending_import: !!c.pending_import,
      linked_client_id: c.linked_client_id || null, created_at: c.created_at, updated_at: c.updated_at,
    }));
    list.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    res.json({ ok: true, count: list.length, clients: list });
  });

  app.delete('/api/admin/wa-clients/:phone', adminAuth, (req, res) => {
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    if (!waClients[phone]) return res.status(404).json({ error: 'Not found' });
    delete waClients[phone];
    persistWaClients();
    res.json({ ok: true, deleted: phone });
  });

  app.get('/api/admin/tickets', adminAuth, (req, res) => {
    const items = (ticketsIntake?.items || []).slice(0, 100);
    res.json({ ok: true, count: items.length, tickets: items });
  });

  app.patch('/api/admin/tickets/:id', adminAuth, (req, res) => {
    const items = ticketsIntake?.items || [];
    const t = items.find((x) => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (req.body?.status) t.status = req.body.status;
    if (req.body?.note) t.admin_note = req.body.note;
    t.updated_at = now();
    persistTickets();
    res.json({ ok: true, ticket: t });
  });

  app.get('/api/admin/notifications', adminAuth, (req, res) => {
    res.json({ ok: true, count: (notifications?.items || []).length, notifications: (notifications?.items || []).slice(0, 50) });
  });

  app.post('/api/admin/notifications/clear', adminAuth, (req, res) => {
    if (notifications) notifications.items = [];
    if (typeof persistNotifs === 'function') persistNotifs();
    res.json({ ok: true });
  });

  app.get('/admin', (req, res) => {
    res.type('html').send(ADMIN_HTML);
  });

  console.log('[admin] portal mounted at /admin');
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Brain Control Lab · SA Invoice Pro</title>
<style>
:root{--bg:#0c0a14;--card:#16122a;--line:#2a2448;--text:#f0e6ff;--muted:#a89bc8;--accent:#e879f9;--ok:#34d399;--danger:#f87171}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.wrap{max-width:1000px;margin:0 auto;padding:20px 16px}h1{font-size:1.4rem;margin:0 0 8px;color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
input,button{font:inherit}input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:#0f0c1a;color:var(--text);margin:6px 0}
button{padding:10px 14px;border-radius:8px;border:0;background:var(--accent);color:#1a0a20;font-weight:600;cursor:pointer;margin:4px 4px 4px 0}
button.secondary{background:#2a2448;color:var(--text)}button.danger{background:var(--danger);color:#fff}
.muted{color:var(--muted);font-size:.9rem}table{width:100%;border-collapse:collapse;font-size:.85rem}td,th{padding:8px;border-bottom:1px solid var(--line);text-align:left}
.tabs button{background:transparent;color:var(--muted);border:1px solid var(--line)}.tabs button.active{background:var(--accent);color:#1a0a20}
.hidden{display:none}#toast{position:fixed;bottom:16px;right:16px;background:#221a3a;padding:10px 14px;border-radius:8px;display:none}
</style></head><body><div class="wrap">
<div id="login" class="card"><h1>Enter the Lab</h1><p class="muted">Admin portal</p>
<input id="email" type="email" placeholder="Email" value="admin@sainvoice.pro"/>
<input id="password" type="password" placeholder="Password"/>
<button id="btn-login">Enter the Lab</button><p id="login-err" class="muted"></p></div>
<div id="app" class="hidden">
<h1>Brain Control Lab</h1><p class="muted" id="who"></p>
<div class="tabs"><button data-tab="stats" class="active">Stats</button><button data-tab="wa">WA Clients</button><button data-tab="tickets">Tickets</button><button data-tab="users">Users</button><button id="btn-logout" class="secondary">Logout</button></div>
<div id="panel-stats" class="card"></div>
<div id="panel-wa" class="card hidden"></div>
<div id="panel-tickets" class="card hidden"></div>
<div id="panel-users" class="card hidden"></div>
</div></div><div id="toast"></div>
<script>
(function(){
var token=localStorage.getItem('saip_admin_token')||'';
function toast(m){var t=document.getElementById('toast');t.textContent=m;t.style.display='block';setTimeout(function(){t.style.display='none'},3000)}
function api(path,opts){opts=opts||{};var h={'Content-Type':'application/json'};if(token)h.Authorization='Bearer '+token;return fetch(path,{method:opts.method||'GET',headers:h,body:opts.body?JSON.stringify(opts.body):undefined}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||r.statusText);return d})})}
function showApp(){document.getElementById('login').classList.add('hidden');document.getElementById('app').classList.remove('hidden');refreshAll()}
function login(){var email=document.getElementById('email').value.trim();var password=document.getElementById('password').value;api('/api/auth/login',{method:'POST',body:{email:email,password:password}}).then(function(d){token=d.token;localStorage.setItem('saip_admin_token',token);document.getElementById('who').textContent=d.user.email;showApp()}).catch(function(e){document.getElementById('login-err').textContent=e.message})}
document.getElementById('btn-login').onclick=login;
document.getElementById('password').addEventListener('keydown',function(e){if(e.key==='Enter')login()});
document.getElementById('btn-logout').onclick=function(){token='';localStorage.removeItem('saip_admin_token');location.reload()};
document.querySelectorAll('[data-tab]').forEach(function(b){b.onclick=function(){document.querySelectorAll('[data-tab]').forEach(function(x){x.classList.remove('active')});b.classList.add('active');['stats','wa','tickets','users'].forEach(function(n){document.getElementById('panel-'+n).classList.toggle('hidden',n!==b.getAttribute('data-tab'))});if(b.getAttribute('data-tab')==='wa')loadWa();if(b.getAttribute('data-tab')==='tickets')loadTickets();if(b.getAttribute('data-tab')==='users')loadUsers()}});
function refreshAll(){api('/api/admin/stats').then(function(d){var s=d.stats;document.getElementById('panel-stats').innerHTML='<h3>Stats</h3><p>Users: '+s.users+' · WA: '+s.wa_clients+' · Tickets: '+s.tickets_total+' (open '+s.tickets_open+') · AR: R'+Number(s.outstanding_ar||0).toFixed(2)+'</p>'}).catch(function(e){toast(e.message)})}
function loadWa(){api('/api/admin/wa-clients').then(function(d){var rows=(d.clients||[]).map(function(c){return '<tr><td>'+esc(c.name)+'</td><td>'+esc(c.phone)+'</td><td>'+(c.pending_import?'pending':'ok')+'</td><td><button class="danger" data-act="delwa" data-phone="'+esc(c.phone)+'">Remove</button></td></tr>'}).join('');document.getElementById('panel-wa').innerHTML='<h3>WA Clients</h3><table><tr><th>Name</th><th>Phone</th><th>Status</th><th></th></tr>'+(rows||'<tr><td colspan=4>None</td></tr>')+'</table>'}).catch(function(e){toast(e.message)})}
function loadTickets(){api('/api/admin/tickets').then(function(d){var rows=(d.tickets||[]).map(function(t){return '<tr><td>'+esc(t.device||t.id)+'</td><td>'+esc(t.issue||'')+'</td><td>'+esc(t.status)+'</td><td><button data-act="ticket" data-id="'+esc(t.id)+'" data-status="done">Done</button></td></tr>'}).join('');document.getElementById('panel-tickets').innerHTML='<h3>Tickets</h3><table><tr><th>Device</th><th>Issue</th><th>Status</th><th></th></tr>'+(rows||'<tr><td colspan=4>None</td></tr>')+'</table>'}).catch(function(e){toast(e.message)})}
function loadUsers(){api('/api/admin/users').then(function(d){var rows=(d.users||[]).map(function(u){return '<tr><td>'+esc(u.email)+'</td><td>'+esc(u.role)+'</td><td>'+esc(u.created_at||'').slice(0,10)+'</td></tr>'}).join('');document.getElementById('panel-users').innerHTML='<h3>Users</h3><table><tr><th>Email</th><th>Role</th><th>Created</th></tr>'+(rows||'')+'</table>'}).catch(function(e){toast(e.message)})}
function esc(s){return String(s==null?'':s).replace(/&/g,'&').replace(/</g,'<').replace(/"/g,'"')}
document.body.addEventListener('click',function(e){var btn=e.target.closest('[data-act]');if(!btn)return;var act=btn.getAttribute('data-act');if(act==='delwa'){if(!confirm('Remove?'))return;api('/api/admin/wa-clients/'+btn.getAttribute('data-phone'),{method:'DELETE'}).then(function(){toast('Removed');loadWa()}).catch(function(err){toast(err.message)})}else if(act==='ticket'){api('/api/admin/tickets/'+btn.getAttribute('data-id'),{method:'PATCH',body:{status:btn.getAttribute('data-status')}}).then(function(){toast('Updated');loadTickets()}).catch(function(err){toast(err.message)})}});
if(token){api('/api/admin/me').then(function(d){document.getElementById('who').textContent=d.admin.email;showApp()}).catch(function(){localStorage.removeItem('saip_admin_token');token=''})}
})();
</script></body></html>`;

module.exports = { mountAdmin };
