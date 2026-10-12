/**
 * SA Invoice Pro – Sync Server v3.0.0
 * Full Q1–Q10 competitive stack
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
const { mountPortal } = require('./portal');
const { mountWaFlow } = require('./wa-flow');
const { mountArBrain } = require('./ar-brain');
const { mountQuarters } = require('./quarters');
const { mountQuartersLate } = require('./quarters-late');

const app = express();
const PORT = process.env.PORT || 3847;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DEFAULT_STATUS_TOKEN = 'SaIpStAtUs_7f3a9c2e1b8d4f6a0e5c9b3d7a1f4e8';
const STATUS_TOKEN_RAW = process.env.STATUS_API_TOKEN || DEFAULT_STATUS_TOKEN;
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://saip-sync.onrender.com';
const RESET_TOKEN_HOURS = 1;
const BUSINESS_OWNER_ID = process.env.BUSINESS_OWNER_USER_ID || null;

function buildAllowedTokens() {
  const set = new Set();
  for (const part of String(STATUS_TOKEN_RAW).split(',')) {
    const t = part.trim();
    if (t) set.add(t);
  }
  set.add(DEFAULT_STATUS_TOKEN);
  return set;
}
const ALLOWED_STATUS_TOKENS = buildAllowedTokens();

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const WORKSPACES_FILE = path.join(DATA_DIR, 'workspaces.json');
const STATUS_FILE = path.join(DATA_DIR, 'invoice_status.json');
const RESET_FILE = path.join(DATA_DIR, 'password_resets.json');
const TICKETS_FILE = path.join(DATA_DIR, 'tickets_intake.json');
const WA_CLIENTS_FILE = path.join(DATA_DIR, 'wa_clients.json');
const NOTIFS_FILE = path.join(DATA_DIR, 'notifications.json');

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
let waClients = loadJson(WA_CLIENTS_FILE, {});
let notifications = loadJson(NOTIFS_FILE, { items: [] });

function persistUsers() { saveJson(USERS_FILE, users); }
function persistWorkspaces() { saveJson(WORKSPACES_FILE, workspaces); }
function persistStatus() { saveJson(STATUS_FILE, invoiceStatus); }
function persistResets() { saveJson(RESET_FILE, passwordResets); }
function persistTickets() { saveJson(TICKETS_FILE, ticketsIntake); }
function persistWaClients() { saveJson(WA_CLIENTS_FILE, waClients); }
function persistNotifs() { saveJson(NOTIFS_FILE, notifications); }

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

function extractStatusToken(req) {
  const q = req.query.token;
  const h = req.headers['x-status-token'];
  const authH = req.headers.authorization;
  let t = q || h || '';
  if (!t && authH && authH.toLowerCase().startsWith('bearer ')) t = authH.slice(7);
  return String(t || '').trim();
}

function statusAuth(req, res, next) {
  const token = extractStatusToken(req);
  if (!token || !ALLOWED_STATUS_TOKENS.has(token)) {
    return res.type('text/plain').status(403).send('⚠️ Invalid status token.\n\nReply *menu* for options.');
  }
  next();
}

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).replace(/\D/g, '');
  if (s.startsWith('0') && s.length === 10) s = '27' + s.slice(1);
  if (s.length < 9) return null;
  return s;
}

function moneyR(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'R0.00';
  return 'R' + v.toFixed(2);
}

function pushNotification(n) {
  if (!Array.isArray(notifications.items)) notifications.items = [];
  const item = {
    id: uuidv4(), type: n.type || 'info', title: n.title || 'Update', body: n.body || '',
    payload: n.payload || {}, owner_user_id: n.owner_user_id || BUSINESS_OWNER_ID || null,
    read: false, created_at: now(),
  };
  notifications.items.unshift(item);
  notifications.items = notifications.items.slice(0, 200);
  persistNotifs();
  return item;
}

function formatInvoiceText(inv, found) {
  if (!found || !inv) {
    return ['📄 *Invoice status*', '', 'Sorry — invoice not found or not linked to this WhatsApp number.', 'Use your exact number (e.g. INV-2026-0001).', '', 'Reply *menu* for options.'].join('\n');
  }
  const lines = ['📄 *Invoice ' + inv.invoice_number + '*', '', '👤 ' + (inv.client_name || 'Client'), '💵 Total: ' + moneyR(inv.total), '💳 Balance: ' + moneyR(inv.balance_due), '📊 Status: *' + String(inv.status || 'unpaid').toUpperCase() + '*'];
  if (inv.due_date) lines.push('📅 Due: ' + String(inv.due_date).slice(0, 10));
  lines.push('', 'Reply *menu* for more options.');
  return lines.join('\n');
}

function normalizeInvoiceQuery(raw) {
  let s = String(raw || '').trim().toUpperCase();
  s = s.replace(/\s+/g, '');
  if (/^INV\d+$/.test(s)) s = 'INV-' + s.slice(3);
  return s;
}

function findInvoiceStatus(numberRaw, phoneLock) {
  const number = normalizeInvoiceQuery(numberRaw);
  if (!number) return null;
  const all = Object.values(invoiceStatus);
  let matches = all.filter(r => r.invoice_number === number);
  if (!matches.length) {
    const loose = number.replace(/[^A-Z0-9]/g, '');
    matches = all.filter(r => String(r.invoice_number || '').replace(/[^A-Z0-9]/g, '') === loose);
  }
  if (phoneLock) {
    const locked = matches.filter(r => r.client_phone && r.client_phone === phoneLock);
    if (locked.length) matches = locked;
    else if (matches.some(r => r.client_phone)) return { denied: true };
  }
  matches.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  return matches[0] || null;
}

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
  res.json({ ok: true, message: 'If that email exists, a reset link was created.', reset_url: `${PUBLIC_BASE}/reset-password?token=${token}`, expires_in_hours: RESET_TOKEN_HOURS });
});

app.post('/api/auth/reset-password', (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 6) return res.status(400).json({ error: 'Valid token and password required' });
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
  indexWorkspaceClients(req.user.id, data);
  res.json({ ok: true, version: newVersion, updated_at: ts });
});

function indexWorkspaceClients(userId, data) {
  const clients = data?.clients || [];
  for (const c of clients) {
    const phone = normalizePhone(c.phone);
    if (!phone) continue;
    const existing = waClients[phone];
    if (existing && existing.source === 'whatsapp_register' && !existing.linked_client_id) {
      waClients[phone] = { ...existing, name: existing.name || c.name, email: existing.email || c.email, linked_client_id: c.id, owner_user_id: userId, updated_at: now() };
    } else if (!existing) {
      waClients[phone] = { id: uuidv4(), phone, name: c.name || null, email: c.email || null, company: c.company || null, address: c.address || null, source: 'app_sync', linked_client_id: c.id, owner_user_id: userId, registered: true, created_at: now(), updated_at: now() };
    } else {
      waClients[phone] = { ...existing, name: c.name || existing.name, email: c.email || existing.email, linked_client_id: c.id || existing.linked_client_id, owner_user_id: userId, registered: true, updated_at: now() };
    }
  }
  persistWaClients();
}

app.post('/api/status/push', auth, (req, res) => {
  const invoices = Array.isArray(req.body?.invoices) ? req.body.invoices : [req.body];
  const ts = now();
  let count = 0;
  for (const inv of invoices) {
    if (!inv || !inv.invoice_number) continue;
    const number = normalizeInvoiceQuery(inv.invoice_number);
    const key = `${req.user.id}::${number}`;
    invoiceStatus[key] = { id: inv.id || uuidv4(), user_id: req.user.id, invoice_number: number, client_name: inv.client_name || null, client_phone: normalizePhone(inv.client_phone), total: inv.total ?? null, balance_due: inv.balance_due ?? null, status: inv.status || 'unpaid', due_date: inv.due_date || null, last_payment_at: inv.last_payment_at || null, updated_at: ts };
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
    const number = normalizeInvoiceQuery(inv.number || inv.invoiceNumber || inv.id);
    if (!number) continue;
    const client = (workspace.clients || []).find(c => c.id === inv.clientId) || {};
    const total = Number(inv.total || inv.grandTotal || 0);
    const paid = Number(inv.amountPaid || inv.paid || 0);
    const balance = Math.max(0, total - paid);
    let status = 'unpaid';
    if (balance <= 0) status = 'paid';
    else if (paid > 0) status = 'partial';
    else if (inv.dueDate && new Date(inv.dueDate) < new Date()) status = 'overdue';
    invoiceStatus[`${userId}::${number}`] = { id: inv.id || uuidv4(), user_id: userId, invoice_number: number, client_name: client.name || inv.clientName || null, client_phone: normalizePhone(client.phone || inv.clientPhone), total, balance_due: balance, status, due_date: inv.dueDate || null, last_payment_at: inv.lastPaymentAt || null, updated_at: ts };
  }
  persistStatus();
}

app.get('/api/status/verify', (req, res) => {
  const token = extractStatusToken(req);
  if (!token) return res.type('text/plain').send('FAIL: no token');
  if (ALLOWED_STATUS_TOKENS.has(token)) return res.type('text/plain').send('OK: token valid');
  return res.type('text/plain').status(403).send('FAIL: invalid token');
});

app.get('/api/status/invoice', statusAuth, (req, res) => {
  let number = String(req.query.number || '').trim();
  const phone = normalizePhone(req.query.phone || '');
  if (!number || number === '$1') return res.type('text/plain').send('Invoice number required.');
  const inv = findInvoiceStatus(number, phone || null);
  if (inv && inv.denied) return res.type('text/plain').send('🔒 Not linked to this number.');
  if (!inv) return res.type('text/plain').send(formatInvoiceText(null, false));
  return res.type('text/plain').send(formatInvoiceText(inv, true));
});

app.get('/api/notifications', auth, (req, res) => {
  let items = notifications.items || [];
  res.json({ ok: true, count: items.length, unread: items.filter(n => !n.read).length, notifications: items.slice(0, 50) });
});

app.post('/api/notifications/read', auth, (req, res) => {
  for (const item of (notifications.items || [])) { if (req.body?.all) item.read = true; }
  persistNotifs();
  res.json({ ok: true });
});

app.get('/api/wa/pending', auth, (req, res) => {
  const list = Object.values(waClients).filter(c => c.pending_import || (c.source === 'whatsapp_register' && !c.linked_client_id));
  res.json({ ok: true, count: list.length, clients: list });
});

app.get('/', (req, res) => {
  res.json({
    name: 'SA Invoice Pro Sync',
    version: '3.0.0',
    features: ['ar_brain_v2', 'q1_q10_complete', 'client_portal', 'cloud_api_dual_stub'],
    ar: PUBLIC_BASE + '/api/ar',
    quarters: PUBLIC_BASE + '/api/quarters',
  });
});

app.get('/health', (req, res) => res.json({ ok: true, ts: now(), version: '3.0.0' }));

mountPortal(app, { DATA_DIR, loadJson, saveJson, workspaces, auth, PUBLIC_BASE, now });

const quartersApi = mountQuarters(app, {
  DATA_DIR, loadJson, saveJson, workspaces, invoiceStatus, waClients,
  auth, statusAuth, now, pushNotification, PUBLIC_BASE,
});

mountQuartersLate(app, {
  DATA_DIR, loadJson, saveJson, workspaces, invoiceStatus, waClients,
  auth, statusAuth, now, pushNotification, PUBLIC_BASE,
});

mountArBrain(app, {
  waClients, workspaces, invoiceStatus, ticketsIntake,
  persistTickets, persistWaClients, pushNotification, now, uuidv4,
  ALLOWED_STATUS_TOKENS, DEFAULT_STATUS_TOKEN,
  getPayConfig: () => quartersApi.getPayConfig(),
});

mountWaFlow(app, {
  statusAuth, normalizePhone, waClients, workspaces, invoiceStatus,
  ticketsIntake, persistTickets, pushNotification, now, uuidv4, PUBLIC_BASE,
});

app.listen(PORT, () => {
  console.log(`SAIP Sync v3.0.0 on port ${PORT}`);
});
