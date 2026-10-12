/**
 * Q2–Q4 competitive modules
 * Q2: overdue auto-reminders + payment banking refs
 * Q3: multi-agent inbox (assign / notes / status)
 * Q4: quote accept/reject + deposit requests via WA
 */
const crypto = require('crypto');
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

function mountQuarters(app, ctx) {
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

  const REMINDERS_FILE = path.join(DATA_DIR, 'reminders_log.json');
  const INBOX_FILE = path.join(DATA_DIR, 'agent_inbox.json');
  const QUOTE_ACTIONS_FILE = path.join(DATA_DIR, 'quote_actions.json');
  const PAY_CONFIG_FILE = path.join(DATA_DIR, 'pay_config.json');

  let remindersLog = loadJson(REMINDERS_FILE, { items: [] });
  let agentInbox = loadJson(INBOX_FILE, { items: [], agents: [] });
  let quoteActions = loadJson(QUOTE_ACTIONS_FILE, { items: [] });
  let payConfig = loadJson(PAY_CONFIG_FILE, {
    bank_name: 'Capitec',
    account_name: 'PC REPAIR DEX',
    account_number: '',
    branch_code: '',
    reference_hint: 'Use invoice number as reference',
    payfast_url: null,
  });

  function persistReminders() { saveJson(REMINDERS_FILE, remindersLog); }
  function persistInbox() { saveJson(INBOX_FILE, agentInbox); }
  function persistQuotes() { saveJson(QUOTE_ACTIONS_FILE, quoteActions); }
  function persistPay() { saveJson(PAY_CONFIG_FILE, payConfig); }

  // ——— Q2: Payment / banking config (business) ———
  app.get('/api/pay/config', auth, (req, res) => {
    res.json({ ok: true, config: payConfig });
  });

  app.put('/api/pay/config', auth, (req, res) => {
    const b = req.body || {};
    payConfig = {
      bank_name: b.bank_name || payConfig.bank_name,
      account_name: b.account_name || payConfig.account_name,
      account_number: b.account_number != null ? String(b.account_number) : payConfig.account_number,
      branch_code: b.branch_code != null ? String(b.branch_code) : payConfig.branch_code,
      reference_hint: b.reference_hint || payConfig.reference_hint,
      payfast_url: b.payfast_url != null ? b.payfast_url : payConfig.payfast_url,
      updated_at: now(),
    };
    persistPay();
    res.json({ ok: true, config: payConfig });
  });

  /** Public banking blurb for AR / clients (token protected) */
  app.get('/api/pay/banking', statusAuth, (req, res) => {
    const lines = [
      '🏦 *Banking details*',
      '',
      payConfig.bank_name ? 'Bank: *' + payConfig.bank_name + '*' : null,
      payConfig.account_name ? 'Name: ' + payConfig.account_name : null,
      payConfig.account_number ? 'Account: *' + payConfig.account_number + '*' : null,
      payConfig.branch_code ? 'Branch: ' + payConfig.branch_code : null,
      '',
      payConfig.reference_hint || 'Use invoice number as reference',
      payConfig.payfast_url ? 'Pay link: ' + payConfig.payfast_url : null,
      '',
      'Send POP on this chat after payment.',
      '',
      '0️⃣ Menu',
    ].filter((x) => x !== null);
    res.type('text/plain').send(lines.join('\n'));
  });

  // ——— Q2: Overdue auto-reminders ———
  function collectOverdue(minDays = 0) {
    const list = [];
    for (const inv of Object.values(invoiceStatus || {})) {
      const st = String(inv.status || '').toLowerCase();
      if (!['unpaid', 'partial', 'overdue'].includes(st)) continue;
      const bal = Number(inv.balance_due ?? inv.total) || 0;
      if (bal <= 0) continue;
      let days = 0;
      if (inv.due_date) {
        days = Math.floor((Date.now() - new Date(inv.due_date).getTime()) / 86400000);
      }
      if (days < minDays && st !== 'overdue') continue;
      list.push({ ...inv, days_overdue: Math.max(0, days) });
    }
    list.sort((a, b) => (b.days_overdue || 0) - (a.days_overdue || 0));
    return list;
  }

  function reminderText(inv) {
    return [
      '⏰ *Payment reminder*',
      '',
      'Hi ' + (inv.client_name || 'there') + ',',
      '',
      'Invoice *' + inv.invoice_number + '* has an outstanding balance.',
      'Amount due: *' + moneyR(inv.balance_due ?? inv.total) + '*',
      inv.due_date ? 'Due date: ' + String(inv.due_date).slice(0, 10) : null,
      inv.days_overdue > 0 ? 'Days overdue: *' + inv.days_overdue + '*' : null,
      '',
      payConfig.account_number
        ? 'Bank: ' + (payConfig.bank_name || '') + ' · Acc ' + payConfig.account_number
        : 'Reply *3* for payment details.',
      'Reference: *' + inv.invoice_number + '*',
      '',
      'Reply if you have already paid or need a statement.',
      '— PC REPAIR DEX',
    ].filter((x) => x !== null).join('\n');
  }

  app.get('/api/reminders/overdue', auth, (req, res) => {
    const minDays = Number(req.query.min_days) || 0;
    const items = collectOverdue(minDays);
    res.json({
      ok: true,
      count: items.length,
      total_ar: items.reduce((s, i) => s + (Number(i.balance_due ?? i.total) || 0), 0),
      invoices: items.map((i) => ({
        invoice_number: i.invoice_number,
        client_name: i.client_name,
        client_phone: i.client_phone,
        balance_due: i.balance_due,
        status: i.status,
        due_date: i.due_date,
        days_overdue: i.days_overdue,
        reminder_text: reminderText(i),
      })),
    });
  });

  /** AR / Tasker: next reminder for a phone or batch sample */
  app.get('/api/reminders/for-phone', statusAuth, (req, res) => {
    const phone = normalizePhone(req.query.phone || req.query.from || '');
    if (!phone) {
      return res.type('text/plain').send('Phone required.\n\n0️⃣ Menu');
    }
    const items = collectOverdue(0).filter((i) => i.client_phone === phone);
    if (!items.length) {
      return res.type('text/plain').send('✅ No overdue balance on this number.\n\n0️⃣ Menu');
    }
    const inv = items[0];
    res.type('text/plain').send(reminderText(inv));
  });

  app.post('/api/reminders/log', auth, (req, res) => {
    const b = req.body || {};
    const item = {
      id: uuidv4(),
      invoice_number: b.invoice_number || null,
      client_phone: normalizePhone(b.client_phone),
      channel: b.channel || 'whatsapp',
      message: b.message || null,
      created_at: now(),
      by_user_id: req.user.id,
    };
    if (!Array.isArray(remindersLog.items)) remindersLog.items = [];
    remindersLog.items.unshift(item);
    remindersLog.items = remindersLog.items.slice(0, 500);
    persistReminders();
    res.json({ ok: true, item });
  });

  // ——— Q3: Multi-agent inbox ———
  app.get('/api/inbox', auth, (req, res) => {
    const status = (req.query.status || 'open').toLowerCase();
    let items = agentInbox.items || [];
    if (status !== 'all') items = items.filter((i) => (i.status || 'open') === status);
    if (req.query.agent) items = items.filter((i) => i.assigned_to === req.query.agent);
    res.json({ ok: true, count: items.length, agents: agentInbox.agents || [], items: items.slice(0, 100) });
  });

  app.post('/api/inbox', auth, (req, res) => {
    const b = req.body || {};
    const item = {
      id: uuidv4(),
      type: b.type || 'message',
      subject: b.subject || 'Inbox item',
      body: b.body || '',
      client_phone: normalizePhone(b.client_phone),
      client_name: b.client_name || null,
      status: 'open',
      assigned_to: b.assigned_to || null,
      priority: b.priority || 'normal',
      notes: [],
      created_at: now(),
      updated_at: now(),
      created_by: req.user.id,
    };
    if (!Array.isArray(agentInbox.items)) agentInbox.items = [];
    agentInbox.items.unshift(item);
    agentInbox.items = agentInbox.items.slice(0, 300);
    persistInbox();
    pushNotification({
      type: 'inbox',
      title: 'Inbox: ' + item.subject,
      body: item.body.slice(0, 100),
      payload: { inbox_id: item.id },
    });
    res.json({ ok: true, item });
  });

  app.patch('/api/inbox/:id', auth, (req, res) => {
    const item = (agentInbox.items || []).find((i) => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    if (b.status) item.status = b.status;
    if (b.assigned_to !== undefined) item.assigned_to = b.assigned_to;
    if (b.priority) item.priority = b.priority;
    if (b.note) {
      if (!Array.isArray(item.notes)) item.notes = [];
      item.notes.push({ id: uuidv4(), text: b.note, at: now(), by: req.user.id });
    }
    item.updated_at = now();
    persistInbox();
    res.json({ ok: true, item });
  });

  app.post('/api/inbox/agents', auth, (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!Array.isArray(agentInbox.agents)) agentInbox.agents = [];
    if (!agentInbox.agents.includes(name)) agentInbox.agents.push(name);
    persistInbox();
    res.json({ ok: true, agents: agentInbox.agents });
  });

  /** WA human handoff creates inbox item */
  app.post('/api/inbox/from-wa', statusAuth, (req, res) => {
    const b = req.body || {};
    const phone = normalizePhone(b.phone || b.from);
    const item = {
      id: uuidv4(),
      type: 'wa_human',
      subject: 'Client requested human agent',
      body: b.message || 'Human requested via WhatsApp',
      client_phone: phone,
      client_name: b.name || (phone && waClients[phone]?.name) || null,
      status: 'open',
      assigned_to: null,
      priority: 'high',
      notes: [],
      created_at: now(),
      updated_at: now(),
      source: 'whatsapp',
    };
    if (!Array.isArray(agentInbox.items)) agentInbox.items = [];
    agentInbox.items.unshift(item);
    persistInbox();
    pushNotification({
      type: 'inbox',
      title: 'Human requested',
      body: (item.client_name || phone || 'Client') + ' wants an agent',
      payload: { inbox_id: item.id, phone },
    });
    res.type('text/plain').send(
      '🙋 *Request received*\n\nA team member will reply on this chat shortly.\n\n0️⃣ Menu'
    );
  });

  // ——— Q4: Quote accept / reject + deposit ———
  function findQuoteForPhone(phone, quoteRef) {
    const p = normalizePhone(phone);
    const profile = p ? waClients[p] : null;
    const results = [];
    for (const [uid, wsRow] of Object.entries(workspaces || {})) {
      const quotes = wsRow?.data?.quotes || [];
      for (const q of quotes) {
        const client = (wsRow.data.clients || []).find((c) => String(c.id) === String(q.clientId));
        const cPhone = normalizePhone(client?.phone);
        if (p && cPhone && cPhone !== p) continue;
        if (profile?.linked_client_id && String(q.clientId) !== String(profile.linked_client_id)) {
          // still allow if phone matches client
          if (!(p && cPhone === p)) continue;
        }
        if (quoteRef) {
          const ref = String(quoteRef).toUpperCase().replace(/\s+/g, '');
          const qn = String(q.number || q.id || '').toUpperCase().replace(/\s+/g, '');
          if (qn !== ref && !qn.includes(ref) && !ref.includes(qn)) continue;
        }
        results.push({ quote: q, userId: uid, client });
      }
    }
    return results;
  }

  app.all('/api/quotes/action', statusAuth, (req, res) => {
    const b = { ...(req.query || {}), ...(req.body || {}) };
    const phone = normalizePhone(b.phone || b.from);
    const action = String(b.action || '').toLowerCase(); // accept | reject | deposit
    const ref = b.ref || b.quote || b.number || '';
    const text = String(b.text || b.message || '');

    // Parse: ACCEPT QT-2026-0001 / REJECT QT-... / DEPOSIT QT-...
    let act = action;
    let quoteRef = ref;
    const m = text.match(/\b(accept|reject|deposit)\s+([A-Z0-9\-]+)/i);
    if (m) {
      act = m[1].toLowerCase();
      quoteRef = m[2];
    }
    if (!act || !['accept', 'reject', 'deposit'].includes(act)) {
      return res.type('text/plain').send(
        [
          '📋 *Quote actions*',
          '',
          'Send one of:',
          'ACCEPT QT-2026-0001',
          'REJECT QT-2026-0001',
          'DEPOSIT QT-2026-0001',
          '',
          'Or reply *4* to list your quotes.',
          '',
          '0️⃣ Menu',
        ].join('\n')
      );
    }

    const found = findQuoteForPhone(phone, quoteRef);
    if (!found.length) {
      return res.type('text/plain').send(
        'Quote not found for this WhatsApp number.\nCheck the quote number.\n\n0️⃣ Menu'
      );
    }
    const { quote, client } = found[0];
    const record = {
      id: uuidv4(),
      quote_id: quote.id,
      quote_number: quote.number || quote.id,
      action: act,
      client_phone: phone,
      client_name: client?.name || null,
      amount: quote.total,
      created_at: now(),
    };
    if (!Array.isArray(quoteActions.items)) quoteActions.items = [];
    quoteActions.items.unshift(record);
    quoteActions.items = quoteActions.items.slice(0, 300);
    persistQuotes();

    pushNotification({
      type: 'quote_action',
      title: 'Quote ' + act.toUpperCase() + ': ' + (quote.number || quote.id),
      body: (client?.name || phone || 'Client') + ' → ' + act,
      payload: record,
    });

    // Also inbox
    if (!Array.isArray(agentInbox.items)) agentInbox.items = [];
    agentInbox.items.unshift({
      id: uuidv4(),
      type: 'quote_' + act,
      subject: 'Quote ' + act + ' ' + (quote.number || ''),
      body: JSON.stringify(record),
      client_phone: phone,
      client_name: client?.name || null,
      status: 'open',
      priority: act === 'accept' || act === 'deposit' ? 'high' : 'normal',
      notes: [],
      created_at: now(),
      updated_at: now(),
      source: 'whatsapp',
    });
    persistInbox();

    if (act === 'accept') {
      return res.type('text/plain').send(
        [
          '✅ *Quote accepted*',
          '',
          'Quote: *' + (quote.number || quote.id) + '*',
          'Total: ' + moneyR(quote.total),
          '',
          'Thank you — we will proceed and confirm next steps.',
          'Reply *3* for payment / deposit details.',
          '',
          '0️⃣ Menu',
        ].join('\n')
      );
    }
    if (act === 'reject') {
      return res.type('text/plain').send(
        [
          'Noted — quote *' + (quote.number || quote.id) + '* marked as declined.',
          '',
          'Reply *7* if you want to discuss options.',
          '',
          '0️⃣ Menu',
        ].join('\n')
      );
    }
    // deposit
    const deposit = Number(quote.total) * 0.5;
    return res.type('text/plain').send(
      [
        '💰 *Deposit request*',
        '',
        'Quote: *' + (quote.number || quote.id) + '*',
        'Suggested deposit (50%): *' + moneyR(deposit) + '*',
        'Full total: ' + moneyR(quote.total),
        '',
        payConfig.account_number
          ? 'Bank: ' + (payConfig.bank_name || '') + ' · Acc *' + payConfig.account_number + '*'
          : 'Reply *bank* for banking details.',
        'Reference: *DEP-' + (quote.number || quote.id) + '*',
        '',
        'Send POP after payment.',
        '',
        '0️⃣ Menu',
      ].join('\n')
    );
  });

  app.get('/api/quotes/actions', auth, (req, res) => {
    res.json({ ok: true, count: (quoteActions.items || []).length, items: (quoteActions.items || []).slice(0, 50) });
  });

  // Expose helpers for AR brain integration
  return {
    payConfig,
    reminderText,
    collectOverdue,
    getPayConfig: () => payConfig,
  };
}

module.exports = { mountQuarters };
