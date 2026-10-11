/**
 * SA Invoice Pro – Sync Server v1.0.2
 * Multi-device workspace sync + public status API for AutoResponder
 * Pure JS storage (no native modules) – works on Render free tier
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3847;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const STATUS_TOKEN = process.env.STATUS_API_TOKEN || 'dev-status-token';

// ─── File-based storage (atomic JSON) ───────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const WORKSPACES_FILE = path.join(DATA_DIR, 'workspaces.json');
const STATUS_FILE = path.join(DATA_DIR, 'invoice_status.json');

function loadJson(file, fallback = {}) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    console.error('loadJson error', file, e.message);
  }
  return fallback;
}

function saveJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// In-memory cache + disk persistence
let users = loadJson(USERS_FILE, {});
let workspaces = loadJson(WORKSPACES_FILE, {});
let invoiceStatus = loadJson(STATUS_FILE, {}); // key: `${userId}::${invoiceNumber}`

function persistUsers() { saveJson(USERS_FILE, users); }
function persistWorkspaces() { saveJson(WORKSPACES_FILE, workspaces); }
function persistStatus() { saveJson(STATUS_FILE, invoiceStatus); }

// ─── Helpers ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));

function now() {
  return new Date().toISOString();
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function statusAuth(req, res, next) {
  const token = req.query.token || req.headers['x-status-token'];
  if (token !== STATUS_TOKEN) {
    return res.status(403).json({ error: 'Invalid status token' });
  }
  next();
}

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).replace(/\D/g, '');
  if (s.startsWith('0') && s.length === 10) s = '27' + s.slice(1);
  return s || null;
}

// ─── Mobile-friendly Register / Login pages ─────────────────────────────────
const PAGE_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; font-family: system-ui, -apple-system, sans-serif;
    background: linear-gradient(160deg, #0f172a 0%, #0b3d2e 100%);
    display: flex; align-items: center; justify-content: center; padding: 20px;
    color: #0f172a;
  }
  .card {
    background: #fff; border-radius: 20px; width: 100%; max-width: 400px;
    box-shadow: 0 20px 50px rgba(0,0,0,.35); overflow: hidden;
  }
  .header {
    background: #007A4D; color: #fff; padding: 28px 24px; text-align: center;
  }
  .header h1 { margin: 0 0 6px; font-size: 1.4rem; }
  .header p { margin: 0; opacity: .9; font-size: .9rem; }
  .body { padding: 24px; }
  label { display: block; font-size: .8rem; font-weight: 600; color: #475569; margin-bottom: 4px; }
  input {
    width: 100%; padding: 14px 12px; margin-bottom: 14px; border: 1px solid #e2e8f0;
    border-radius: 12px; font-size: 16px;
  }
  input:focus { outline: 2px solid #007A4D; border-color: #007A4D; }
  button {
    width: 100%; padding: 14px; border: 0; border-radius: 12px;
    background: #007A4D; color: #fff; font-size: 1rem; font-weight: 700;
    cursor: pointer; margin-top: 4px;
  }
  button:active { transform: scale(.98); }
  .msg { margin-top: 14px; padding: 12px; border-radius: 10px; font-size: .9rem; display: none; }
  .msg.ok { display: block; background: #ecfdf5; color: #065f46; }
  .msg.err { display: block; background: #fef2f2; color: #991b1b; }
  .switch { text-align: center; margin-top: 18px; font-size: .9rem; color: #64748b; }
  .switch a { color: #007A4D; font-weight: 600; text-decoration: none; }
`;

function authPage({ title, subtitle, mode }) {
  const isRegister = mode === 'register';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
  <title>${title} – SA Invoice Pro Sync</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>${title}</h1>
      <p>${subtitle}</p>
    </div>
    <div class="body">
      <form id="form">
        ${isRegister ? '<label>Name (optional)</label><input id="name" type="text" placeholder="Your name" autocomplete="name"/>' : ''}
        <label>Email</label>
        <input id="email" type="email" placeholder="you@example.com" required autocomplete="email"/>
        <label>Password (min 6 characters)</label>
        <input id="password" type="password" placeholder="••••••••" required minlength="6" autocomplete="${isRegister ? 'new-password' : 'current-password'}"/>
        <button type="submit">${isRegister ? 'Create Account' : 'Login'}</button>
      </form>
      <div id="msg" class="msg"></div>
      <div class="switch">
        ${isRegister
          ? 'Already have an account? <a href="/login">Login</a>'
          : 'No account yet? <a href="/register">Register</a>'}
      </div>
    </div>
  </div>
  <script>
    const form = document.getElementById('form');
    const msg = document.getElementById('msg');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.className = 'msg';
      msg.textContent = 'Please wait…';
      msg.style.display = 'block';
      const payload = {
        email: document.getElementById('email').value.trim(),
        password: document.getElementById('password').value
      };
      ${isRegister ? 'payload.name = document.getElementById("name").value.trim() || undefined;' : ''}
      try {
        const res = await fetch('/api/auth/${isRegister ? 'register' : 'login'}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.ok) {
          msg.className = 'msg ok';
          msg.innerHTML = '✅ <strong>Success!</strong><br>Email: ' + data.user.email +
            '<br><br>You can now close this page and use these details in SA Invoice Pro.';
          form.reset();
        } else {
          msg.className = 'msg err';
          msg.textContent = '❌ ' + (data.error || 'Something went wrong');
        }
      } catch (err) {
        msg.className = 'msg err';
        msg.textContent = '❌ Network error: ' + err.message;
      }
    });
  </script>
</body>
</html>`;
}

app.get('/register', (req, res) => {
  res.type('html').send(authPage({
    title: 'Create Account',
    subtitle: 'SA Invoice Pro Cloud Sync',
    mode: 'register',
  }));
});

app.get('/login', (req, res) => {
  res.type('html').send(authPage({
    title: 'Login',
    subtitle: 'SA Invoice Pro Cloud Sync',
    mode: 'login',
  }));
});

// ─── Auth routes ────────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Email and password (min 6 chars) required' });
  }
  const key = email.toLowerCase().trim();
  if (users[key]) {
    return res.status(409).json({ error: 'Email already registered' });
  }
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  const ts = now();
  users[key] = {
    id,
    email: key,
    password_hash: hash,
    name: name || null,
    created_at: ts,
    updated_at: ts,
  };
  workspaces[id] = {
    data: { clients: [], invoices: [], tickets: [], settings: {} },
    version: 1,
    updated_at: ts,
  };
  persistUsers();
  persistWorkspaces();

  const token = jwt.sign({ id, email: key }, JWT_SECRET, { expiresIn: '90d' });
  res.json({ ok: true, token, user: { id, email: key, name } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const key = email.toLowerCase().trim();
  const user = users[key];
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '90d' });
  res.json({
    ok: true,
    token,
    user: { id: user.id, email: user.email, name: user.name },
  });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = Object.values(users).find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, created_at: user.created_at } });
});

// ─── Workspace sync ─────────────────────────────────────────────────────────
app.get('/api/workspace', auth, (req, res) => {
  const row = workspaces[req.user.id];
  if (!row) return res.status(404).json({ error: 'No workspace' });
  res.json({
    ok: true,
    version: row.version,
    updated_at: row.updated_at,
    data: row.data,
  });
});

app.put('/api/workspace', auth, (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'data object required' });
  }

  const current = workspaces[req.user.id] || { version: 0 };
  const newVersion = (current.version || 0) + 1;
  const ts = now();

  workspaces[req.user.id] = {
    data,
    version: newVersion,
    updated_at: ts,
  };
  persistWorkspaces();

  syncInvoiceStatus(req.user.id, data);

  res.json({ ok: true, version: newVersion, updated_at: ts });
});

app.post('/api/status/push', auth, (req, res) => {
  const invoices = Array.isArray(req.body?.invoices) ? req.body.invoices : [req.body];
  const ts = now();
  let count = 0;

  for (const inv of invoices) {
    if (!inv || !inv.invoice_number) continue;
    const number = String(inv.invoice_number).trim().toUpperCase();
    const key = `${req.user.id}::${number}`;
    invoiceStatus[key] = {
      id: inv.id || uuidv4(),
      user_id: req.user.id,
      invoice_number: number,
      client_name: inv.client_name || null,
      client_phone: normalizePhone(inv.client_phone),
      total: inv.total ?? null,
      balance_due: inv.balance_due ?? null,
      status: inv.status || 'unpaid',
      due_date: inv.due_date || null,
      last_payment_at: inv.last_payment_at || null,
      updated_at: ts,
    };
    count++;
  }
  persistStatus();
  res.json({ ok: true, count });
});

function syncInvoiceStatus(userId, workspace) {
  const invoices = workspace?.invoices || [];
  if (!Array.isArray(invoices) || invoices.length === 0) return;

  const ts = now();
  for (const inv of invoices) {
    const number = inv.number || inv.invoiceNumber || inv.id;
    if (!number) continue;
    const client = (workspace.clients || []).find(c => c.id === inv.clientId) || {};
    const total = Number(inv.total || inv.grandTotal || 0);
    const paid = Number(inv.amountPaid || inv.paid || 0);
    const balance = Math.max(0, total - paid);
    let status = 'unpaid';
    if (balance <= 0) status = 'paid';
    else if (paid > 0) status = 'partial';
    else if (inv.dueDate && new Date(inv.dueDate) < new Date()) status = 'overdue';

    const num = String(number).trim().toUpperCase();
    const key = `${userId}::${num}`;
    invoiceStatus[key] = {
      id: inv.id || uuidv4(),
      user_id: userId,
      invoice_number: num,
      client_name: client.name || inv.clientName || null,
      client_phone: normalizePhone(client.phone || inv.clientPhone),
      total,
      balance_due: balance,
      status,
      due_date: inv.dueDate || null,
      last_payment_at: inv.lastPaymentAt || null,
      updated_at: ts,
    };
  }
  persistStatus();
}

// ─── Public Status API (for AutoResponder) ──────────────────────────────────
app.get('/api/status/invoice', statusAuth, (req, res) => {
  const number = (req.query.number || '').trim().toUpperCase();
  if (!number) return res.status(400).json({ error: 'number required' });

  const matches = Object.values(invoiceStatus)
    .filter(r => r.invoice_number === number)
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));

  if (!matches.length) {
    return res.json({ ok: true, found: false, message: 'Invoice not found' });
  }

  const inv = matches[0];
  res.json({
    ok: true,
    found: true,
    invoice_number: inv.invoice_number,
    client_name: inv.client_name,
    total: inv.total,
    balance_due: inv.balance_due,
    status: inv.status,
    due_date: inv.due_date,
    last_payment_at: inv.last_payment_at,
    updated_at: inv.updated_at,
  });
});

app.get('/api/status/client', statusAuth, (req, res) => {
  let phone = (req.query.phone || '').replace(/\D/g, '');
  if (phone.startsWith('0') && phone.length === 10) phone = '27' + phone.slice(1);
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const rows = Object.values(invoiceStatus)
    .filter(r => r.client_phone === phone && r.status !== 'paid')
    .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''))
    .slice(0, 10)
    .map(r => ({
      invoice_number: r.invoice_number,
      client_name: r.client_name,
      total: r.total,
      balance_due: r.balance_due,
      status: r.status,
      due_date: r.due_date,
      updated_at: r.updated_at,
    }));

  res.json({
    ok: true,
    found: rows.length > 0,
    count: rows.length,
    invoices: rows,
  });
});

// ─── Health ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: 'SA Invoice Pro Sync',
    version: '1.0.2',
    storage: 'json-file',
    pages: ['/register', '/login'],
    endpoints: {
      auth: ['POST /api/auth/register', 'POST /api/auth/login', 'GET /api/auth/me'],
      workspace: ['GET /api/workspace', 'PUT /api/workspace'],
      status: ['POST /api/status/push', 'GET /api/status/invoice', 'GET /api/status/client'],
    },
  });
});

app.get('/health', (req, res) => res.json({ ok: true, ts: now() }));

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`SAIP Sync v1.0.2 listening on port ${PORT}`);
  console.log(`Status token starts with: ${STATUS_TOKEN.slice(0, 6)}…`);
});
