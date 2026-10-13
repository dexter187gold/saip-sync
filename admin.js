/**
 * SA Invoice Pro – Admin Portal v4.1.0
 * Brain Control Lab · full actions · force-register · outbox · tools
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { ensureDefaultAdmin, DEFAULT_EMAIL, DEFAULT_PASSWORD } = require('./admin-seed');
const path = require('path');
const fs = require('fs');

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

  function digits(p) {
    return String(p || '').replace(/\D/g, '');
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
    let outboxPending = 0;
    try {
      const outbox = loadJson(path.join(DATA_DIR, 'wa_outbox.json'), { items: [] });
      outboxPending = (outbox.items || []).filter((i) => !i.delivered).length;
    } catch {}
    res.json({
      ok: true,
      stats: {
        users: userList.length,
        workspaces: Object.keys(workspaces || {}).length,
        wa_clients: waList.length,
        wa_registered: waList.filter((c) => c.registered).length,
        wa_pending_import: waList.filter((c) => c.pending_import).length,
        tickets_open: tickets.filter((t) => t.status === 'new' || !t.status).length,
        tickets_total: tickets.length,
        invoice_status_rows: invs.length,
        outstanding_ar: openAr,
        notifications: (notifications?.items || []).length,
        outbox_pending: outboxPending,
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
    if (isAdminUser(user) && String(user.email).toLowerCase() === DEFAULT_EMAIL) {
      return res.status(400).json({ error: 'Cannot delete the primary lab admin' });
    }
    const key = Object.keys(users).find((k) => users[k].id === user.id);
    if (key) delete users[key];
    if (workspaces[user.id]) delete workspaces[user.id];
    persistUsers();
    persistWorkspaces();
    res.json({ ok: true, deleted: user.email });
  });

  app.patch('/api/admin/users/:id', adminAuth, (req, res) => {
    const user = Object.values(users).find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const b = req.body || {};
    if (b.name != null) user.name = String(b.name).trim() || null;
    if (b.role === 'admin' || b.role === 'user') user.role = b.role;
    user.updated_at = now();
    persistUsers();
    res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  });

  app.get('/api/admin/wa-clients', adminAuth, (req, res) => {
    const list = Object.values(waClients || {}).map((c) => ({
      id: c.id,
      phone: c.phone,
      name: c.name,
      email: c.email,
      company: c.company,
      address: c.address,
      city: c.city,
      registered: !!c.registered,
      source: c.source,
      pending_import: !!c.pending_import,
      linked_client_id: c.linked_client_id || null,
      owner_user_id: c.owner_user_id || null,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));
    list.sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
    res.json({ ok: true, count: list.length, clients: list });
  });

  app.delete('/api/admin/wa-clients/:phone', adminAuth, (req, res) => {
    const phone = digits(req.params.phone);
    if (!waClients[phone]) return res.status(404).json({ error: 'Not found' });
    delete waClients[phone];
    persistWaClients();
    res.json({ ok: true, deleted: phone });
  });

  app.patch('/api/admin/wa-clients/:phone', adminAuth, (req, res) => {
    const phone = digits(req.params.phone);
    const c = waClients[phone];
    if (!c) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    if (b.name != null) c.name = String(b.name).trim() || c.name;
    if (b.email != null) c.email = String(b.email).trim() || null;
    if (b.company != null) c.company = String(b.company).trim() || null;
    if (b.registered != null) c.registered = !!b.registered;
    if (b.pending_import != null) c.pending_import = !!b.pending_import;
    if (b.linked_client_id != null) c.linked_client_id = b.linked_client_id || null;
    c.updated_at = now();
    persistWaClients();
    res.json({ ok: true, client: c });
  });

  app.post('/api/admin/wa-clients/:phone/force-register', adminAuth, (req, res) => {
    const phone = digits(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'Invalid phone' });
    let c = waClients[phone];
    if (!c) {
      c = {
        id: uuidv4(),
        phone,
        name: (req.body && req.body.name) || 'Client',
        email: (req.body && req.body.email) || null,
        source: 'admin_force',
        registered: true,
        pending_import: true,
        created_at: now(),
        updated_at: now(),
      };
      waClients[phone] = c;
    } else {
      c.registered = true;
      c.updated_at = now();
      if (req.body && req.body.name) c.name = req.body.name;
      if (req.body && req.body.email) c.email = req.body.email;
    }
    persistWaClients();
    res.json({ ok: true, client: c });
  });

  app.get('/api/admin/tickets', adminAuth, (req, res) => {
    const items = (ticketsIntake?.items || []).slice(0, 150);
    res.json({ ok: true, count: items.length, tickets: items });
  });

  app.patch('/api/admin/tickets/:id', adminAuth, (req, res) => {
    const items = ticketsIntake?.items || [];
    const t = items.find((x) => String(x.id) === String(req.params.id));
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (req.body?.status) t.status = req.body.status;
    if (req.body?.note != null) t.admin_note = req.body.note;
    if (req.body?.urgency) t.urgency = req.body.urgency;
    t.updated_at = now();
    persistTickets();
    res.json({ ok: true, ticket: t });
  });

  app.delete('/api/admin/tickets/:id', adminAuth, (req, res) => {
    if (!ticketsIntake || !Array.isArray(ticketsIntake.items)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const before = ticketsIntake.items.length;
    ticketsIntake.items = ticketsIntake.items.filter((x) => String(x.id) !== String(req.params.id));
    if (ticketsIntake.items.length === before) return res.status(404).json({ error: 'Not found' });
    persistTickets();
    res.json({ ok: true, deleted: req.params.id });
  });

  app.get('/api/admin/invoices', adminAuth, (req, res) => {
    const list = Object.values(invoiceStatus || {}).map((i) => ({
      invoice_number: i.invoice_number,
      client_name: i.client_name,
      client_phone: i.client_phone,
      total: i.total,
      balance_due: i.balance_due,
      status: i.status,
      due_date: i.due_date,
      updated_at: i.updated_at,
    }));
    list.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    res.json({ ok: true, count: list.length, invoices: list.slice(0, 120) });
  });

  app.get('/api/admin/outbox', adminAuth, (req, res) => {
    try {
      const OUTBOX_FILE = path.join(DATA_DIR, 'wa_outbox.json');
      const outbox = loadJson(OUTBOX_FILE, { items: [] });
      const items = (outbox.items || []).slice(0, 50);
      res.json({ ok: true, count: items.length, pending: items.filter((i) => !i.delivered).length, messages: items });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/outbox/queue', adminAuth, (req, res) => {
    try {
      const phone = digits(req.body?.phone);
      const message = String(req.body?.message || '').trim();
      if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
      const OUTBOX_FILE = path.join(DATA_DIR, 'wa_outbox.json');
      const outbox = loadJson(OUTBOX_FILE, { items: [] });
      if (!Array.isArray(outbox.items)) outbox.items = [];
      const item = {
        id: uuidv4(),
        phone,
        message,
        meta: { source: 'admin_portal', ...(req.body?.meta || {}) },
        created_at: now(),
        delivered: false,
      };
      outbox.items.unshift(item);
      outbox.items = outbox.items.slice(0, 300);
      saveJson(OUTBOX_FILE, outbox);
      res.json({ ok: true, item });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/outbox/ack', adminAuth, (req, res) => {
    try {
      const ids = req.body?.ids || (req.body?.id ? [req.body.id] : []);
      const OUTBOX_FILE = path.join(DATA_DIR, 'wa_outbox.json');
      const outbox = loadJson(OUTBOX_FILE, { items: [] });
      let n = 0;
      for (const item of outbox.items || []) {
        if (item.delivered) continue;
        if (!ids.length || ids.map(String).includes(String(item.id))) {
          item.delivered = true;
          item.delivered_at = now();
          n++;
        }
      }
      saveJson(OUTBOX_FILE, outbox);
      res.json({ ok: true, acked: n });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/admin/lookup', adminAuth, (req, res) => {
    const phone = digits(req.query.phone);
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const client = waClients[phone] || null;
    const tickets = (ticketsIntake?.items || []).filter(
      (t) => digits(t.customer_phone) === phone
    );
    const invoices = Object.values(invoiceStatus || {}).filter(
      (i) => digits(i.client_phone) === phone
    );
    res.json({
      ok: true,
      phone,
      registered: !!(client && client.registered),
      client,
      tickets,
      invoices,
    });
  });

  app.get('/api/admin/notifications', adminAuth, (req, res) => {
    const items = (notifications?.items || []).slice(0, 50);
    res.json({ ok: true, count: items.length, notifications: items });
  });

  app.post('/api/admin/notifications/clear', adminAuth, (req, res) => {
    if (notifications) notifications.items = [];
    if (typeof ctx.persistNotifs === 'function') ctx.persistNotifs();
    res.json({ ok: true });
  });

  app.get('/admin', (req, res) => {
    let html;
    try {
      html = fs.readFileSync(path.join(__dirname, 'admin-portal.html'), 'utf8');
    } catch (e) {
      console.error('[admin] admin-portal.html missing', e.message);
      html = '<!DOCTYPE html><html><body style="font-family:system-ui;background:#0c0a14;color:#f0e6ff;padding:2rem"><h1>Admin portal HTML missing</h1><p>Redeploy admin-portal.html</p></body></html>';
    }
    res.type('html').send(html);
  });

  try {
    const { mountIntakeApi } = require('./intake-api');
    mountIntakeApi(app, {
      auth,
      waClients,
      persistWaClients,
      ticketsIntake,
      persistTickets,
      now,
    });
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
        return res.type('text/plain').status(403).send('⚠️ Invalid status token.');
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

  console.log('[admin] portal v4.1.0 mounted at /admin');
}

module.exports = { mountAdmin };
