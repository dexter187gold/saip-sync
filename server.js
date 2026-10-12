/**
 * SA Invoice Pro – Sync Server v1.2.0
 * Multi-device sync · public status · forgot password · ticket intake · WA bot skeleton
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

function statusAuth(req, res, next) {
  const token = req.query.token || req.headers['x-status-token'];
  if (token !== STATUS_TOKEN) return res.status(403).json({ error: 'Invalid status token' });
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

/** AutoResponder-ready plain text templates */
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

const PAGE_CSS = `* { box-sizing: border-box; } body { margin: 0; min-height: 100vh; font-family: system-ui, sans-serif; background: linear-gradient(160deg, #0f172a 0%, #0b3d2e 100%); display: flex; align-items: center; justify-content: center; padding: 20px; } .card { background: #fff; border-radius: 20px; width: 100%; max-width: 400px; box-shadow: 0 20px 50px rgba(0,0,0,.35); overflow: hidden; } .header { background: #007A4D; color: #fff; padding: 28px 24px; text-align: center; } .header h1 { margin: 0 0 6px; font-size: 1.4rem; } .header p { margin: 0; opacity: .9; font-size: .9rem; } .body { padding: 24px; } label { display: block; font-size: .8rem; font-weight: 600; color: #475569; margin-bottom: 4px; } input { width: 100%; padding: 14px 12px; margin-bottom: 14px; border: 1px solid #e2e8f0; border-radius: 12px; font-size: 16px; } button { width: 100%; padding: 14px; border: 0; border-radius: 12px; background: #007A4D; color: #fff; font-size: 1rem; font-weight: 700; cursor: pointer; } .msg { margin-top: 14px; padding: 12px; border-radius: 10px; font-size: .9rem; display: none; } .msg.ok { display: block; background: #ecfdf5; color: #065f46; } .msg.err { display: block; background: #fef2f2; color: #991b1b; } .switch { text-align: center; margin-top: 18px; font-size: .9rem; color: #64748b; } .switch a { color: #007A4D; font-weight: 600; text-decoration: none; } .hint { font-size: .8rem; color: #64748b; margin: -8px 0 12px; }`;

function authPage({ title, subtitle, mode }) {
  const isRegister = mode === 'register';
  const isForgot = mode === 'forgot';
  const isReset = mode === 'reset';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title><style>${PAGE_CSS}</style></head><body><div class="card"><div class="header"><h1>${title}</h1><p>${subtitle}</p></div><div class="body"><form id="form">${isRegister ? '<label>Name</label><input id="name" type="text"/>' : ''}${isReset ? '' : '<label>Email</label><input id="email" type="email" required/>'}${isForgot ? '<p class="hint">Reset link valid 1 hour.</p>' : ''}${!isForgot ? '<label>Password</label><input id="password" type="password" required minlength="6"/>' : ''}${isReset ? '<label>Confirm</label><input id="password2" type="password" required minlength="6"/>' : ''}<button type="submit">${isRegister ? 'Create Account' : isForgot ? 'Send reset link' : isReset ? 'Set new password' : 'Login'}</button></form><div id="msg" class="msg"></div><div class="switch">${mode === 'login' ? '<a href="/register">Register</a> · <a href="/forgot-password">Forgot?</a>' : '<a href="/login">Login</a>'}</div></div></div><script>const form=document.getElementById('form');const msg=document.getElementById('msg');const params=new URLSearchParams(location.search);const resetToken=params.get('token')||'';form.addEventListener('submit',async(e)=>{e.preventDefault();msg.className='msg';msg.textContent='Please wait…';msg.style.display='block';try{let url,payload;${isForgot ? "url='/api/auth/forgot-password';payload={email:document.getElementById('email').value.trim()};" : isReset ? "const p1=document.getElementById('password').value;const p2=document.getElementById('password2').value;if(p1!==p2){msg.className='msg err';msg.textContent='Passwords do not match';return;}url='/api/auth/reset-password';payload={token:resetToken,password:p1};" : isRegister ? "url='/api/auth/register';payload={email:document.getElementById('email').value.trim(),password:document.getElementById('password').value,name:(document.getElementById('name')||{}).value};" : "url='/api/auth/login';payload={email:document.getElementById('email').value.trim(),password:document.getElementById('password').value};"}const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await res.json();if(data.ok){msg.className='msg ok';msg.innerHTML=${isForgot ? "'✅ Reset link: '+(data.reset_url||'check email')" : "'✅ Success'"};}else{msg.className='msg err';msg.textContent='❌ '+(data.error||'Error');}}catch(err){msg.className='msg err';msg.textContent='❌ '+err.message;}});</script></body></html>`;
}

app.get('/register', (req, res) => res.type('html').send(authPage({ title: 'Create Account', subtitle: 'SA Invoice Pro Cloud Sync', mode: 'register' })));
app.get('/login', (req, res) => res.type('html').send(authPage({ title: 'Login', subtitle: 'SA Invoice Pro Cloud Sync', mode: 'login' })));
app.get('/forgot-password', (req, res) => res.type('html').send(authPage({ title: 'Forgot password', subtitle: 'Reset password', mode: 'forgot' })));
app.get('/reset-password', (req, res) => {
  if (!req.query.token) return res.redirect('/forgot-password');
  res.type('html').send(authPage({ title: 'Set new password', subtitle: 'Choose a strong password', mode: 'reset' }));
});

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
  for (const [t, rec] of Object.entries(passwordResets)) {
    if (rec.used || new Date(rec.expires) < new Date()) delete passwordResets[t];
  }
  persistResets();
  const reset_url = `${PUBLIC_BASE}/reset-password?token=${token}`;
  console.log('[password-reset]', email, reset_url);
  res.json({ ok: true, message: 'If that email exists, a reset link was created.', reset_url, expires_in_hours: RESET_TOKEN_HOURS });
});

app.post('/api/auth/reset-password', (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 6) return res.status(400).json({ error: 'Valid token and password (min 6) required' });
  const rec = passwordResets[token];
  if (!rec || rec.used) return res.status(400).json({ error: 'Invalid or already used reset link' });
  if (new Date(rec.expires) < new Date()) { delete passwordResets[token]; persistResets(); return res.status(400).json({ error: 'Reset link has expired' }); }
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

app.get('/api/status/invoice', statusAuth, (req, res) => {
  const number = (req.query.number || '').trim().toUpperCase();
  const format = String(req.query.format || 'json').toLowerCase();
  if (!number) {
    if (format === 'text' || format === 'wa') return res.type('text/plain').send('Invoice number required. Reply with e.g. INV-0042');
    return res.status(400).json({ error: 'number required' });
  }
  const matches = Object.values(invoiceStatus).filter(r => r.invoice_number === number)
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  if (!matches.length) {
    if (format === 'text' || format === 'wa') return res.type('text/plain').send(formatInvoiceText(null, false));
    return res.json({ ok: true, found: false, message: 'Invoice not found' });
  }
  const inv = matches[0];
  const payload = {
    ok: true, found: true, invoice_number: inv.invoice_number, client_name: inv.client_name,
    total: inv.total, balance_due: inv.balance_due, status: inv.status,
    due_date: inv.due_date, last_payment_at: inv.last_payment_at, updated_at: inv.updated_at,
    reply: formatInvoiceText(inv, true),
  };
  if (format === 'text' || format === 'wa') return res.type('text/plain').send(formatInvoiceText(inv, true));
  res.json(payload);
});

app.get('/api/status/client', statusAuth, (req, res) => {
  let phone = (req.query.phone || '').replace(/\D/g, '');
  if (phone.startsWith('0') && phone.length === 10) phone = '27' + phone.slice(1);
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const rows = Object.values(invoiceStatus)
    .filter(r => r.client_phone === phone && r.status !== 'paid')
    .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || '')).slice(0, 10)
    .map(r => ({
      invoice_number: r.invoice_number, client_name: r.client_name, total: r.total,
      balance_due: r.balance_due, status: r.status, due_date: r.due_date, updated_at: r.updated_at,
    }));
  res.json({ ok: true, found: rows.length > 0, count: rows.length, invoices: rows });
});

app.post('/api/tickets/intake', statusAuth, (req, res) => {
  const b = req.body || {};
  const customer_name = (b.customer_name || b.name || '').trim();
  const customer_phone = normalizePhone(b.customer_phone || b.phone);
  const device = (b.device || '').trim();
  const issue = (b.issue || b.description || '').trim();
  const urgency = (b.urgency || 'normal').toLowerCase();
  if (!customer_name && !customer_phone) return res.status(400).json({ error: 'customer_name or customer_phone required' });
  if (!issue && !device) return res.status(400).json({ error: 'issue or device required' });
  const ticket = {
    id: uuidv4(), source: b.source || 'whatsapp',
    customer_name: customer_name || null, customer_phone: customer_phone || null,
    device: device || null, issue: issue || null,
    urgency: ['normal', 'urgent', 'low'].includes(urgency) ? urgency : 'normal',
    status: 'new', created_at: now(), notes: b.notes || null, owner_user_id: b.owner_user_id || null,
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
  if (req.body?.notes != null) item.notes = req.body.notes;
  item.updated_at = now();
  persistTickets();
  res.json({ ok: true, ticket: item });
});

app.get('/api/bot/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verify = process.env.WA_VERIFY_TOKEN || 'saip-verify';
  if (mode === 'subscribe' && token === verify) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post('/api/bot/webhook', (req, res) => {
  res.sendStatus(200);
  try { console.log('[wa-webhook]', JSON.stringify(req.body || {}).slice(0, 500)); } catch (e) {}
});

app.get('/', (req, res) => {
  res.json({
    name: 'SA Invoice Pro Sync',
    version: '1.2.0',
    storage: 'json-file',
    pages: ['/register', '/login', '/forgot-password', '/reset-password'],
    endpoints: {
      auth: ['POST /api/auth/register', 'POST /api/auth/login', 'GET /api/auth/me', 'POST /api/auth/forgot-password', 'POST /api/auth/reset-password'],
      workspace: ['GET /api/workspace', 'PUT /api/workspace'],
      status: ['POST /api/status/push', 'GET /api/status/invoice', 'GET /api/status/client'],
      tickets: ['POST /api/tickets/intake', 'GET /api/tickets/intake', 'PATCH /api/tickets/intake/:id'],
      bot: ['GET|POST /api/bot/webhook'],
    },
    autoresponder: {
      invoice_text: 'GET /api/status/invoice?number=INV-1&token=TOKEN&format=text',
      note: 'Use format=text for plain WhatsApp reply body (no JSON)',
    },
  });
});

app.get('/health', (req, res) => res.json({ ok: true, ts: now(), version: '1.2.0' }));

app.listen(PORT, () => {
  console.log(`SAIP Sync v1.2.0 on port ${PORT}`);
  console.log(`Status token: ${STATUS_TOKEN.slice(0, 6)}…`);
});
