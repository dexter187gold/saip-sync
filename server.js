/**
 * SA Invoice Pro – Sync Server v1.0
 * Multi-device workspace sync + public status API for AutoResponder
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3847;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const STATUS_TOKEN = process.env.STATUS_API_TOKEN || 'dev-status-token';

// ─── Database ───────────────────────────────────────────────────────────────
const dbPath = path.join(__dirname, 'data', 'saip.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL,               -- full JSON workspace
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );

  -- Lightweight status table for fast AutoResponder lookups
  CREATE TABLE IF NOT EXISTS invoice_status (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invoice_number TEXT NOT NULL,
    client_name TEXT,
    client_phone TEXT,
    total REAL,
    balance_due REAL,
    status TEXT NOT NULL,              -- unpaid | partial | paid | overdue
    due_date TEXT,
    last_payment_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, invoice_number)
  );

  CREATE INDEX IF NOT EXISTS idx_inv_number ON invoice_status(invoice_number);
  CREATE INDEX IF NOT EXISTS idx_inv_phone ON invoice_status(client_phone);
`);

// ─── Helpers ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '15mb' })); // workspace can be large

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

// ─── Auth routes ────────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Email and password (min 6 chars) required' });
  }
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  const ts = now();
  try {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, email.toLowerCase().trim(), hash, name || null, ts, ts);

    // empty workspace
    db.prepare(
      `INSERT INTO workspaces (user_id, data, version, updated_at)
       VALUES (?, ?, 1, ?)`
    ).run(id, JSON.stringify({ clients: [], invoices: [], tickets: [], settings: {} }), ts);

    const token = jwt.sign({ id, email }, JWT_SECRET, { expiresIn: '90d' });
    res.json({ ok: true, token, user: { id, email, name } });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    console.error(e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
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
  const user = db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, user });
});

// ─── Workspace sync ─────────────────────────────────────────────────────────
/** Pull full workspace */
app.get('/api/workspace', auth, (req, res) => {
  const row = db.prepare('SELECT data, version, updated_at FROM workspaces WHERE user_id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'No workspace' });
  res.json({
    ok: true,
    version: row.version,
    updated_at: row.updated_at,
    data: JSON.parse(row.data),
  });
});

/** Push full workspace (last-write-wins for v1) */
app.put('/api/workspace', auth, (req, res) => {
  const { data, version } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'data object required' });
  }

  const current = db.prepare('SELECT version FROM workspaces WHERE user_id = ?').get(req.user.id);
  const newVersion = (current?.version || 0) + 1;
  const ts = now();

  db.prepare(
    `INSERT INTO workspaces (user_id, data, version, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       data = excluded.data,
       version = excluded.version,
       updated_at = excluded.updated_at`
  ).run(req.user.id, JSON.stringify(data), newVersion, ts);

  // Keep invoice_status table in sync for fast public lookups
  syncInvoiceStatus(req.user.id, data);

  res.json({ ok: true, version: newVersion, updated_at: ts });
});

/** Lightweight status-only push (called when invoice is created/paid) */
app.post('/api/status/push', auth, (req, res) => {
  const invoices = Array.isArray(req.body?.invoices) ? req.body.invoices : [req.body];
  const ts = now();
  const upsert = db.prepare(`
    INSERT INTO invoice_status
      (id, user_id, invoice_number, client_name, client_phone, total, balance_due, status, due_date, last_payment_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, invoice_number) DO UPDATE SET
      client_name = excluded.client_name,
      client_phone = excluded.client_phone,
      total = excluded.total,
      balance_due = excluded.balance_due,
      status = excluded.status,
      due_date = excluded.due_date,
      last_payment_at = excluded.last_payment_at,
      updated_at = excluded.updated_at
  `);

  const tx = db.transaction((list) => {
    for (const inv of list) {
      if (!inv.invoice_number) continue;
      upsert.run(
        inv.id || uuidv4(),
        req.user.id,
        String(inv.invoice_number).trim().toUpperCase(),
        inv.client_name || null,
        normalizePhone(inv.client_phone),
        inv.total ?? null,
        inv.balance_due ?? null,
        inv.status || 'unpaid',
        inv.due_date || null,
        inv.last_payment_at || null,
        ts
      );
    }
  });
  tx(invoices);
  res.json({ ok: true, count: invoices.length });
});

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).replace(/\D/g, '');
  if (s.startsWith('0') && s.length === 10) s = '27' + s.slice(1); // SA local → intl
  return s || null;
}

function syncInvoiceStatus(userId, workspace) {
  const invoices = workspace?.invoices || [];
  if (!Array.isArray(invoices) || invoices.length === 0) return;

  const ts = now();
  const upsert = db.prepare(`
    INSERT INTO invoice_status
      (id, user_id, invoice_number, client_name, client_phone, total, balance_due, status, due_date, last_payment_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, invoice_number) DO UPDATE SET
      client_name = excluded.client_name,
      client_phone = excluded.client_phone,
      total = excluded.total,
      balance_due = excluded.balance_due,
      status = excluded.status,
      due_date = excluded.due_date,
      last_payment_at = excluded.last_payment_at,
      updated_at = excluded.updated_at
  `);

  const tx = db.transaction((list) => {
    for (const inv of list) {
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

      upsert.run(
        inv.id || uuidv4(),
        userId,
        String(number).trim().toUpperCase(),
        client.name || inv.clientName || null,
        normalizePhone(client.phone || inv.clientPhone),
        total,
        balance,
        status,
        inv.dueDate || null,
        inv.lastPaymentAt || null,
        ts
      );
    }
  });
  tx(invoices);
}

// ─── Public Status API (for AutoResponder) ──────────────────────────────────
app.get('/api/status/invoice', statusAuth, (req, res) => {
  const number = (req.query.number || '').trim().toUpperCase();
  if (!number) return res.status(400).json({ error: 'number required' });

  const rows = db.prepare(
    `SELECT invoice_number, client_name, client_phone, total, balance_due, status, due_date, last_payment_at, updated_at
     FROM invoice_status WHERE invoice_number = ? ORDER BY updated_at DESC LIMIT 5`
  ).all(number);

  if (!rows.length) {
    return res.json({ ok: true, found: false, message: 'Invoice not found' });
  }

  // Prefer the most recently updated
  const inv = rows[0];
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

  const rows = db.prepare(
    `SELECT invoice_number, client_name, total, balance_due, status, due_date, updated_at
     FROM invoice_status
     WHERE client_phone = ? AND status != 'paid'
     ORDER BY due_date ASC, updated_at DESC
     LIMIT 10`
  ).all(phone);

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
    version: '1.0.0',
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
  console.log(`SAIP Sync listening on http://localhost:${PORT}`);
  console.log(`Status token: ${STATUS_TOKEN.slice(0, 6)}…`);
});
