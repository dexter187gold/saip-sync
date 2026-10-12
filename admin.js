/**
 * SA Invoice Pro – Admin Portal v4.0.0
 * "Brain's Acme Labs Control Center"
 * Theme: Pinky and the Brain · Try to take over the (SME) world
 * Narf! This is not a plan to take over the world... or is it?
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

function mountAdmin(app, ctx) {
  const {
    users,
    persistUsers,
    workspaces,
    persistWorkspaces,
    waClients,
    persistWaClients,
    ticketsIntake,
    persistTickets,
    invoiceStatus,
    notifications,
    auth,
    now,
    JWT_SECRET,
    ADMIN_EMAIL,
    PUBLIC_BASE,
    loadJson,
    saveJson,
    DATA_DIR,
    path,
  } = ctx;

  const adminEmail = String(ADMIN_EMAIL || process.env.ADMIN_EMAIL || '').toLowerCase().trim();

  function isAdminUser(user) {
    if (!user) return false;
    if (adminEmail && String(user.email || '').toLowerCase() === adminEmail) return true;
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
      if (!user || !isAdminUser(user)) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      req.user = payload;
      req.adminUser = user;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  // ——— APIs (unchanged functional core – the plan remains sound) ———

  app.get('/api/admin/me', adminAuth, (req, res) => {
    res.json({
      ok: true,
      admin: {
        id: req.adminUser.id,
        email: req.adminUser.email,
        name: req.adminUser.name,
      },
    });
  });

  app.get('/api/admin/stats', adminAuth, (req, res) => {
    const userList = Object.values(users);
    const waList = Object.values(waClients || {});
    const tickets = ticketsIntake?.items || [];
    const invs = Object.values(invoiceStatus || {});
    const openAr = invs
      .filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()))
      .reduce((s, i) => s + (Number(i.balance_due ?? i.total) || 0), 0);
    res.json({
      ok: true,
      stats: {
        users: userList.length,
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
      id: u.id,
      email: u.email,
      name: u.name || null,
      role: isAdminUser(u) ? 'admin' : u.role || 'user',
      created_at: u.created_at,
      updated_at: u.updated_at,
      has_workspace: !!workspaces[u.id],
      workspace_version: workspaces[u.id]?.version || 0,
    }));
    list.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    res.json({ ok: true, count: list.length, users: list });
  });

  app.post('/api/admin/users/:id/reset-password', adminAuth, (req, res) => {
    const user = Object.values(users).find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    let password = (req.body && req.body.password) || '';
    if (!password || password.length < 6) {
      password = crypto.randomBytes(4).toString('hex') + 'A1';
    }
    user.password_hash = bcrypt.hashSync(password, 10);
    user.updated_at = now();
    persistUsers();
    res.json({
      ok: true,
      message: 'Password reset',
      email: user.email,
      temporary_password: password,
      hint: 'Share this temporary password securely. User should change it after login.',
    });
  });

  app.delete('/api/admin/users/:id', adminAuth, (req, res) => {
    const user = Object.values(users).find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.id === req.adminUser.id) {
      return res.status(400).json({ error: 'Cannot delete your own admin account' });
    }
    if (isAdminUser(user) && String(user.email).toLowerCase() === adminEmail) {
      return res.status(400).json({ error: 'Cannot delete primary admin' });
    }
    const emailKey = String(user.email).toLowerCase();
    delete users[emailKey];
    for (const k of Object.keys(users)) {
      if (users[k].id === user.id) delete users[k];
    }
    delete workspaces[user.id];
    persistUsers();
    persistWorkspaces();
    res.json({ ok: true, deleted: { id: user.id, email: user.email } });
  });

  app.patch('/api/admin/users/:id', adminAuth, (req, res) => {
    const user = Object.values(users).find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const b = req.body || {};
    if (b.name != null) user.name = String(b.name).trim() || null;
    if (b.role === 'admin' || b.role === 'user') user.role = b.role;
    user.updated_at = now();
    persistUsers();
    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: isAdminUser(user) ? 'admin' : user.role || 'user',
      },
    });
  });

  app.get('/api/admin/wa-clients', adminAuth, (req, res) => {
    const list = Object.values(waClients || {}).map((c) => ({
      id: c.id,
      phone: c.phone,
      name: c.name,
      email: c.email,
      company: c.company,
      registered: !!c.registered,
      source: c.source,
      pending_import: !!c.pending_import,
      linked_client_id: c.linked_client_id || null,
      created_at: c.created_at,
      updated_at: c.updated_at,
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
    const items = (notifications?.items || []).slice(0, 50);
    res.json({ ok: true, count: items.length, notifications: items });
  });

  app.post('/api/admin/notifications/clear', adminAuth, (req, res) => {
    if (notifications) notifications.items = [];
    if (ctx.persistNotifs) ctx.persistNotifs();
    res.json({ ok: true });
  });

  // ——— HTML Portal – Brain's Acme Labs Control Center ———
  app.get('/admin', (req, res) => {
    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Brain's Control Lab · SA Invoice Pro</title>
<style>
:root{
  --bg:#0c0a14; --card:#16122a; --line:#2a2448; --text:#f0e6ff; --muted:#a89bc8;
  --accent:#e879f9; --accent2:#a78bfa; --ok:#34d399; --warn:#fbbf24; --danger:#f87171;
  --pinky:#f9a8d4; --brain:#c4b5fd;
}
*{box-sizing:border-box}
body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;background-image:radial-gradient(ellipse at top,#1e1035 0%,var(--bg) 60%)}
.wrap{max-width:1100px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:1.45rem;margin:0 0 4px;background:linear-gradient(90deg,var(--pinky),var(--brain));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sub{color:var(--muted);font-size:.9rem;margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:16px;box-shadow:0 8px 32px rgba(0,0,0,.35)}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
.stat{background:#0f0b1e;border-radius:14px;padding:14px;border:1px solid var(--line);transition:transform .15s}
.stat:hover{transform:translateY(-2px);border-color:var(--accent)}
.stat b{display:block;font-size:1.4rem;color:var(--pinky)}
.stat span{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}
input,select,button,textarea{font:inherit}
input,select{width:100%;padding:11px 13px;border-radius:12px;border:1px solid var(--line);background:#0f0b1e;color:var(--text);margin:6px 0 10px}
input:focus{outline:none;border-color:var(--accent)}
button{cursor:pointer;border:none;border-radius:12px;padding:10px 14px;font-weight:600}
.btn{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#1a0533}
.btn-danger{background:var(--danger);color:#1a0533}
.btn-ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
.btn-ok{background:var(--ok);color:#052e16}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th,td{text-align:left;padding:11px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.03em}
.badge{display:inline-block;padding:3px 9px;border-radius:999px;font-size:.7rem;background:#1e1a35}
.badge.admin{background:linear-gradient(135deg,#7c3aed,#db2777);color:#fff}
.badge.user{background:#2e2648}
.hidden{display:none}
#toast{position:fixed;bottom:18px;right:18px;background:#1e1a35;border:1px solid var(--accent);padding:13px 17px;border-radius:14px;display:none;z-index:50;max-width:340px;box-shadow:0 8px 24px rgba(232,121,249,.25)}
.tab{background:#0f0b1e;border:1px solid var(--line);color:var(--muted);padding:9px 14px;border-radius:999px;cursor:pointer;transition:all .15s}
.tab.on{color:#fff;border-color:var(--accent);background:linear-gradient(135deg,#2e1065,#4a044e)}
.login-box{max-width:420px;margin:70px auto}
.narf{font-size:.75rem;color:var(--pinky);opacity:.8;margin-top:8px}
.hero-quote{font-style:italic;color:var(--muted);font-size:.85rem;border-left:3px solid var(--accent);padding-left:12px;margin:12px 0 0}
</style>
</head>
<body>
<div class="wrap">
  <div id="loginView" class="login-box card">
    <h1>🧠 Brain's Control Lab</h1>
    <p class="sub">Acme Labs · SA Invoice Pro · World Domination Edition</p>
    <p class="hero-quote">"Pinky, are you pondering what I'm pondering?"<br/>"I think so, Brain, but how will we take over the invoicing world with only one admin login?"</p>
    <label>Email</label>
    <input id="email" type="email" placeholder="admin@email.com" autocomplete="username"/>
    <label>Password</label>
    <input id="password" type="password" placeholder="••••••••" autocomplete="current-password"/>
    <button class="btn" style="width:100%" onclick="login()">Enter the Lab</button>
    <p class="narf">Narf! Use the cloud account listed as ADMIN_EMAIL on the server.</p>
  </div>

  <div id="appView" class="hidden">
    <div class="row" style="justify-content:space-between;margin-bottom:14px">
      <div>
        <h1>🧠 Brain's Control Lab</h1>
        <p class="sub" id="who">—</p>
      </div>
      <button class="btn-ghost" onclick="logout()">Log out · Poit!</button>
    </div>

    <div class="card">
      <div class="grid" id="stats"></div>
      <p class="narf" style="margin-top:10px">The same thing we do every night, Pinky — try to take over the world of SME invoicing.</p>
    </div>

    <div class="row" style="margin-bottom:14px">
      <button class="tab on" data-tab="users" onclick="tab('users')">👥 Users</button>
      <button class="tab" data-tab="wa" onclick="tab('wa')">📱 WA Clients</button>
      <button class="tab" data-tab="tickets" onclick="tab('tickets')">🛠 Tickets</button>
      <button class="tab" data-tab="notifs" onclick="tab('notifs')">🔔 Notifications</button>
    </div>

    <div id="panel-users" class="card"></div>
    <div id="panel-wa" class="card hidden"></div>
    <div id="panel-tickets" class="card hidden"></div>
    <div id="panel-notifs" class="card hidden"></div>
  </div>
</div>
<div id="toast"></div>
<script>
const API = location.origin;
let token = localStorage.getItem('saip_admin_token') || '';

function toast(msg){
  const el=document.getElementById('toast');
  el.textContent=msg; el.style.display='block';
  setTimeout(()=>el.style.display='none',3400);
}
async function api(path, opts={}){
  const r = await fetch(API+path,{
    ...opts,
    headers:{
      'Content-Type':'application/json',
      ...(token?{Authorization:'Bearer '+token}:{}),
      ...(opts.headers||{})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
async function login(){
  try{
    const email=document.getElementById('email').value.trim();
    const password=document.getElementById('password').value;
    const data=await api('/api/auth/login',{method:'POST',body:{email,password}});
    token=data.token; localStorage.setItem('saip_admin_token',token);
    await api('/api/admin/me');
    showApp();
  }catch(e){ toast(e.message||'Login failed · Zort!'); }
}
function logout(){
  token=''; localStorage.removeItem('saip_admin_token');
  document.getElementById('appView').classList.add('hidden');
  document.getElementById('loginView').classList.remove('hidden');
}
function tab(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t.dataset.tab===name));
  ['users','wa','tickets','notifs'].forEach(n=>{
    document.getElementById('panel-'+n).classList.toggle('hidden', n!==name);
  });
}
async function showApp(){
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('appView').classList.remove('hidden');
  try{
    const me=await api('/api/admin/me');
    document.getElementById('who').textContent=me.admin.email+(me.admin.name?' · '+me.admin.name:'')+' · Lab Director';
    await refreshAll();
  }catch(e){
    toast('Admin access required · Narf!');
    logout();
  }
}
async function refreshAll(){
  await Promise.all([loadStats(), loadUsers(), loadWa(), loadTickets(), loadNotifs()]);
}
async function loadStats(){
  const d=await api('/api/admin/stats');
  const s=d.stats;
  document.getElementById('stats').innerHTML=[
    ['Users',s.users],['WA clients',s.wa_clients],['Tickets',s.tickets_total],
    ['Open jobs',s.tickets_open],['Invoice rows',s.invoice_status_rows],
    ['AR', 'R'+(s.outstanding_ar||0).toFixed(2)]
  ].map(([k,v])=>'<div class="stat"><b>'+v+'</b><span>'+k+'</span></div>').join('');
}
async function loadUsers(){
  const d=await api('/api/admin/users');
  const rows=d.users.map(u=>'<tr>'
    +'<td><div>'+(u.name||'—')+'</div><div style="color:var(--muted);font-size:.75rem">'+u.email+'</div></td>'
    +'<td><span class="badge '+(u.role==='admin'?'admin':'user')+'">'+u.role+'</span></td>'
    +'<td>v'+(u.workspace_version||0)+'</td>'
    +'<td style="font-size:.75rem;color:var(--muted)">'+(u.created_at||'').slice(0,10)+'</td>'
    +'<td class="row">'
    +'<button class="btn-ok" onclick="resetPw(\''+u.id+'\')">Reset PW</button>'
    +'<button class="btn-danger" onclick="delUser(\''+u.id+'\',\''+u.email+'\')">Delete</button>'
    +'</td></tr>').join('');
  document.getElementById('panel-users').innerHTML='<h3 style="margin:0 0 12px">Cloud users · Lab subjects</h3>'
    +'<div class="row" style="margin-bottom:10px"><button class="btn-ghost" onclick="loadUsers()">Refresh</button></div>'
    +'<table><thead><tr><th>User</th><th>Role</th><th>WS</th><th>Joined</th><th>Actions</th></tr></thead><tbody>'
    +(rows||'<tr><td colspan="5">No users yet · The lab is empty</td></tr>')+'</tbody></table>';
}
async function resetPw(id){
  if(!confirm('Generate a temporary password for this user?')) return;
  try{
    const d=await api('/api/admin/users/'+id+'/reset-password',{method:'POST',body:{}});
    prompt('Temporary password (copy now):', d.temporary_password);
    toast('Password reset for '+d.email+' · Success!');
  }catch(e){ toast(e.message); }
}
async function delUser(id,email){
  if(!confirm('Delete account '+email+' and their workspace? This cannot be undone.')) return;
  try{
    await api('/api/admin/users/'+id,{method:'DELETE'});
    toast('Deleted '+email+' · Poit!');
    await refreshAll();
  }catch(e){ toast(e.message); }
}
async function loadWa(){
  const d=await api('/api/admin/wa-clients');
  const rows=d.clients.map(c=>'<tr>'
    +'<td><div>'+(c.name||'—')+'</div><div style="color:var(--muted);font-size:.75rem">'+c.phone+'</div></td>'
    +'<td>'+(c.email||'—')+'</td>'
    +'<td>'+(c.registered?'✅':'⚠️')+'</td>'
    +'<td>'+(c.source||'')+'</td>'
    +'<td><button class="btn-danger" onclick="delWa(\''+c.phone+'\')">Remove</button></td></tr>').join('');
  document.getElementById('panel-wa').innerHTML='<h3 style="margin:0 0 12px">WhatsApp clients · Future minions</h3>'
    +'<table><thead><tr><th>Client</th><th>Email</th><th>Reg</th><th>Source</th><th></th></tr></thead><tbody>'
    +(rows||'<tr><td colspan="5">None yet</td></tr>')+'</tbody></table>';
}
async function delWa(phone){
  if(!confirm('Remove WA profile '+phone+'?')) return;
  try{
    await api('/api/admin/wa-clients/'+phone,{method:'DELETE'});
    toast('Removed · Zort!');
    await loadWa();
  }catch(e){ toast(e.message); }
}
async function loadTickets(){
  const d=await api('/api/admin/tickets');
  const rows=d.tickets.map(t=>'<tr>'
    +'<td>'+(t.customer_name||'—')+'<div style="color:var(--muted);font-size:.75rem">'+(t.customer_phone||'')+'</div></td>'
    +'<td>'+(t.device||'—')+'</td>'
    +'<td>'+(t.issue||'—')+'</td>'
    +'<td>'+(t.urgency||'')+' / '+(t.status||'new')+'</td>'
    +'<td class="row">'
    +'<button class="btn" onclick="setTicket(\''+t.id+'\',\'in_progress\')">In progress</button>'
    +'<button class="btn-ok" onclick="setTicket(\''+t.id+'\',\'done\')">Done</button>'
    +'</td></tr>').join('');
  document.getElementById('panel-tickets').innerHTML='<h3 style="margin:0 0 12px">Job intake (WhatsApp) · Lab experiments</h3>'
    +'<table><thead><tr><th>Customer</th><th>Device</th><th>Issue</th><th>Status</th><th></th></tr></thead><tbody>'
    +(rows||'<tr><td colspan="5">No tickets · Quiet night in the lab</td></tr>')+'</tbody></table>';
}
async function setTicket(id,status){
  try{
    await api('/api/admin/tickets/'+id,{method:'PATCH',body:{status}});
    toast('Ticket → '+status);
    await loadTickets();
  }catch(e){ toast(e.message); }
}
async function loadNotifs(){
  const d=await api('/api/admin/notifications');
  const rows=d.notifications.map(n=>'<tr>'
    +'<td>'+(n.type||'')+'</td>'
    +'<td><b>'+(n.title||'')+'</b><div style="color:var(--muted)">'+(n.body||'')+'</div></td>'
    +'<td style="font-size:.75rem">'+(n.created_at||'').replace('T',' ').slice(0,19)+'</td></tr>').join('');
  document.getElementById('panel-notifs').innerHTML='<h3 style="margin:0 0 12px">Notifications · Brain\'s alerts</h3>'
    +'<div class="row" style="margin-bottom:10px"><button class="btn-ghost" onclick="clearNotifs()">Clear all</button></div>'
    +'<table><thead><tr><th>Type</th><th>Message</th><th>When</th></tr></thead><tbody>'
    +(rows||'<tr><td colspan="3">None</td></tr>')+'</tbody></table>';
}
async function clearNotifs(){
  try{ await api('/api/admin/notifications/clear',{method:'POST',body:{}}); toast('Cleared · Narf!'); await loadNotifs(); }
  catch(e){ toast(e.message); }
}
if(token){ showApp(); }
</script>
</body>
</html>`);
  });
}

module.exports = { mountAdmin };
