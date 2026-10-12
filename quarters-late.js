/**
 * Q5–Q10 competitive modules
 * Q5 Inventory low-stock alerts
 * Q6 SLA auto-escalation
 * Q7 Analytics / reports API
 * Q8 Public ops / status page data
 * Q9 Official Cloud API dual-mode stubs (Meta-ready)
 * Q10 Audit log + backup export + rate guard
 */
const path = require('path');
const { v4: uuidv4 } = require('uuid');

function moneyR(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'R0.00';
  return 'R' + v.toFixed(2);
}

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).replace(/\D/g, '');
  if (s.startsWith('0') && s.length === 10) s = '27' + s.slice(1);
  if (s.length < 9) return null;
  return s;
}

function mountQuartersLate(app, ctx) {
  const {
    DATA_DIR,
    loadJson,
    saveJson,
    workspaces,
    invoiceStatus,
    waClients,
    auth,
    statusAuth,
    now,
    pushNotification,
    PUBLIC_BASE,
  } = ctx;

  const AUDIT_FILE = path.join(DATA_DIR, 'audit_log.json');
  const SLA_FILE = path.join(DATA_DIR, 'sla_escalations.json');
  const CLOUD_FILE = path.join(DATA_DIR, 'cloud_api_config.json');
  const RATE_FILE = path.join(DATA_DIR, 'rate_hits.json');

  let auditLog = loadJson(AUDIT_FILE, { items: [] });
  let slaEscalations = loadJson(SLA_FILE, { items: [] });
  let cloudApi = loadJson(CLOUD_FILE, {
    mode: 'unofficial_ar', // unofficial_ar | dual | official_only
    meta_phone_number_id: '',
    meta_waba_id: '',
    meta_access_token: '',
    verify_token: 'saip-verify',
    enabled: false,
  });
  let rateHits = loadJson(RATE_FILE, {});

  function persistAudit() { saveJson(AUDIT_FILE, auditLog); }
  function persistSla() { saveJson(SLA_FILE, slaEscalations); }
  function persistCloud() { saveJson(CLOUD_FILE, cloudApi); }
  function persistRate() { saveJson(RATE_FILE, rateHits); }

  function audit(action, detail, userId) {
    if (!Array.isArray(auditLog.items)) auditLog.items = [];
    auditLog.items.unshift({
      id: uuidv4(),
      action,
      detail: detail || {},
      user_id: userId || null,
      at: now(),
    });
    auditLog.items = auditLog.items.slice(0, 1000);
    persistAudit();
  }

  // Simple in-memory rate guard (per IP key)
  app.use((req, res, next) => {
    try {
      const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.ip || 'unknown';
      const key = ip + '|' + (req.path || '').slice(0, 40);
      const minute = Math.floor(Date.now() / 60000);
      const rk = key + '|' + minute;
      rateHits[rk] = (rateHits[rk] || 0) + 1;
      // purge old keys occasionally
      if (Math.random() < 0.01) {
        for (const k of Object.keys(rateHits)) {
          const m = Number(k.split('|').pop());
          if (m < minute - 5) delete rateHits[k];
        }
        persistRate();
      }
      if (rateHits[rk] > 120) {
        return res.status(429).json({ error: 'rate_limited', retry_after_seconds: 60 });
      }
    } catch {}
    next();
  });

  // ——— Q5 Inventory low-stock ———
  function collectLowStock() {
    const out = [];
    for (const [uid, row] of Object.entries(workspaces || {})) {
      const products = row?.data?.products || [];
      for (const p of products) {
        const qty = Number(p.stock ?? p.quantity ?? p.qty);
        const min = Number(p.minStock ?? p.reorderLevel ?? p.lowStockAt ?? 5);
        if (!Number.isFinite(qty)) continue;
        if (qty <= min) {
          out.push({
            user_id: uid,
            product_id: p.id,
            name: p.name || p.title || 'Product',
            sku: p.sku || null,
            stock: qty,
            min_stock: min,
            unit: p.unit || null,
          });
        }
      }
    }
    out.sort((a, b) => a.stock - b.stock);
    return out;
  }

  app.get('/api/inventory/low-stock', auth, (req, res) => {
    const items = collectLowStock().filter((i) => i.user_id === req.user.id);
    res.json({ ok: true, count: items.length, items });
  });

  app.post('/api/inventory/alert-scan', auth, (req, res) => {
    const items = collectLowStock().filter((i) => i.user_id === req.user.id);
    for (const it of items.slice(0, 20)) {
      pushNotification({
        type: 'inventory_low',
        title: 'Low stock: ' + it.name,
        body: `Stock ${it.stock} (min ${it.min_stock})`,
        payload: it,
        owner_user_id: req.user.id,
      });
    }
    audit('inventory_alert_scan', { count: items.length }, req.user.id);
    res.json({ ok: true, alerted: Math.min(20, items.length), count: items.length, items });
  });

  // WA text for stock (staff token)
  app.get('/api/inventory/low-stock/text', statusAuth, (req, res) => {
    // Aggregate all workspaces for status-token staff view
    const items = collectLowStock().slice(0, 15);
    if (!items.length) {
      return res.type('text/plain').send('✅ No low-stock items.\n\n0️⃣ Menu');
    }
    const lines = ['📦 *Low stock alert*', ''];
    for (const it of items) {
      lines.push(`• *${it.name}* — ${it.stock} (min ${it.min_stock})`);
    }
    lines.push('', '0️⃣ Menu');
    res.type('text/plain').send(lines.join('\n'));
  });

  // ——— Q6 SLA auto-escalation ———
  function scanSlaBreaches() {
    const breaches = [];
    for (const [uid, row] of Object.entries(workspaces || {})) {
      const data = row?.data || {};
      const clients = data.clients || [];
      const tickets = data.tickets || [];
      const timeEntries = data.timeEntries || data.time_entries || [];

      for (const c of clients) {
        const cap = Number(c.slaHoursCap ?? c.sla_hours_cap);
        if (!Number.isFinite(cap) || cap <= 0) continue;
        const clientTickets = tickets.filter((t) => String(t.clientId) === String(c.id));
        const openTickets = clientTickets.filter(
          (t) => !['closed', 'resolved', 'cancelled'].includes(String(t.status || '').toLowerCase())
        );
        let used = 0;
        for (const te of timeEntries) {
          if (String(te.clientId) === String(c.id)) {
            used += Number(te.hours ?? te.durationHours ?? (te.minutes ? te.minutes / 60 : 0)) || 0;
          }
        }
        // Fallback: sum ticket time fields
        if (!used) {
          for (const t of clientTickets) {
            used += Number(t.hoursSpent ?? t.timeHours ?? 0) || 0;
          }
        }
        const ratio = used / cap;
        if (ratio >= 0.8 || openTickets.some((t) => t.slaBreached)) {
          breaches.push({
            user_id: uid,
            client_id: c.id,
            client_name: c.name,
            client_phone: normalizePhone(c.phone),
            sla_cap_hours: cap,
            used_hours: Math.round(used * 100) / 100,
            ratio,
            open_jobs: openTickets.length,
            level: ratio >= 1 ? 'breached' : 'warning',
          });
        }
      }
    }
    return breaches;
  }

  app.get('/api/sla/breaches', auth, (req, res) => {
    const items = scanSlaBreaches().filter((b) => b.user_id === req.user.id);
    res.json({ ok: true, count: items.length, items });
  });

  app.post('/api/sla/escalate', auth, (req, res) => {
    const items = scanSlaBreaches().filter((b) => b.user_id === req.user.id);
    const created = [];
    for (const b of items) {
      const rec = {
        id: uuidv4(),
        ...b,
        escalated_at: now(),
        by_user_id: req.user.id,
      };
      if (!Array.isArray(slaEscalations.items)) slaEscalations.items = [];
      slaEscalations.items.unshift(rec);
      created.push(rec);
      pushNotification({
        type: 'sla_escalation',
        title: b.level === 'breached' ? 'SLA BREACHED' : 'SLA warning',
        body: `${b.client_name}: ${b.used_hours}h / ${b.sla_cap_hours}h`,
        payload: b,
        owner_user_id: req.user.id,
      });
    }
    slaEscalations.items = (slaEscalations.items || []).slice(0, 300);
    persistSla();
    audit('sla_escalate', { count: created.length }, req.user.id);
    res.json({ ok: true, escalated: created.length, items: created });
  });

  // ——— Q7 Analytics ———
  app.get('/api/analytics/summary', auth, (req, res) => {
    const ws = workspaces[req.user.id]?.data || {};
    const invoices = ws.invoices || [];
    const payments = ws.payments || [];
    const expenses = ws.expenses || [];
    const tickets = ws.tickets || [];
    const quotes = ws.quotes || [];

    let paidSales = 0;
    let outstanding = 0;
    let overdueCount = 0;
    for (const inv of invoices) {
      const total = Number(inv.total || inv.grandTotal || 0);
      const paid = Number(inv.amountPaid || inv.paid || 0);
      const bal = Math.max(0, total - paid);
      const st = String(inv.status || '').toLowerCase();
      if (st === 'paid' || bal <= 0) paidSales += total;
      else {
        outstanding += bal;
        if (st === 'overdue' || (inv.dueDate && new Date(inv.dueDate) < new Date())) overdueCount++;
      }
    }
    const paySum = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const expSum = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const openJobs = tickets.filter(
      (t) => !['closed', 'resolved', 'cancelled'].includes(String(t.status || '').toLowerCase())
    ).length;

    const summary = {
      invoices_total: invoices.length,
      quotes_total: quotes.length,
      paid_sales: paidSales,
      payments_logged: paySum,
      outstanding_ar: outstanding,
      overdue_count: overdueCount,
      expenses: expSum,
      net_approx: paySum - expSum,
      open_jobs: openJobs,
      clients: (ws.clients || []).length,
      collection_rate:
        paidSales + outstanding > 0
          ? Math.round((paidSales / (paidSales + outstanding)) * 1000) / 10
          : 100,
    };

    res.json({ ok: true, summary, generated_at: now() });
  });

  app.get('/api/analytics/summary/text', statusAuth, (req, res) => {
    // Staff snapshot across first workspace with data
    let best = null;
    for (const [uid, row] of Object.entries(workspaces || {})) {
      if (row?.data?.invoices?.length) {
        best = uid;
        break;
      }
    }
    if (!best) {
      return res.type('text/plain').send('No workspace data synced yet.\n\n0️⃣ Menu');
    }
    // Reuse logic inline briefly
    const ws = workspaces[best].data;
    const invoices = ws.invoices || [];
    let outstanding = 0;
    let overdueCount = 0;
    for (const inv of invoices) {
      const total = Number(inv.total || 0);
      const paid = Number(inv.amountPaid || inv.paid || 0);
      const bal = Math.max(0, total - paid);
      if (bal > 0) {
        outstanding += bal;
        if (String(inv.status).toLowerCase() === 'overdue') overdueCount++;
      }
    }
    res.type('text/plain').send(
      [
        '📊 *Business snapshot*',
        '',
        'Invoices: ' + invoices.length,
        'Outstanding AR: *' + moneyR(outstanding) + '*',
        'Overdue: ' + overdueCount,
        'Clients: ' + (ws.clients || []).length,
        '',
        '0️⃣ Menu',
      ].join('\n')
    );
  });

  // ——— Q8 Ops / public status ———
  app.get('/api/ops/status', (req, res) => {
    const wsCount = Object.keys(workspaces || {}).length;
    const invCount = Object.keys(invoiceStatus || {}).length;
    const waCount = Object.keys(waClients || {}).length;
    res.json({
      ok: true,
      service: 'SA Invoice Pro Sync',
      version: '3.0.0',
      uptime_s: Math.floor(process.uptime()),
      workspaces: wsCount,
      invoice_status_rows: invCount,
      wa_clients: waCount,
      cloud_api_mode: cloudApi.mode,
      ts: now(),
    });
  });

  // ——— Q9 Meta Cloud API dual-mode stubs ———
  app.get('/api/cloud-api/config', auth, (req, res) => {
    res.json({
      ok: true,
      config: {
        mode: cloudApi.mode,
        meta_phone_number_id: cloudApi.meta_phone_number_id,
        meta_waba_id: cloudApi.meta_waba_id,
        has_token: !!cloudApi.meta_access_token,
        verify_token: cloudApi.verify_token,
        enabled: !!cloudApi.enabled,
      },
    });
  });

  app.put('/api/cloud-api/config', auth, (req, res) => {
    const b = req.body || {};
    if (b.mode) cloudApi.mode = b.mode;
    if (b.meta_phone_number_id != null) cloudApi.meta_phone_number_id = String(b.meta_phone_number_id);
    if (b.meta_waba_id != null) cloudApi.meta_waba_id = String(b.meta_waba_id);
    if (b.meta_access_token != null) cloudApi.meta_access_token = String(b.meta_access_token);
    if (b.verify_token != null) cloudApi.verify_token = String(b.verify_token);
    if (b.enabled != null) cloudApi.enabled = !!b.enabled;
    cloudApi.updated_at = now();
    persistCloud();
    audit('cloud_api_config', { mode: cloudApi.mode, enabled: cloudApi.enabled }, req.user.id);
    res.json({ ok: true, config: { ...cloudApi, meta_access_token: cloudApi.meta_access_token ? '***' : '' } });
  });

  // Meta webhook verification + inbound stub
  app.get('/api/cloud-api/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === cloudApi.verify_token) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  });

  app.post('/api/cloud-api/webhook', (req, res) => {
    // Acknowledge immediately — process async later
    audit('cloud_api_inbound', { keys: Object.keys(req.body || {}) }, null);
    // Future: map Meta messages into same route() as AR brain
    res.status(200).json({ ok: true });
  });

  app.post('/api/cloud-api/send-template-stub', auth, (req, res) => {
    if (!cloudApi.enabled || cloudApi.mode === 'unofficial_ar') {
      return res.status(400).json({
        error: 'official_cloud_disabled',
        hint: 'Set mode to dual or official_only and enabled=true after Meta approval',
      });
    }
    const { to, template_name, language, components } = req.body || {};
    if (!to || !template_name) {
      return res.status(400).json({ error: 'to and template_name required' });
    }
    // Stub only — does not call Meta until token configured for production
    const payload = {
      messaging_product: 'whatsapp',
      to: normalizePhone(to),
      type: 'template',
      template: {
        name: template_name,
        language: { code: language || 'en' },
        components: components || [],
      },
    };
    audit('cloud_api_template_stub', payload, req.user.id);
    res.json({
      ok: true,
      stub: true,
      message: 'Template payload prepared. Wire Meta Graph API when WABA is live.',
      payload,
    });
  });

  // ——— Q10 Audit + backup export ———
  app.get('/api/audit', auth, (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    res.json({ ok: true, count: (auditLog.items || []).length, items: (auditLog.items || []).slice(0, limit) });
  });

  app.get('/api/backup/export', auth, (req, res) => {
    const ws = workspaces[req.user.id] || null;
    const exportData = {
      exported_at: now(),
      version: '3.0.0',
      user_id: req.user.id,
      workspace: ws,
      invoice_status: Object.fromEntries(
        Object.entries(invoiceStatus || {}).filter(([, v]) => v.user_id === req.user.id)
      ),
    };
    audit('backup_export', { size: JSON.stringify(exportData).length }, req.user.id);
    res.setHeader('Content-Disposition', `attachment; filename="saip-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(exportData);
  });

  app.get('/api/quarters', (req, res) => {
    res.json({
      ok: true,
      version: '3.0.0',
      quarters: {
        Q1: 'AR brain + identity gate',
        Q2: 'Pay config + overdue reminders',
        Q3: 'Multi-agent inbox',
        Q4: 'Quote accept/reject/deposit',
        Q5: 'Inventory low-stock alerts',
        Q6: 'SLA escalation',
        Q7: 'Analytics summary',
        Q8: 'Ops status',
        Q9: 'Meta Cloud API dual-mode stubs',
        Q10: 'Audit log + backup export + rate guard',
      },
    });
  });

  return { audit, collectLowStock, scanSlaBreaches };
}

module.exports = { mountQuartersLate };
