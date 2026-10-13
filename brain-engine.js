/**
 * Brain Engine v4.1 — AutoResponder intelligence
 * Real-time wa_clients lookup · multi-step flows · REGISTER block · status · jobs
 * Shares the same in-memory waClients object as server.js so registration is instant.
 */
const { v4: uuidv4 } = require('uuid');

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).replace(/\D/g, '');
  if (!s) return null;
  if (s.startsWith('0') && s.length === 10) s = '27' + s.slice(1);
  if (s.length === 9 && /^[6-8]/.test(s)) s = '27' + s;
  if (s.startsWith('27') && s.length > 11) s = s.slice(0, 11);
  if (s.length < 9 || s.length > 15) return null;
  return s;
}

function moneyR(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'R0.00';
  return 'R' + v.toFixed(2);
}

function createBrainEngine(ctx) {
  const {
    sessions,
    persistSessions,
    waClients,
    persistWaClients,
    ticketsIntake,
    persistTickets,
    invoiceStatus,
    workspaces,
    pushNotification,
    now,
    uuidv4: uuid,
    PUBLIC_BASE,
    getPayConfig,
  } = ctx;

  const id = uuid || uuidv4;

  function getClient(phone) {
    const p = normalizePhone(phone);
    if (!p) return null;
    return waClients[p] || null;
  }

  function isRegistered(phone) {
    const c = getClient(phone);
    return !!(c && c.registered === true);
  }

  function saveClient(phone, patch) {
    const p = normalizePhone(phone);
    if (!p) return null;
    const existing = waClients[p] || {};
    const row = {
      id: existing.id || id(),
      phone: p,
      name: patch.name != null ? patch.name : existing.name || null,
      email: patch.email != null ? patch.email : existing.email || null,
      company: patch.company != null ? patch.company : existing.company || null,
      address: patch.address != null ? patch.address : existing.address || null,
      city: patch.city != null ? patch.city : existing.city || null,
      source: patch.source || existing.source || 'whatsapp',
      registered: patch.registered != null ? !!patch.registered : (existing.registered != null ? existing.registered : true),
      linked_client_id: patch.linked_client_id != null ? patch.linked_client_id : existing.linked_client_id || null,
      owner_user_id: patch.owner_user_id != null ? patch.owner_user_id : existing.owner_user_id || null,
      pending_import: patch.pending_import != null ? !!patch.pending_import : (existing.pending_import != null ? existing.pending_import : true),
      created_at: existing.created_at || now(),
      updated_at: now(),
    };
    waClients[p] = row;
    if (typeof persistWaClients === 'function') {
      try { persistWaClients(); } catch (e) { console.error('[brain] persistWaClients failed', e.message); }
    }
    return row;
  }

  function detectIntent(message) {
    const m = String(message || '').trim().toLowerCase();
    if (!m) return 'empty';
    if (/^(0|menu|hi|hello|hey|start|help)$/i.test(m)) return 'menu';
    if (/^register\b/i.test(m) || m === '1' || /\bregister\b/i.test(m)) return 'register';
    if (/^(status|my job|job status|jobs?)$/i.test(m) || m === 'status') return 'status';
    if (m === '2' || /^(invoices?|my invoices?)$/i.test(m)) return 'invoices';
    if (m === '3' || /^(pay|payment|eft|bank)$/i.test(m)) return 'payment';
    if (m === '4' || /^(quotes?|my quotes?)$/i.test(m)) return 'quotes';
    if (m === '5' || /^job\b/i.test(m) || /^(new job|job card)$/i.test(m)) return 'job';
    if (m === '6' || /^(statement|account)$/i.test(m)) return 'statement';
    if (m === '7' || /^(agent|human|help me|support)$/i.test(m)) return 'agent';
    if (m === '8' || /^(hours|location|address|where)$/i.test(m)) return 'hours';
    if (/^inv[-\s]?\d/i.test(m) || /^INV/i.test(m)) return 'invoice_lookup';
    if (/^cancel|stop|exit|quit$/i.test(m)) return 'cancel';
    return 'unknown';
  }

  function sessionKey(phone) {
    return 'p:' + (normalizePhone(phone) || 'unknown');
  }

  function getSession(phone) {
    const k = sessionKey(phone);
    const sess = sessions[k];
    if (!sess) return null;
    if (sess.updated_at && Date.now() - new Date(sess.updated_at).getTime() > 2 * 3600 * 1000) {
      delete sessions[k];
      if (typeof persistSessions === 'function') persistSessions();
      return null;
    }
    return { key: k, ...sess };
  }

  function setSession(phone, data) {
    const k = sessionKey(phone);
    sessions[k] = { ...data, updated_at: now() };
    if (typeof persistSessions === 'function') persistSessions();
  }

  function clearSession(phone) {
    const k = sessionKey(phone);
    delete sessions[k];
    if (typeof persistSessions === 'function') persistSessions();
  }

  function parseRegisterBlock(text) {
    const data = {};
    for (const line of String(text || '').split(/\r?\n/).map((l) => l.trim())) {
      if (/^register$/i.test(line)) continue;
      const m = line.match(/^(name|email|company|address|city|phone|mobile|cell)\s*[:\-]\s*(.+)$/i);
      if (m) {
        const key = m[1].toLowerCase();
        const val = m[2].trim();
        if (key === 'name') data.name = val;
        else if (key === 'email') data.email = val;
        else if (key === 'company') data.company = val;
        else if (key === 'address') data.address = val;
        else if (key === 'city') data.city = val;
        else if (['phone', 'mobile', 'cell'].includes(key)) data.phone = normalizePhone(val);
      }
    }
    return data;
  }

  function completeRegister(phone, data) {
    const p = normalizePhone(data.phone) || normalizePhone(phone);
    if (!p || !data.name || data.name.length < 2) {
      return {
        ok: false,
        text: [
          '❌ Registration needs at least *Name* and a valid number.',
          '',
          'Send *exactly*:',
          '',
          '*REGISTER*',
          'Name: Your full name',
          'Email: you@email.com',
          'Company: (optional)',
          'Address: (optional)',
          '',
          'Or reply *1* to answer step by step.',
        ].join('\n'),
      };
    }
    const existing = getClient(p);
    const isNew = !existing || !existing.registered;
    const row = saveClient(p, {
      name: data.name,
      email: data.email && data.email !== 'skip' ? data.email : null,
      company: data.company && data.company !== 'skip' ? data.company : null,
      address: data.address && data.address !== 'skip' ? data.address : null,
      city: data.city && data.city !== 'skip' ? data.city : null,
      source: 'whatsapp_register',
      registered: true,
      pending_import: isNew || !existing?.linked_client_id,
    });
    if (typeof pushNotification === 'function') {
      pushNotification({
        type: 'wa_client_new',
        title: isNew ? 'New WhatsApp client' : 'Client profile updated',
        body: `${row.name} (${p})`,
        payload: row,
      });
    }
    return {
      ok: true,
      phone: p,
      text: [
        isNew ? '✅ *Profile created successfully!*' : '✅ *Profile updated*',
        '',
        '👤 ' + row.name,
        row.email ? '📧 ' + row.email : null,
        row.company ? '🏢 ' + row.company : null,
        row.address ? '📍 ' + row.address : null,
        '📱 ' + p,
        '',
        'You are now *registered*.',
        'Reply *menu* or *2* for invoices · *5* for a job card.',
      ].filter(Boolean).join('\n'),
    };
  }

  const REGISTER_STEPS = [
    { key: 'name', prompt: '👤 What is your *full name and surname*?', required: true, validate: (v) => v.length >= 2 },
    { key: 'email', prompt: '📧 What is your *email address*?\n(or reply *skip*)', required: false, validate: (v) => v === 'skip' || /@/.test(v) },
    { key: 'company', prompt: '🏢 *Company name*?\n(or reply *skip*)', required: false, validate: () => true },
    { key: 'address', prompt: '📍 *Street address*?\n(or reply *skip*)', required: false, validate: () => true },
  ];

  const JOB_STEPS = [
    { key: 'name', prompt: '👤 *Your name* for this job card?', required: true, validate: (v) => v.length >= 2 },
    { key: 'device', prompt: '💻 What *device* is it?\n(e.g. HP laptop, desktop, printer)', required: true, validate: (v) => v.length >= 2 },
    { key: 'issue', prompt: '⚠️ Describe the *issue / fault*:', required: true, validate: (v) => v.length >= 3 },
    { key: 'urgency', prompt: '⏱ *Urgency*?\nReply: *normal* or *urgent*', required: true, validate: (v) => /^(normal|urgent|high|low)$/i.test(v) },
  ];

  function startRegister(phone) {
    setSession(phone, { type: 'register', step: 0, data: {} });
    const formUrl = (PUBLIC_BASE || '') + '/forms/register';
    return [
      '📝 *Client registration*',
      '',
      'We will ask a few questions one at a time.',
      'Reply *cancel* anytime to stop.',
      '',
      '🌐 Prefer a web form?',
      formUrl,
      '',
      'Or paste a full block:',
      '*REGISTER*',
      'Name: …',
      'Email: …',
      '',
      REGISTER_STEPS[0].prompt,
    ].join('\n');
  }

  function startJob(phone, prefillName) {
    const data = prefillName ? { name: prefillName } : {};
    const step = prefillName ? 1 : 0;
    setSession(phone, { type: 'job', step, data });
    const formUrl = (PUBLIC_BASE || '') + '/forms/job';
    const lines = [
      '🛠 *New job card*',
      '',
      'One question at a time. Reply *cancel* to stop.',
      '',
      '🌐 Web form: ' + formUrl,
      '',
    ];
    if (prefillName) {
      lines.push('Name on file: *' + prefillName + '*', JOB_STEPS[1].prompt);
    } else {
      lines.push(JOB_STEPS[0].prompt);
    }
    return lines.join('\n');
  }

  function completeJob(phone, data) {
    const p = normalizePhone(phone);
    const ticket = {
      id: id(),
      source: 'whatsapp_brain',
      customer_name: data.name || getClient(p)?.name || null,
      customer_phone: p,
      device: data.device || null,
      issue: data.issue || null,
      urgency: String(data.urgency || 'normal').toLowerCase(),
      status: 'new',
      created_at: now(),
    };
    if (!ticketsIntake.items) ticketsIntake.items = [];
    ticketsIntake.items.unshift(ticket);
    ticketsIntake.items = ticketsIntake.items.slice(0, 500);
    if (typeof persistTickets === 'function') persistTickets();
    if (typeof pushNotification === 'function') {
      pushNotification({
        type: 'ticket_intake',
        title: 'New WhatsApp job',
        body: `${ticket.customer_name || p}: ${ticket.issue || ticket.device}`,
        payload: ticket,
      });
    }
    if (!isRegistered(p) && data.name) {
      saveClient(p, {
        name: data.name,
        source: 'whatsapp_job',
        registered: true,
        pending_import: true,
      });
    }
    return [
      '✅ *Job card created*',
      '',
      ticket.customer_name ? '👤 ' + ticket.customer_name : null,
      ticket.device ? '💻 ' + ticket.device : null,
      ticket.issue ? '⚠️ ' + ticket.issue : null,
      '⏱ ' + (ticket.urgency || 'normal'),
      p ? '📱 ' + p : null,
      '',
      'We will follow up on WhatsApp.',
      'Reply *status* anytime for updates · *menu* for options.',
    ].filter(Boolean).join('\n');
  }

  function processFlow(phone, message) {
    const msg = String(message || '').trim();
    if (!msg) return null;
    const sess = getSession(phone);
    if (!sess) return null;

    if (/^(cancel|stop|exit|quit|0|menu)$/i.test(msg)) {
      clearSession(phone);
      return 'Cancelled. Reply *menu* for options.';
    }

    if (sess.type === 'register' && /^register\b/i.test(msg) && /name\s*[:\-]/i.test(msg)) {
      clearSession(phone);
      const data = parseRegisterBlock(msg);
      return completeRegister(phone, data).text;
    }

    const steps = sess.type === 'register' ? REGISTER_STEPS : sess.type === 'job' ? JOB_STEPS : null;
    if (!steps) {
      clearSession(phone);
      return null;
    }

    let step = sess.step || 0;
    const data = { ...(sess.data || {}) };
    const current = steps[step];
    if (!current) {
      clearSession(phone);
      return null;
    }

    let value = msg;
    if (!current.required && /^(skip|none|n\/?a|-)$/i.test(msg)) value = 'skip';

    if (!current.validate(value)) {
      return '❌ That does not look right.\n\n' + current.prompt;
    }

    if (current.key === 'email') data.email = value === 'skip' ? 'skip' : value.toLowerCase();
    else if (current.key === 'urgency') data.urgency = value.toLowerCase();
    else data[current.key] = value === 'skip' ? 'skip' : value;

    step += 1;
    if (step >= steps.length) {
      clearSession(phone);
      if (sess.type === 'register') {
        return completeRegister(phone, data).text;
      }
      return completeJob(phone, data);
    }

    setSession(phone, { type: sess.type, step, data });
    const next = steps[step];
    return `(${step + 1}/${steps.length}) ` + next.prompt;
  }

  function menuText(phone) {
    const reg = isRegistered(phone);
    const name = reg ? (getClient(phone)?.name || 'Client') : null;
    const head = reg
      ? [`👋 *Hi ${name}*`, '📱 Number matched · your account', '']
      : ['👋 *PC REPAIR DEX*', 'New on WhatsApp? Register under *1* first.', ''];
    return [
      ...head,
      '*Main menu*',
      '',
      '1️⃣ My account / profile',
      '2️⃣ My invoices',
      '3️⃣ Payment / EFT',
      '4️⃣ My quotes',
      '5️⃣ New job card',
      '6️⃣ My statement',
      '7️⃣ Human agent',
      '8️⃣ Hours & location',
      '',
      reg ? '✅ Profile active' : '⚠️ Not registered — complete form via *1*',
      '',
      'Reply with a *number* or keyword (*status*, *job*).',
      '0️⃣ Menu',
    ].join('\n');
  }

  function profileText(phone) {
    if (!isRegistered(phone)) {
      return [
        '🔒 *Client access locked*',
        '',
        'This WhatsApp number is not registered yet.',
        'Complete the form once to unlock *your* invoices, quotes & account.',
        '',
        'Send *exactly*:',
        '',
        '*REGISTER*',
        'Name: Your full name',
        'Email: you@email.com',
        'Company: (optional)',
        'Address: (optional)',
        '',
        'Or reply *1* for step-by-step.',
        '',
        'Need a repair now? Reply *5* for a new job card.',
        '',
        '0️⃣ Menu',
      ].join('\n');
    }
    const c = getClient(phone);
    const invoices = Object.values(invoiceStatus || {}).filter((r) => r.client_phone === normalizePhone(phone));
    const open = invoices.filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()));
    const ar = open.reduce((s, i) => s + (Number(i.balance_due ?? i.total) || 0), 0);
    return [
      '👤 *Your account*',
      '',
      'Name: *' + (c.name || '—') + '*',
      c.email ? 'Email: ' + c.email : null,
      'WhatsApp: ' + normalizePhone(phone),
      c.company ? 'Company: ' + c.company : null,
      c.address ? 'Address: ' + c.address : null,
      '',
      '📊 Open invoices: ' + open.length,
      '💳 Outstanding: *' + moneyR(ar) + '*',
      '',
      '2️⃣ My invoices  ·  6️⃣ Statement  ·  5️⃣ New job',
      '',
      '0️⃣ Menu',
    ].filter((x) => x !== null).join('\n');
  }

  function statusText(phone) {
    const p = normalizePhone(phone);
    const intake = (ticketsIntake?.items || []).filter(
      (t) => normalizePhone(t.customer_phone) === p && !['imported', 'done', 'cancelled', 'closed', 'resolved'].includes(String(t.status || '').toLowerCase())
    );
    const client = getClient(p);
    let wsTickets = [];
    if (client?.owner_user_id && client?.linked_client_id) {
      const ws = workspaces[client.owner_user_id]?.data || {};
      wsTickets = (ws.tickets || []).filter(
        (t) => String(t.clientId) === String(client.linked_client_id) &&
          !['closed', 'resolved', 'cancelled'].includes(String(t.status || '').toLowerCase())
      );
    }
    const all = [
      ...intake.map((t) => ({ title: [t.device, t.issue].filter(Boolean).join(' — ') || 'Job', status: t.status || 'new', updated: t.updated_at || t.created_at })),
      ...wsTickets.map((t) => ({ title: t.device || t.title || t.subject || 'Job', status: t.status || 'open', updated: t.updatedAt || t.createdAt })),
    ];
    if (!all.length) {
      return [
        '🛠 *Job status*',
        '',
        'No open jobs on this number.',
        'Reply *5* to open a new job card.',
        '',
        '0️⃣ Menu',
      ].join('\n');
    }
    const lines = ['🛠 *Your job status*', ''];
    for (const j of all.slice(0, 6)) {
      lines.push('• *' + j.title + '*');
      lines.push('  Status: *' + String(j.status).replace(/_/g, ' ') + '*');
      if (j.updated) lines.push('  Updated: ' + String(j.updated).slice(0, 16).replace('T', ' '));
      lines.push('');
    }
    lines.push('We message you when status changes.', '', '0️⃣ Menu');
    return lines.join('\n');
  }

  function invoicesText(phone) {
    if (!isRegistered(phone)) return profileText(phone);
    const p = normalizePhone(phone);
    const invoices = Object.values(invoiceStatus || {})
      .filter((r) => r.client_phone === p)
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    if (!invoices.length) {
      return [
        '📄 *Your invoices*',
        '',
        'No invoices linked to this number yet.',
        'After we bill you, they appear here automatically.',
        '',
        'Need a repair? Reply *5*',
        '',
        '0️⃣ Menu',
      ].join('\n');
    }
    const lines = ['📄 *Your invoices*', ''];
    for (const inv of invoices.slice(0, 12)) {
      lines.push(`• *${inv.invoice_number}* · ${moneyR(inv.balance_due ?? inv.total)} · *${String(inv.status || 'unpaid').toUpperCase()}*`);
      if (inv.due_date) lines.push(`  Due ${String(inv.due_date).slice(0, 10)}`);
    }
    lines.push('', 'Send an invoice number for full detail.', '', '0️⃣ Menu');
    return lines.join('\n');
  }

  function paymentText(phone) {
    if (!isRegistered(phone)) return profileText(phone);
    const p = normalizePhone(phone);
    const invoices = Object.values(invoiceStatus || {}).filter((r) => r.client_phone === p);
    const open = invoices.filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()));
    const ar = open.reduce((s, i) => s + (Number(i.balance_due ?? i.total) || 0), 0);
    let payHint = '';
    try {
      if (typeof getPayConfig === 'function') {
        const cfg = getPayConfig();
        if (cfg && cfg.bank) payHint = '\nBank: ' + cfg.bank;
      }
    } catch {}
    const lines = [
      '💳 *Payment / EFT*',
      '',
      open.length
        ? `You have *${open.length}* open invoice(s) · Outstanding *${moneyR(ar)}*`
        : 'No open balance on this number.',
      '',
    ];
    if (open.length) {
      lines.push('*Pay against:*');
      for (const inv of open.slice(0, 8)) {
        lines.push(`• ${inv.invoice_number} — ${moneyR(inv.balance_due ?? inv.total)}`);
      }
      lines.push('');
    }
    lines.push(
      'Use your *invoice number* as payment reference.',
      'Send POP (proof of payment) here after paying.',
      payHint,
      '',
      'Reply *7* for a human agent.',
      '',
      '0️⃣ Menu'
    );
    return lines.filter(Boolean).join('\n');
  }

  function hoursText() {
    return [
      '📍 *Hours & location*',
      '',
      'Mon–Fri: 08:00 – 17:00',
      'Sat: 08:00 – 13:00',
      'Sun / Public holidays: Closed',
      '',
      'Reply *7* for directions or a callback.',
      '',
      '0️⃣ Menu',
    ].join('\n');
  }

  function agentText() {
    return [
      '👤 *Human agent*',
      '',
      'A technician will reply on this number shortly.',
      'You can also describe your issue in one message now.',
      '',
      '0️⃣ Menu',
    ].join('\n');
  }

  function handleMessage(phone, sender, message) {
    const p = normalizePhone(phone);
    if (!p) {
      return [
        '⚠️ Could not read your WhatsApp number.',
        'Ensure AutoResponder passes %fromnumber% with country code.',
        '',
        'Reply *menu* after fixing.',
      ].join('\n');
    }

    const msg = String(message || '').trim();

    const flowReply = processFlow(p, msg);
    if (flowReply) return flowReply;

    if (/^register\b/i.test(msg) && /name\s*[:\-]/i.test(msg)) {
      const data = parseRegisterBlock(msg);
      return completeRegister(p, data).text;
    }

    if (/^job\b/i.test(msg) && (/device\s*[:\-]/i.test(msg) || /issue\s*[:\-]/i.test(msg))) {
      const data = {};
      for (const line of msg.split(/\r?\n/).map((l) => l.trim())) {
        const mName = line.match(/^(?:name)\s*[:\-]\s*(.+)$/i);
        const mDev = line.match(/^(?:device|pc|laptop)\s*[:\-]\s*(.+)$/i);
        const mIssue = line.match(/^(?:issue|problem|fault)\s*[:\-]\s*(.+)$/i);
        const mUrg = line.match(/^(?:urgency|priority)\s*[:\-]\s*(.+)$/i);
        if (mName) data.name = mName[1].trim();
        if (mDev) data.device = mDev[1].trim();
        if (mIssue) data.issue = mIssue[1].trim();
        if (mUrg) data.urgency = mUrg[1].trim().toLowerCase();
      }
      if (!data.name && isRegistered(p)) data.name = getClient(p)?.name;
      if (data.device || data.issue) return completeJob(p, data);
    }

    const intent = detectIntent(msg);

    switch (intent) {
      case 'menu':
      case 'empty':
        return menuText(p);
      case 'register':
        if (isRegistered(p) && msg === '1') return profileText(p);
        return startRegister(p);
      case 'status':
        return statusText(p);
      case 'invoices':
        return invoicesText(p);
      case 'payment':
        return paymentText(p);
      case 'quotes':
        if (!isRegistered(p)) return profileText(p);
        return ['📋 *Your quotes*', '', 'No quotes on file yet.', 'Describe the job and reply *7*.', '', '0️⃣ Menu'].join('\n');
      case 'job':
        return startJob(p, isRegistered(p) ? getClient(p)?.name : null);
      case 'statement':
        return invoicesText(p);
      case 'agent':
        return agentText();
      case 'hours':
        return hoursText();
      case 'cancel':
        clearSession(p);
        return 'Cancelled. Reply *menu* for options.';
      case 'invoice_lookup': {
        const number = msg.toUpperCase().replace(/\s+/g, '');
        const all = Object.values(invoiceStatus || {});
        let matches = all.filter((r) => r.invoice_number === number || String(r.invoice_number || '').replace(/[^A-Z0-9]/g, '') === number.replace(/[^A-Z0-9]/g, ''));
        if (isRegistered(p)) {
          const locked = matches.filter((r) => r.client_phone === p);
          if (locked.length) matches = locked;
        }
        const inv = matches[0];
        if (!inv) {
          return ['📄 Invoice not found.', 'Use the exact number (e.g. INV-2026-0001).', '', '0️⃣ Menu'].join('\n');
        }
        return [
          '📄 *Invoice ' + inv.invoice_number + '*',
          '',
          '👤 ' + (inv.client_name || 'Client'),
          '💵 Total: ' + moneyR(inv.total),
          '💳 Balance: ' + moneyR(inv.balance_due),
          '📊 Status: *' + String(inv.status || 'unpaid').toUpperCase() + '*',
          inv.due_date ? '📅 Due: ' + String(inv.due_date).slice(0, 10) : null,
          '',
          'Reply *menu* for more options.',
        ].filter(Boolean).join('\n');
      }
      default:
        if (msg.length > 40) {
          return [
            'Got your message. A human will follow up if needed.',
            '',
            'Quick options:',
            '• *menu* — main menu',
            '• *status* — job status',
            '• *5* — new job card',
            '• *1* — register / profile',
          ].join('\n');
        }
        return menuText(p);
    }
  }

  return {
    handleMessage,
    detectIntent,
    isRegistered,
    getClient,
    saveClient,
    normalizePhone,
  };
}

module.exports = { createBrainEngine };
