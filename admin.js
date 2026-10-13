/**
 * SA Invoice Pro – Admin Portal v4.0.1
 * Brain's Acme Labs Control Center — login fixed (script parse error)
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { ensureDefaultAdmin, DEFAULT_EMAIL, DEFAULT_PASSWORD } = require('./admin-seed');

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

  try {
    ensureDefaultAdmin({
      users,
      persistUsers,
      workspaces,
      persistWorkspaces,
      now,
      adminEmail: ADMIN_EMAIL || process.env.ADMIN_EMAIL || DEFAULT_EMAIL,
      adminPassword: process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD,
    });
  } catch (e) {
    console.error('[admin] seed failed', e.message);
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

  app.get('/admin', (req, res) => {
    res.type('html').send(ADMIN_HTML);
  });
}

/** Client portal HTML — data-* + event delegation (no fragile quote escaping). */
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Brain Control Lab · SA Invoice Pro</title>
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
.busy{opacity:.6;pointer-events:none}
</style>
</head>
<body>
<div class="wrap">
  <div id="loginView" class="login-box card">
    <h1>Brain Control Lab</h1>
    <p class="sub">Acme Labs · SA Invoice Pro · Admin</p>
    <p class="hero-quote">"Pinky, are you pondering what I am pondering?"</p>
    <label>Email</label>
    <input id="email" type="email" placeholder="admin@sainvoice.pro" value="admin@sainvoice.pro" autocomplete="username"/>
    <label>Password</label>
    <input id="password" type="password" placeholder="Password" autocomplete="current-password"/>
    <button type="button" id="loginBtn" class="btn" style="width:100%">Enter the Lab</button>
    <p class="narf">Default: <b>admin@sainvoice.pro</b> / <b>Admin@SAIP2026!</b></p>
    <p id="loginErr" class="narf" style="color:var(--danger);display:none"></p>
  </div>

  <div id="appView" class="hidden">
    <div class="row" style="justify-content:space-between;margin-bottom:14px">
      <div>
        <h1>Brain Control Lab</h1>
        <p class="sub" id="who">—</p>
      </div>
      <button type="button" class="btn-ghost" id="logoutBtn">Log out</button>
    </div>
    <div class="card"><div class="grid" id="stats"></div></div>
    <div class="row" style="margin-bottom:14px">
      <button type="button" class="tab on" data-tab="users">Users</button>
      <button type="button" class="tab" data-tab="wa">WA Clients</button>
      <button type="button" class="tab" data-tab="tickets">Tickets</button>
      <button type="button" class="tab" data-tab="notifs">Notifications</button>
    </div>
    <div id="panel-users" class="card"></div>
    <div id="panel-wa" class="card hidden"></div>
    <div id="panel-tickets" class="card hidden"></div>
    <div id="panel-notifs" class="card hidden"></div>
  </div>
</div>
<div id="toast"></div>
<script>
(function () {
  var API = location.origin;
  var token = localStorage.getItem("saip_admin_token") || "";

  function toast(msg) {
    var el = document.getElementById("toast");
    el.textContent = msg;
    el.style.display = "block";
    setTimeout(function () { el.style.display = "none"; }, 4000);
  }

  function showLoginError(msg) {
    var el = document.getElementById("loginErr");
    el.style.display = "block";
    el.textContent = msg || "";
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    return fetch(API + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || r.statusText || "Request failed");
        return data;
      });
    });
  }

  function login() {
    var email = document.getElementById("email").value.trim();
    var password = document.getElementById("password").value;
    var btn = document.getElementById("loginBtn");
    showLoginError("");
    if (!email || !password) {
      showLoginError("Email and password required");
      toast("Email and password required");
      return;
    }
    btn.classList.add("busy");
    btn.textContent = "Signing in…";
    api("/api/auth/login", { method: "POST", body: { email: email, password: password } })
      .then(function (data) {
        token = data.token;
        localStorage.setItem("saip_admin_token", token);
        return api("/api/admin/me");
      })
      .then(function () {
        showApp();
      })
      .catch(function (e) {
        token = "";
        localStorage.removeItem("saip_admin_token");
        var msg = e.message || "Login failed";
        if (/Admin access/i.test(msg)) {
          msg = "Account is not an admin. Use admin@sainvoice.pro";
        }
        showLoginError(msg);
        toast(msg);
      })
      .finally(function () {
        btn.classList.remove("busy");
        btn.textContent = "Enter the Lab";
      });
  }

  function logout() {
    token = "";
    localStorage.removeItem("saip_admin_token");
    document.getElementById("appView").classList.add("hidden");
    document.getElementById("loginView").classList.remove("hidden");
  }

  function tab(name) {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("on", t.getAttribute("data-tab") === name);
    });
    ["users", "wa", "tickets", "notifs"].forEach(function (n) {
      document.getElementById("panel-" + n).classList.toggle("hidden", n !== name);
    });
  }

  function showApp() {
    document.getElementById("loginView").classList.add("hidden");
    document.getElementById("appView").classList.remove("hidden");
    api("/api/admin/me")
      .then(function (me) {
        var label = me.admin.email + (me.admin.name ? " · " + me.admin.name : "") + " · Lab Director";
        document.getElementById("who").textContent = label;
        return refreshAll();
      })
      .catch(function () {
        toast("Admin access required");
        logout();
      });
  }

  function refreshAll() {
    return Promise.all([loadStats(), loadUsers(), loadWa(), loadTickets(), loadNotifs()]);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function loadStats() {
    return api("/api/admin/stats").then(function (d) {
      var s = d.stats;
      var items = [
        ["Users", s.users],
        ["WA clients", s.wa_clients],
        ["Tickets", s.tickets_total],
        ["Open jobs", s.tickets_open],
        ["Invoice rows", s.invoice_status_rows],
        ["AR", "R" + (s.outstanding_ar || 0).toFixed(2)]
      ];
      document.getElementById("stats").innerHTML = items.map(function (pair) {
        return '<div class="stat"><b>' + esc(pair[1]) + '</b><span>' + esc(pair[0]) + '</span></div>';
      }).join("");
    });
  }

  function loadUsers() {
    return api("/api/admin/users").then(function (d) {
      var rows = (d.users || []).map(function (u) {
        return "<tr>"
          + "<td><div>" + esc(u.name || "—") + '</div><div style="color:var(--muted);font-size:.75rem">' + esc(u.email) + "</div></td>"
          + '<td><span class="badge ' + (u.role === "admin" ? "admin" : "user") + '">' + esc(u.role) + "</span></td>"
          + "<td>v" + esc(u.workspace_version || 0) + "</td>"
          + '<td style="font-size:.75rem;color:var(--muted)">' + esc(String(u.created_at || "").slice(0, 10)) + "</td>"
          + '<td class="row">'
          + '<button type="button" class="btn-ok" data-act="reset" data-id="' + esc(u.id) + '">Reset PW</button>'
          + '<button type="button" class="btn-danger" data-act="deluser" data-id="' + esc(u.id) + '" data-email="' + esc(u.email) + '">Delete</button>'
          + "</td></tr>";
      }).join("");
      document.getElementById("panel-users").innerHTML =
        '<h3 style="margin:0 0 12px">Cloud users</h3>'
        + '<div class="row" style="margin-bottom:10px"><button type="button" class="btn-ghost" data-act="refresh-users">Refresh</button></div>'
        + "<table><thead><tr><th>User</th><th>Role</th><th>WS</th><th>Joined</th><th>Actions</th></tr></thead><tbody>"
        + (rows || '<tr><td colspan="5">No users yet</td></tr>')
        + "</tbody></table>";
    });
  }

  function loadWa() {
    return api("/api/admin/wa-clients").then(function (d) {
      var rows = (d.clients || []).map(function (c) {
        return "<tr>"
          + "<td><div>" + esc(c.name || "—") + '</div><div style="color:var(--muted);font-size:.75rem">' + esc(c.phone) + "</div></td>"
          + "<td>" + esc(c.email || "—") + "</td>"
          + "<td>" + (c.registered ? "yes" : "no") + "</td>"
          + "<td>" + esc(c.source || "") + "</td>"
          + '<td><button type="button" class="btn-danger" data-act="delwa" data-phone="' + esc(c.phone) + '">Remove</button></td></tr>';
      }).join("");
      document.getElementById("panel-wa").innerHTML =
        '<h3 style="margin:0 0 12px">WhatsApp clients</h3>'
        + "<table><thead><tr><th>Client</th><th>Email</th><th>Reg</th><th>Source</th><th></th></tr></thead><tbody>"
        + (rows || '<tr><td colspan="5">None yet</td></tr>')
        + "</tbody></table>";
    });
  }

  function loadTickets() {
    return api("/api/admin/tickets").then(function (d) {
      var rows = (d.tickets || []).map(function (t) {
        return "<tr>"
          + "<td>" + esc(t.customer_name || "—") + '<div style="color:var(--muted);font-size:.75rem">' + esc(t.customer_phone || "") + "</div></td>"
          + "<td>" + esc(t.device || "—") + "</td>"
          + "<td>" + esc(t.issue || "—") + "</td>"
          + "<td>" + esc((t.urgency || "") + " / " + (t.status || "new")) + "</td>"
          + '<td class="row">'
          + '<button type="button" class="btn" data-act="ticket" data-id="' + esc(t.id) + '" data-status="in_progress">In progress</button>'
          + '<button type="button" class="btn-ok" data-act="ticket" data-id="' + esc(t.id) + '" data-status="done">Done</button>'
          + "</td></tr>";
      }).join("");
      document.getElementById("panel-tickets").innerHTML =
        '<h3 style="margin:0 0 12px">Job intake</h3>'
        + "<table><thead><tr><th>Customer</th><th>Device</th><th>Issue</th><th>Status</th><th></th></tr></thead><tbody>"
        + (rows || '<tr><td colspan="5">No tickets</td></tr>')
        + "</tbody></table>";
    });
  }

  function loadNotifs() {
    return api("/api/admin/notifications").then(function (d) {
      var rows = (d.notifications || []).map(function (n) {
        return "<tr>"
          + "<td>" + esc(n.type || "") + "</td>"
          + "<td><b>" + esc(n.title || "") + '</b><div style="color:var(--muted)">' + esc(n.body || "") + "</div></td>"
          + '<td style="font-size:.75rem">' + esc(String(n.created_at || "").replace("T", " ").slice(0, 19)) + "</td></tr>";
      }).join("");
      document.getElementById("panel-notifs").innerHTML =
        '<h3 style="margin:0 0 12px">Notifications</h3>'
        + '<div class="row" style="margin-bottom:10px"><button type="button" class="btn-ghost" data-act="clear-notifs">Clear all</button></div>'
        + "<table><thead><tr><th>Type</th><th>Message</th><th>When</th></tr></thead><tbody>"
        + (rows || '<tr><td colspan="3">None</td></tr>')
        + "</tbody></table>";
    });
  }

  document.getElementById("loginBtn").addEventListener("click", login);
  document.getElementById("logoutBtn").addEventListener("click", logout);
  document.getElementById("password").addEventListener("keydown", function (e) {
    if (e.key === "Enter") login();
  });
  document.getElementById("email").addEventListener("keydown", function (e) {
    if (e.key === "Enter") login();
  });
  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () {
      tab(t.getAttribute("data-tab"));
    });
  });

  document.body.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var act = btn.getAttribute("data-act");
    if (act === "refresh-users") {
      loadUsers().catch(function (err) { toast(err.message); });
    } else if (act === "reset") {
      if (!confirm("Generate a temporary password for this user?")) return;
      api("/api/admin/users/" + btn.getAttribute("data-id") + "/reset-password", { method: "POST", body: {} })
        .then(function (d) {
          prompt("Temporary password (copy now):", d.temporary_password);
          toast("Password reset for " + d.email);
        })
        .catch(function (err) { toast(err.message); });
    } else if (act === "deluser") {
      var email = btn.getAttribute("data-email");
      if (!confirm("Delete account " + email + " and their workspace?")) return;
      api("/api/admin/users/" + btn.getAttribute("data-id"), { method: "DELETE" })
        .then(function () { toast("Deleted " + email); return refreshAll(); })
        .catch(function (err) { toast(err.message); });
    } else if (act === "delwa") {
      var phone = btn.getAttribute("data-phone");
      if (!confirm("Remove WA profile " + phone + "?")) return;
      api("/api/admin/wa-clients/" + phone, { method: "DELETE" })
        .then(function () { toast("Removed"); return loadWa(); })
        .catch(function (err) { toast(err.message); });
    } else if (act === "ticket") {
      api("/api/admin/tickets/" + btn.getAttribute("data-id"), {
        method: "PATCH",
        body: { status: btn.getAttribute("data-status") }
      })
        .then(function () { toast("Ticket updated"); return loadTickets(); })
        .catch(function (err) { toast(err.message); });
    } else if (act === "clear-notifs") {
      api("/api/admin/notifications/clear", { method: "POST", body: {} })
        .then(function () { toast("Cleared"); return loadNotifs(); })
        .catch(function (err) { toast(err.message); });
    }
  });

  if (token) showApp();
})();
</script>
</body>
</html>`;

module.exports = { mountAdmin };
