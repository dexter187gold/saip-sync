/**
 * AutoResponder brain v2.2
 * Multi-step conversational forms + online form links
 */

function moneyR(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'R0.00';
  return 'R' + v.toFixed(2);
}

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).replace(/\D/g, '');
  if (!s) return null;
  if (s.startsWith('0') && s.length === 10) s = '27' + s.slice(1);
  if (s.startsWith('27') && s.length > 11) s = s.slice(0, 11);
  if (s.length < 9 || s.length > 15) return null;
  return s;
}

function extractPhoneFromSender(sender) {
  if (!sender) return null;
  const s = String(sender);
  const matches = s.match(/(\+?\d[\d\s\-]{7,}\d)/g);
  if (matches && matches.length) return normalizePhone(matches[matches.length - 1]);
  return normalizePhone(s);
}

function extractPhoneFromMessage(text) {
  if (!text) return null;
  for (const line of String(text).split(/\r?\n/).map((l) => l.trim())) {
    const m = line.match(/^(?:phone|mobile|cell|whatsapp|wa|number|tel)\s*[:\-]\s*(.+)$/i);
    if (m) {
      const p = normalizePhone(m[1]);
      if (p) return p;
    }
  }
  const bare = String(text).match(/(?:\+27|27|0)\s*\d[\d\s\-]{7,}\d/);
  if (bare) return normalizePhone(bare[0]);
  return null;
}

function extractPhoneFromBody(data, req) {
  const q = (data && data.query) || {};
  const headerPhone =
    (req.headers['x-wa-phone'] || req.headers['x-phone'] || req.headers['x-sender-phone'] || '').toString();
  let phone =
    normalizePhone(headerPhone) ||
    extractPhoneFromSender(q.sender || data.sender || '') ||
    normalizePhone(q.senderNumber || q.phone || q.from || data.phone || data.from || '') ||
    extractPhoneFromMessage(q.message || data.message || '');
  if (!phone) {
    try {
      const blob = JSON.stringify(data);
      const m = blob.match(/(\+27|27|0)\d{8,11}/);
      if (m) phone = normalizePhone(m[0]);
    } catch {}
  }
  return phone;
}

function reply(messages) {
  const list = (Array.isArray(messages) ? messages : [messages])
    .filter((m) => m != null && String(m).trim() !== '')
    .map((m) => ({ message: String(m) }));
  return { replies: list.length ? list : [{ message: 'Reply *menu* for options.' }] };
}

function parseClientForm(text) {
  const fields = {
    name: '', email: '', company: '', address: '', city: '', phone: null, vat: '', notes: '',
  };
  for (const line of String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    if (/^register$/i.test(line)) continue;
    let m;
    if ((m = line.match(/^(?:name|full\s*name)\s*[:\-]\s*(.+)$/i))) fields.name = m[1].trim();
    else if ((m = line.match(/^(?:email|e-mail)\s*[:\-]\s*(.+)$/i))) fields.email = m[1].trim().toLowerCase();
    else if ((m = line.match(/^(?:company|business)\s*[:\-]\s*(.+)$/i))) fields.company = m[1].trim();
    else if ((m = line.match(/^(?:address|street)\s*[:\-]\s*(.+)$/i))) fields.address = m[1].trim();
    else if ((m = line.match(/^(?:city|town)\s*[:\-]\s*(.+)$/i))) fields.city = m[1].trim();
    else if ((m = line.match(/^(?:phone|mobile|cell|whatsapp|wa|number|tel)\s*[:\-]\s*(.+)$/i))) fields.phone = normalizePhone(m[1]);
    else if ((m = line.match(/^(?:vat|tax)\s*[:\-]\s*(.+)$/i))) fields.vat = m[1].trim();
    else if ((m = line.match(/^(?:notes|note)\s*[:\-]\s*(.+)$/i))) fields.notes = m[1].trim();
  }
  return fields;
}

function looksLikeClientForm(msg) {
  const t = String(msg || '');
  if (/\bregister\b/i.test(t) && /name\s*[:\-]/i.test(t)) return true;
  if (/name\s*[:\-]/i.test(t) && (/email\s*[:\-]/i.test(t) || /phone\s*[:\-]/i.test(t))) return true;
  return false;
}

function mountArBrain(app, ctx) {
  const {
    waClients, workspaces, invoiceStatus, ticketsIntake,
    persistTickets, persistWaClients, pushNotification, now, uuidv4,
    ALLOWED_STATUS_TOKENS, DEFAULT_STATUS_TOKEN, getPayConfig,
    onHumanRequest, onQuoteAction,
    flows, // { processFlow, startRegister, startJob, clearSession }
    PUBLIC_BASE,
  } = ctx;

  let lastDebug = null;

  function checkArAuth(req) {
    const h = req.headers['x-status-token'] || '';
    const auth = req.headers.authorization || '';
    let t = String(h || '').trim();
    if (!t && auth.toLowerCase().startsWith('bearer ')) t = auth.slice(7).trim();
    if (!t && req.query?.token) t = String(req.query.token).trim();
    if (!t && auth.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
        const pass = decoded.split(':').slice(1).join(':');
        if (pass) t = pass.trim();
      } catch {}
    }
    if (!t) return ALLOWED_STATUS_TOKENS.has(DEFAULT_STATUS_TOKEN);
    return ALLOWED_STATUS_TOKENS.has(t);
  }

  function getProfile(phone) {
    const p = normalizePhone(phone);
    return p ? waClients[p] || null : null;
  }

  function isRegistered(phone) {
    const c = getProfile(phone);
    return !!(c && c.registered);
  }

  function docsForPhone(phone) {
    const p = normalizePhone(phone);
    const profile = getProfile(p);
    const invoices = Object.values(invoiceStatus || {})
      .filter((r) => r.client_phone === p)
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    let quotes = [];
    let tickets = [];
    if (profile?.owner_user_id && profile?.linked_client_id) {
      const ws = workspaces[profile.owner_user_id]?.data || {};
      const cid = String(profile.linked_client_id);
      quotes = (ws.quotes || []).filter((q) => String(q.clientId) === cid);
      tickets = (ws.tickets || []).filter((t) => String(t.clientId) === cid);
    }
    if (!quotes.length && p) {
      for (const wsRow of Object.values(workspaces || {})) {
        const clients = wsRow?.data?.clients || [];
        const qs = wsRow?.data?.quotes || [];
        for (const q of qs) {
          const cl = clients.find((c) => String(c.id) === String(q.clientId));
          if (normalizePhone(cl?.phone) === p) quotes.push(q);
        }
      }
    }
    const intake = (ticketsIntake?.items || []).filter((t) => normalizePhone(t.customer_phone) === p);
    return { profile, invoices, quotes, tickets, intake };
  }

  function payBlurb() {
    const pay = typeof getPayConfig === 'function' ? getPayConfig() : null;
    if (!pay || !pay.account_number) {
      return ['Reply *bank* once the business has set banking details in cloud.'];
    }
    return [
      'Bank: *' + (pay.bank_name || '') + '*',
      'Name: ' + (pay.account_name || ''),
      'Account: *' + pay.account_number + '*',
      pay.branch_code ? 'Branch: ' + pay.branch_code : null,
      pay.reference_hint || 'Use invoice number as reference',
      pay.payfast_url ? 'Pay link: ' + pay.payfast_url : null,
    ].filter(Boolean);
  }

  function menu(phone) {
    const reg = isRegistered(phone);
    const name = reg ? getProfile(phone)?.name : null;
    const base = PUBLIC_BASE || 'https://saip-sync.onrender.com';
    return [
      reg ? `👋 *Hi ${name}*` : '👋 *PC REPAIR DEX*',
      reg ? '📱 Number matched · private account' : 'New? Reply *1* — we ask one question at a time.',
      '',
      '*Main menu*',
      '1️⃣ My account / register',
      '2️⃣ My invoices',
      '3️⃣ Payment / EFT',
      '4️⃣ My quotes',
      '5️⃣ New job card',
      '6️⃣ Statement',
      '7️⃣ Human agent',
      '8️⃣ Hours & location',
      '9️⃣ Banking details',
      '',
      reg ? '✅ Profile active' : '⚠️ Not registered',
      '',
      '🌐 Forms: ' + base + '/forms/register',
      '',
      'Reply with a *number*.',
    ].join('\n');
  }

  function handleBulkRegister(phoneFromChat, text) {
    const f = parseClientForm(text);
    const phone = f.phone || phoneFromChat;
    if (!phone) {
      return flows
        ? flows.startRegister(null, 'bulk')
        : 'Include *Phone: 082…* or reply *1* for step-by-step.';
    }
    if (!f.name || f.name.length < 2) {
      return 'Almost there — *Name* is required. Reply *1* to start step-by-step.';
    }
    const existing = waClients[phone];
    const isNew = !existing || !existing.registered;
    waClients[phone] = {
      id: existing?.id || uuidv4(), phone, name: f.name,
      email: f.email || existing?.email || null,
      company: f.company || existing?.company || null,
      address: f.address || existing?.address || null,
      city: f.city || existing?.city || null,
      source: 'whatsapp_bulk_form', registered: true,
      linked_client_id: existing?.linked_client_id || null,
      owner_user_id: existing?.owner_user_id || null,
      created_at: existing?.created_at || now(), updated_at: now(),
      pending_import: isNew || !existing?.linked_client_id,
    };
    persistWaClients();
    pushNotification({
      type: 'wa_client_new', title: 'New WhatsApp client',
      body: `${f.name} registered (${phone})`, payload: waClients[phone],
    });
    return [
      isNew ? '✅ *Profile created successfully!*' : '✅ *Profile updated*',
      '', '👤 ' + f.name, f.email ? '📧 ' + f.email : null, '📱 ' + phone,
      '', 'Reply *menu*.',
    ].filter(Boolean).join('\n');
  }

  function handleQuoteAction(phone, msg) {
    const m = msg.match(/\b(accept|reject|deposit)\s+([A-Za-z0-9\-]+)/i);
    if (!m) return null;
    const act = m[1].toLowerCase();
    const ref = m[2].toUpperCase();
    const { quotes } = docsForPhone(phone);
    let quote = quotes.find((q) => String(q.number || q.id || '').toUpperCase().replace(/\s+/g, '') === ref.replace(/\s+/g, ''));
    if (!quote) quote = quotes.find((q) => String(q.number || '').toUpperCase().includes(ref));
    if (!quote) return 'Quote *' + ref + '* not found.\nReply *4* to list quotes.\n\n0️⃣ Menu';
    pushNotification({
      type: 'quote_action',
      title: 'Quote ' + act + ': ' + (quote.number || quote.id),
      body: (getProfile(phone)?.name || phone) + ' → ' + act,
      payload: { action: act, quote_number: quote.number, phone },
    });
    if (act === 'accept') {
      return ['✅ *Quote accepted*', '', 'Quote: *' + (quote.number || quote.id) + '*', 'Total: ' + moneyR(quote.total), '', '0️⃣ Menu'].join('\n');
    }
    if (act === 'reject') {
      return ['Noted — declined.', '', '0️⃣ Menu'].join('\n');
    }
    const dep = Number(quote.total) * 0.5;
    return ['💰 *Deposit*', '', 'Quote: *' + (quote.number || quote.id) + '*', '50%: *' + moneyR(dep) + '*', '', ...payBlurb(), '', '0️⃣ Menu'].join('\n');
  }

  function route(phone, sender, message) {
    const msg = String(message || '').trim();

    // Active multi-step flow first
    if (flows && typeof flows.processFlow === 'function') {
      const flowReply = flows.processFlow(phone, sender, msg);
      if (flowReply) return flowReply;
    }

    // Bulk paste form still supported
    if (looksLikeClientForm(msg)) return handleBulkRegister(phone, msg);

    // Legacy bulk JOB
    if (/\bJOB\b/i.test(msg) && (/device\s*[:\-]/i.test(msg) || /issue\s*[:\-]/i.test(msg))) {
      let name = '', device = '', issue = '', urgency = 'normal';
      for (const line of msg.split(/\r?\n/).map((l) => l.trim())) {
        const mName = line.match(/^(?:name)\s*[:\-]\s*(.+)$/i);
        const mDev = line.match(/^(?:device|pc|laptop)\s*[:\-]\s*(.+)$/i);
        const mIssue = line.match(/^(?:issue|problem|fault)\s*[:\-]\s*(.+)$/i);
        const mUrg = line.match(/^(?:urgency|priority)\s*[:\-]\s*(.+)$/i);
        if (mName) name = mName[1].trim();
        if (mDev) device = mDev[1].trim();
        if (mIssue) issue = mIssue[1].trim();
        if (mUrg) urgency = mUrg[1].trim().toLowerCase();
      }
      const profile = getProfile(phone);
      if (profile?.name && !name) name = profile.name;
      const ticket = {
        id: uuidv4(), source: 'whatsapp', customer_name: name || null,
        customer_phone: phone, device, issue, urgency, status: 'new', created_at: now(),
      };
      if (!Array.isArray(ticketsIntake.items)) ticketsIntake.items = [];
      ticketsIntake.items.unshift(ticket);
      persistTickets();
      pushNotification({ type: 'ticket_intake', title: 'New WhatsApp job', body: `${name || phone}: ${issue || device}`, payload: ticket });
      return ['✅ *Job card received*', '', name ? '👤 ' + name : null, device ? '💻 ' + device : null, issue ? '⚠️ ' + issue : null, '', '0️⃣ Menu'].filter(Boolean).join('\n');
    }

    const qa = handleQuoteAction(phone, msg);
    if (qa) return qa;

    const invMatch = msg.match(/\b(INV[-\s]?\d{4}[-\s]?\d{1,6}|INV[-\s]?\d{1,6})\b/i);
    if (invMatch) {
      let num = invMatch[1].toUpperCase().replace(/\s+/g, '');
      if (/^INV\d+$/.test(num)) num = 'INV-' + num.slice(3);
      let matches = Object.values(invoiceStatus || {}).filter((r) => r.invoice_number === num);
      if (phone) {
        const locked = matches.filter((r) => r.client_phone === phone);
        if (locked.length) matches = locked;
        else if (matches.some((r) => r.client_phone)) return '🔒 Invoice not linked to this WhatsApp.\n\n0️⃣ Menu';
      }
      const inv = matches[0];
      if (!inv) return '📄 Invoice not found. Example INV-2026-0001\n\n0️⃣ Menu';
      return ['📄 *Invoice ' + inv.invoice_number + '*', '', '👤 ' + (inv.client_name || 'Client'), '💵 Total: ' + moneyR(inv.total), '💳 Balance: ' + moneyR(inv.balance_due), '📊 *' + String(inv.status || '').toUpperCase() + '*', '', '0️⃣ Menu'].join('\n');
    }

    if (/^(0|menu|hi|hello|hey|help|start|back)$/i.test(msg) || /\bmenu\b/i.test(msg)) return menu(phone);

    if (/^(1|account|profile|my account|register)$/i.test(msg)) {
      if (!isRegistered(phone)) {
        if (flows) return flows.startRegister(phone, sender);
        return 'Reply with your full name to start registration.';
      }
      const c = getProfile(phone);
      const { invoices, quotes, tickets, intake } = docsForPhone(phone);
      const open = invoices.filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()));
      const ar = open.reduce((s, i) => s + (Number(i.balance_due ?? i.total) || 0), 0);
      return ['👤 *Your account*', '', 'Name: *' + (c.name || '—') + '*', c.email ? 'Email: ' + c.email : null, 'WhatsApp: ' + phone, '', '📊 Open: ' + open.length, '💳 Outstanding: *' + moneyR(ar) + '*', '📋 Quotes: ' + quotes.length, '🛠 Jobs: ' + (tickets.length + intake.length), '', 'To update: reply *register* (step-by-step).', '', '0️⃣ Menu'].filter((x) => x !== null).join('\n');
    }

    if (/^(2|invoices|my invoices)$/i.test(msg)) {
      if (!isRegistered(phone)) return flows ? flows.startRegister(phone, sender) : menu(phone);
      const { invoices } = docsForPhone(phone);
      if (!invoices.length) return '📄 *Your invoices*\n\nNone linked yet.\n\n0️⃣ Menu';
      const lines = ['📄 *Your invoices*', ''];
      for (const inv of invoices.slice(0, 12)) {
        lines.push(`• *${inv.invoice_number}* · ${moneyR(inv.balance_due ?? inv.total)} · *${String(inv.status || '').toUpperCase()}*`);
      }
      lines.push('', '0️⃣ Menu');
      return lines.join('\n');
    }

    if (/^(3|payment|pay|eft)$/i.test(msg)) {
      if (!isRegistered(phone)) return flows ? flows.startRegister(phone, sender) : menu(phone);
      const { invoices } = docsForPhone(phone);
      const open = invoices.filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()));
      const ar = open.reduce((s, i) => s + (Number(i.balance_due ?? i.total) || 0), 0);
      const lines = ['💳 *Payment / EFT*', ''];
      if (open.length) {
        lines.push(`Open: *${open.length}* · *${moneyR(ar)}*`, '');
        for (const inv of open.slice(0, 8)) lines.push(`• ${inv.invoice_number} — ${moneyR(inv.balance_due ?? inv.total)}`);
        lines.push('');
      } else lines.push('No open balance.', '');
      lines.push(...payBlurb(), '', '0️⃣ Menu');
      return lines.join('\n');
    }

    if (/^(4|quotes|my quotes)$/i.test(msg)) {
      if (!isRegistered(phone)) return flows ? flows.startRegister(phone, sender) : menu(phone);
      const { quotes } = docsForPhone(phone);
      if (!quotes.length) return '📋 *Your quotes*\n\nNone on file.\n\n0️⃣ Menu';
      const lines = ['📋 *Your quotes*', ''];
      for (const q of quotes.slice(0, 10)) {
        lines.push(`• *${q.number || q.id}* · ${moneyR(q.total)}`);
      }
      lines.push('', '0️⃣ Menu');
      return lines.join('\n');
    }

    // Job — multi-step
    if (/^(5|job|repair|ticket)$/i.test(msg)) {
      if (flows) {
        const prefill = isRegistered(phone) ? getProfile(phone)?.name : null;
        return flows.startJob(phone, sender, prefill);
      }
      return 'Reply with device and issue to open a job card.';
    }

    if (/^(6|statement)$/i.test(msg)) {
      if (!isRegistered(phone)) return flows ? flows.startRegister(phone, sender) : menu(phone);
      const { profile, invoices } = docsForPhone(phone);
      const open = invoices.filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()));
      const ar = open.reduce((s, i) => s + (Number(i.balance_due ?? i.total) || 0), 0);
      const lines = ['📑 *Statement*', '', '👤 ' + (profile?.name || 'Client'), '📱 ' + phone, ''];
      if (!open.length) lines.push('No outstanding invoices.');
      else {
        lines.push(`Outstanding: *${moneyR(ar)}*`, '');
        for (const inv of open.slice(0, 15)) lines.push(`• ${inv.invoice_number} · ${moneyR(inv.balance_due ?? inv.total)}`);
      }
      lines.push('', '0️⃣ Menu');
      return lines.join('\n');
    }

    if (/^(7|human|agent)$/i.test(msg)) {
      pushNotification({
        type: 'inbox', title: 'Human requested',
        body: (getProfile(phone)?.name || phone || 'Client') + ' wants an agent',
        payload: { phone },
      });
      return '🙋 *Request received*\n\nA team member will reply shortly.\n\n0️⃣ Menu';
    }

    if (/^(8|hours|location)$/i.test(msg)) {
      return ['📍 *PC REPAIR DEX*', '', 'Hours: Mon–Fri 09:00–17:00', 'Sat: 09:00–13:00 (by appointment)', '', '0️⃣ Menu'].join('\n');
    }

    if (/^(9|bank|banking)$/i.test(msg)) {
      return ['🏦 *Banking details*', '', ...payBlurb(), '', '0️⃣ Menu'].join('\n');
    }

    return menu(phone);
  }

  app.post('/api/ar', (req, res) => {
    if (!checkArAuth(req)) {
      return res.status(403).json(reply('⚠️ Unauthorized. Check Basic Auth password / X-Status-Token.'));
    }
    const data = req.body || {};
    const q = data.query || {};
    const message = q.message || data.message || '';
    const sender = q.sender || data.sender || '';
    const phone = extractPhoneFromBody(data, req);

    lastDebug = {
      at: now(),
      sender,
      messagePreview: String(message).slice(0, 200),
      phoneResolved: phone,
    };

    try {
      return res.status(200).json(reply(route(phone, sender, message)));
    } catch (e) {
      console.error('ar-brain', e);
      return res.status(200).json(reply('Temporary error. Reply *menu*.'));
    }
  });

  app.get('/api/ar', (req, res) => {
    res.json({
      ok: true,
      name: 'SAIP AutoResponder Brain',
      version: '2.2.0',
      features: ['multi_step_register', 'multi_step_job', 'online_forms'],
      forms: {
        register: (PUBLIC_BASE || 'https://saip-sync.onrender.com') + '/forms/register',
        job: (PUBLIC_BASE || 'https://saip-sync.onrender.com') + '/forms/job',
      },
    });
  });

  app.get('/api/ar/debug-last', (req, res) => {
    res.json({ ok: true, last: lastDebug });
  });
}

module.exports = { mountArBrain };
