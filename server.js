/**
 * SA Invoice Pro – Sync Server v1.0.1
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

  // Keep invoice_status in sync
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

  // Find the most recently updated matching invoice across all users
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
    version: '1.0.1',
    storage: 'json-file',
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
  console.log(`SAIP Sync v1.0.1 listening on port ${PORT}`);
  console.log(`Status token starts with: ${STATUS_TOKEN.slice(0, 6)}…`);
});
