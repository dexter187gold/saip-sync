/**
 * SA Invoice Pro – Sync Server v1.2.1
 * Default status replies = plain text (AutoResponder)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3847;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const STATUS_TOKEN = process.env.STATUS_API_TOKEN || 'dev-status-token';
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://saip-sync.onrender.com';
const RESET_TOKEN_HOURS = 1;

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const WORKSPACES_FILE = path.join(DATA_DIR, 'workspaces.json');
const STATUS_FILE = path.join(DATA_DIR, 'invoice_status.json');
const RESET_FILE = path.join(DATA_DIR, 'password_resets.json');
const TICKETS_FILE = path.join(DATA_DIR, 'tickets_intake.json');

function loadJson(file, fallback = {}) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('loadJson', file, e.message);
  }
  return fallback;
}
function saveJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

let users = loadJson(USERS_FILE, {});
let workspaces = loadJson(WORKSPACES_FILE, {});
let invoiceStatus = loadJson(STATUS_FILE, {});
let passwordResets = loadJson(RESET_FILE, {});
let ticketsIntake = loadJson(TICKETS_FILE, { items: [] });

function persistUsers() { saveJson(USERS_FILE, users); }
function persistWorkspaces() { saveJson(WORKSPACES_FILE, workspaces); }
function persistStatus() { saveJson(STATUS_FILE, invoiceStatus); }
function persistResets() { saveJson(RESET_FILE, passwordResets); }
function persistTickets() { saveJson(TICKETS_FILE, ticketsIntake); }

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));

function now() { return new Date().toISOString(); }

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

function wantsText(req) {
  const format = String(req.query.format || 'text').toLowerCase();
  return format !== 'json';
}

function statusAuth(req, res, next) {
  const token = req.query.token || req.headers['x-status-token'];
  if (token !== STATUS_TOKEN) {
    if (wantsText(req)) {
      return res.type('text/plain').status(403).send(
        '⚠️ Invalid status token.\n\nFix: Render → Environment → STATUS_API_TOKEN must match the token in your AutoResponder URL.\n\nReply *menu* for options.'
      );
    }
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

function moneyR(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'R0.00';
  return 'R' + v.toFixed(2);
}

function formatInvoiceText(inv, found) {
  if (!found || !inv) {
    return [
      '📄 *Invoice status*',
      '',
      'Sorry — that invoice number was not found.',
      'Please check the number (e.g. INV-0042) and try again.',
      '',
      'Reply *menu* for more options.',
    ].join('\n');
  }
  const lines = [
    '📄 *Invoice ' + inv.invoice_number + '*',
    '',
    '👤 ' + (inv.client_name || 'Client'),
    '💵 Total: ' + moneyR(inv.total),
    '💳 Balance: ' + moneyR(inv.balance_due),
    '📊 Status: *' + String(inv.status || 'unpaid').toUpperCase() + '*',
  ];
  if (inv.due_date) lines.push('📅 Due: ' + String(inv.due_date).slice(0, 10));
  lines.push('', 'Reply *menu* for more options.');
  return lines.join('\n');
}

app.get('/register', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.type('html').send('<p>Use API or app Cloud login. <a href="/forgot-password">Forgot password</a></p>'));
app.get('/forgot-password', (req, res) => res.type('html').send('<form method="post" action="/api/auth/forgot-password"><input name="email" type="email" required/><button>Reset</button></form>'));

app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || password.length < 6) return res.status(400).json({ error: 'Email and password (min 6 chars) required' });
  const key = email.toLowerCase().trim();
  if (users[key]) return res.status(409).json({ error: 'Email already registered' });
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  const ts = now();
  users[key] = { id, email: key, password_hash: hash, name: name || null, created_at: ts, updated_at: ts };
  workspaces[id] = { data: { clients: [], invoices: [], tickets: [], settings: {} }, version: 1, updated_at: ts };
  persistUsers(); persistWorkspaces();
  const token = jwt.sign({ id, email: key }, JWT_SECRET, { expiresIn: '90d' });
  res.json({ ok: true, token, user: { id, email: key, name } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const key = email.toLowerCase().trim();
  const user = users[key];
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '90d' });
  res.json({ ok: true, token, user: { id: user.id, email: user.email, name: user.name } });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = Object.values(users).find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, created_at: user.created_at } });
});

app.post('/api/auth/forgot-password', (req, res) => {
  const email = (req.body?.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required' });
  const user = users[email];
  if (!user) return res.json({ ok: true, message: 'If that email exists, a reset link was created.' });
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RESET_TOKEN_HOURS * 60 * 60 * 1000).toISOString();
  passwordResets[token] = { email, expires, used: false, created_at: now() };
  persistResets();
  const reset_url = `${PUBLIC_BASE}/reset-password?token=${token}`;
  res.json({ ok: true, message: 'If that email exists, a reset link was created.', reset_url, expires_in_hours: RESET_TOKEN_HOURS });
});

app.post('/api/auth/reset-password', (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 6) return res.status(400).json({ error: 'Valid token and password (min 6) required' });
  const rec = passwordResets[token];
  if (!rec || rec.used) return res.status(400).json({ error: 'Invalid or already used reset link' });
  if (new Date(rec.expires) < new Date()) return res.status(400).json({ error: 'Reset link has expired' });
  const user = users[rec.email];
  if (!user) return res.status(400).json({ error: 'User no longer exists' });
  user.password_hash = bcrypt.hashSync(password, 10);
  user.updated_at = now();
  rec.used = true;
  persistUsers(); persistResets();
  res.json({ ok: true, message: 'Password updated' });
});

app.get('/api/workspace', auth, (req, res) => {
  const row = workspaces[req.user.id];
  if (!row) return res.status(404).json({ error: 'No workspace' });
  res.json({ ok: true, version: row.version, updated_at: row.updated_at, data: row.data });
});

app.put('/api/workspace', auth, (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data object required' });
  const current = workspaces[req.user.id] || { version: 0 };
  const newVersion = (current.version || 0) + 1;
  const ts = now();
  workspaces[req.user.id] = { data, version: newVersion, updated_at: ts };
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
      id: inv.id || uuidv4(), user_id: req.user.id, invoice_number: number,
      client_name: inv.client_name || null, client_phone: normalizePhone(inv.client_phone),
      total: inv.total ?? null, balance_due: inv.balance_due ?? null,
      status: inv.status || 'unpaid', due_date: inv.due_date || null,
      last_payment_at: inv.last_payment_at || null, updated_at: ts,
    };
    count++;
  }
  persistStatus();
  res.json({ ok: true, count });
});

function syncInvoiceStatus(userId, workspace) {
  const invoices = workspace?.invoices || [];
  if (!Array.isArray(invoices) || !invoices.length) return;
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
    invoiceStatus[`${userId}::${num}`] = {
      id: inv.id || uuidv4(), user_id: userId, invoice_number: num,
      client_name: client.name || inv.clientName || null,
      client_phone: normalizePhone(client.phone || inv.clientPhone),
      total, balance_due: balance, status,
      due_date: inv.dueDate || null, last_payment_at: inv.lastPaymentAt || null, updated_at: ts,
    };
  }
  persistStatus();
}

/** DEFAULT = plain text for AutoResponder. Use format=json only if needed. */
app.get('/api/status/invoice', statusAuth, (req, res) => {
  const number = (req.query.number || '').trim().toUpperCase();
  const asJson = String(req.query.format || '').toLowerCase() === 'json';
  if (!number) {
    if (!asJson) return res.type('text/plain').send('Invoice number required. Reply with e.g. INV-0042');
    return res.status(400).json({ error: 'number required' });
  }
  const matches = Object.values(invoiceStatus).filter(r => r.invoice_number === number)
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  if (!matches.length) {
    if (!asJson) return res.type('text/plain').send(formatInvoiceText(null, false));
    return res.json({ ok: true, found: false, message: 'Invoice not found' });
  }
  const inv = matches[0];
  if (!asJson) return res.type('text/plain').send(formatInvoiceText(inv, true));
  res.json({
    ok: true, found: true, invoice_number: inv.invoice_number, client_name: inv.client_name,
    total: inv.total, balance_due: inv.balance_due, status: inv.status,
    due_date: inv.due_date, last_payment_at: inv.last_payment_at, updated_at: inv.updated_at,
    reply: formatInvoiceText(inv, true),
  });
});

app.get('/api/status/client', statusAuth, (req, res) => {
  let phone = (req.query.phone || '').replace(/\D/g, '');
  if (phone.startsWith('0') && phone.length === 10) phone = '27' + phone.slice(1);
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const rows = Object.values(invoiceStatus)
    .filter(r => r.client_phone === phone && r.status !== 'paid')
    .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || '')).slice(0, 10);
  res.json({ ok: true, found: rows.length > 0, count: rows.length, invoices: rows });
});

app.post('/api/tickets/intake', statusAuth, (req, res) => {
  const b = req.body || {};
  const customer_name = (b.customer_name || b.name || '').trim();
  const customer_phone = normalizePhone(b.customer_phone || b.phone);
  const device = (b.device || '').trim();
  const issue = (b.issue || b.description || '').trim();
  if (!customer_name && !customer_phone) return res.status(400).json({ error: 'customer_name or phone required' });
  const ticket = {
    id: uuidv4(), source: b.source || 'whatsapp',
    customer_name: customer_name || null, customer_phone,
    device: device || null, issue: issue || null,
    urgency: (b.urgency || 'normal').toLowerCase(), status: 'new', created_at: now(),
  };
  if (!Array.isArray(ticketsIntake.items)) ticketsIntake.items = [];
  ticketsIntake.items.unshift(ticket);
  ticketsIntake.items = ticketsIntake.items.slice(0, 500);
  persistTickets();
  res.json({ ok: true, ticket });
});

app.get('/api/tickets/intake', auth, (req, res) => {
  const status = (req.query.status || 'new').toLowerCase();
  const items = (ticketsIntake.items || []).filter(t => status === 'all' ? true : (t.status || 'new') === status);
  res.json({ ok: true, count: items.length, tickets: items });
});

app.patch('/api/tickets/intake/:id', auth, (req, res) => {
  const item = (ticketsIntake.items || []).find(t => t.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Ticket not found' });
  if (req.body?.status) item.status = req.body.status;
  item.updated_at = now();
  persistTickets();
  res.json({ ok: true, ticket: item });
});

app.get('/', (req, res) => {
  res.json({
    name: 'SA Invoice Pro Sync',
    version: '1.2.1',
    autoresponder: {
      note: 'Invoice status returns PLAIN TEXT by default. Add format=json only if needed.',
      url: 'GET /api/status/invoice?number=INV-1&token=YOUR_STATUS_API_TOKEN',
    },
  });
});

app.get('/health', (req, res) => res.json({ ok: true, ts: now(), version: '1.2.1' }));

app.listen(PORT, () => {
  console.log(`SAIP Sync v1.2.1 on port ${PORT}`);
  console.log(`Status token: ${STATUS_TOKEN.slice(0, 6)}…`);
});
