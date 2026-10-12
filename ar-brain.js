/**
 * AutoResponder brain — official "Connect your web server" contract
 * POST JSON in → { replies: [{ message }] } out
 * One URL for all rules (or catch-all * rule)
 */

function moneyR(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'R0.00';
  return 'R' + v.toFixed(2);
}

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).replace(/\D/g, '');
  // AutoResponder sometimes sends "Name +2782..." or just digits
  if (s.length > 11 && s.startsWith('27')) s = s.slice(0, 11);
  if (s.startsWith('0') && s.length === 10) s = '27' + s.slice(1);
  if (s.length < 9) return null;
  return s;
}

function extractPhoneFromSender(sender) {
  if (!sender) return null;
  const s = String(sender);
  // Prefer last phone-looking sequence
  const matches = s.match(/(\+?\d[\d\s\-]{8,}\d)/g);
  if (matches && matches.length) return normalizePhone(matches[matches.length - 1]);
  return normalizePhone(s);
}

function reply(messages) {
  const list = (Array.isArray(messages) ? messages : [messages])
    .filter((m) => m != null && String(m).trim() !== '')
    .map((m) => ({ message: String(m) }));
  return { replies: list.length ? list : [{ message: 'Reply *menu* for options.' }] };
}

function mountArBrain(app, ctx) {
  const {
    statusAuthOptional, // not used — AR posts without our token in body; use header or shared secret
    waClients,
    workspaces,
    invoiceStatus,
    ticketsIntake,
    persistTickets,
    persistWaClients,
    pushNotification,
    now,
    uuidv4,
    ALLOWED_STATUS_TOKENS,
    DEFAULT_STATUS_TOKEN,
  } = ctx;

  function checkArAuth(req) {
    // Header X-Status-Token or Authorization Bearer or query token
    const h = req.headers['x-status-token'] || '';
    const auth = req.headers.authorization || '';
    let t = String(h || '').trim();
    if (!t && auth.toLowerCase().startsWith('bearer ')) t = auth.slice(7).trim();
    if (!t && req.query?.token) t = String(req.query.token).trim();
    // Basic auth password field often used for token
    if (!t && req.headers.authorization && req.headers.authorization.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8');
        const pass = decoded.split(':').slice(1).join(':');
        if (pass) t = pass.trim();
      } catch {}
    }
    if (!t) return ALLOWED_STATUS_TOKENS.has(DEFAULT_STATUS_TOKEN); // allow default for AR simplicity
    return ALLOWED_STATUS_TOKENS.has(t);
  }

  function getProfile(phone) {
    const p = normalizePhone(phone);
    if (!p) return null;
    return waClients[p] || null;
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
    const intake = (ticketsIntake?.items || []).filter((t) => normalizePhone(t.customer_phone) === p);
    return { profile, invoices, quotes, tickets, intake };
  }

  function registerGate() {
    return [
      '🔒 *Client access locked*',
      '',
      'This WhatsApp is not registered yet.',
      'Complete this form to unlock *your* invoices & account:',
      '',
      '*REGISTER*',
      'Name: Your full name',
      'Email: you@email.com',
      'Company: (optional)',
      '',
      'Need a repair now? Reply *5* (job card — open to everyone).',
      '',
      '0️⃣ Menu',
    ].join('\n');
  }

  function menu(phone) {
    const reg = isRegistered(phone);
    const name = reg ? getProfile(phone)?.name : null;
    return [
      reg ? `👋 *Hi ${name}*` : '👋 *PC REPAIR DEX*',
      reg ? '📱 Number matched · your private account' : 'New here? Use *1* to register first.',
      '',
      '*Main menu*',
      '1️⃣ My account',
      '2️⃣ My invoices',
      '3️⃣ Payment / EFT',
      '4️⃣ My quotes',
      '5️⃣ New job card',
      '6️⃣ Statement',
      '7️⃣ Human agent',
      '8️⃣ Hours & location',
      '',
      reg ? '✅ Profile active' : '⚠️ Not registered',
      '',
      'Reply with a *number*.',
    ].join('\n');
  }

  function handleRegister(phone, text) {
    let name = '';
    let email = '';
    let company = '';
    let address = '';
    for (const line of String(text).split(/\r?\n/).map((l) => l.trim())) {
      const mName = line.match(/^(?:name)\s*[:\-]\s*(.+)$/i);
      const mEmail = line.match(/^(?:email|e-mail)\s*[:\-]\s*(.+)$/i);
      const mCo = line.match(/^(?:company|business)\s*[:\-]\s*(.+)$/i);
      const mAddr = line.match(/^(?:address)\s*[:\-]\s*(.+)$/i);
      if (mName) name = mName[1].trim();
      if (mEmail) email = mEmail[1].trim().toLowerCase();
      if (mCo) company = mCo[1].trim();
      if (mAddr) address = mAddr[1].trim();
    }
    if (!phone) return 'Could not read your WhatsApp number. Message from your phone.';
    if (!name || name.length < 2) return registerGate();
    const existing = waClients[phone];
    const isNew = !existing || !existing.registered;
    waClients[phone] = {
      id: existing?.id || uuidv4(),
      phone,
      name,
      email: email || existing?.email || null,
      company: company || existing?.company || null,
      address: address || existing?.address || null,
      source: 'whatsapp_register',
      registered: true,
      linked_client_id: existing?.linked_client_id || null,
      owner_user_id: existing?.owner_user_id || null,
      created_at: existing?.created_at || now(),
      updated_at: now(),
      pending_import: isNew || !existing?.linked_client_id,
    };
    persistWaClients();
    if (isNew || waClients[phone].pending_import) {
      pushNotification({
        type: 'wa_client_new',
        title: 'New WhatsApp client',
        body: `${name} registered (${phone})`,
        payload: { phone, name, email, company },
      });
    }
    return [
      isNew ? '✅ *Profile created*' : '✅ *Profile updated*',
      '',
      '👤 ' + name,
      email ? '📧 ' + email : null,
      '📱 ' + phone,
      '',
      'You can now open *2* My invoices, *3* Payment, *6* Statement.',
      '',
      '0️⃣ Menu',
    ].filter(Boolean).join('\n');
  }

  function handleJob(phone, text) {
    let name = '';
    let device = '';
    let issue = '';
    let urgency = 'normal';
    for (const line of String(text).split(/\r?\n/).map((l) => l.trim())) {
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
    if (!issue && !device) {
      return [
        '🛠 *New job card*',
        '',
        'Send:',
        '*JOB*',
        'Name: Your name',
        'Device: e.g. HP laptop',
        'Issue quant: what is wrong',
        'Urgency: normal / urgent',
        '',
        '0️⃣ Menu',
      ].join('\n').replace('Issue quant:', 'Issue:');
    }
    const ticket = {
      id: uuidv4(),
      source: 'whatsapp',
      customer_name: name || null,
      customer_phone: phone,
      device: device || null,
      issue: issue || null,
      urgency,
      status: 'new',
      created_at: now(),
    };
    if (!Array.isArray(ticketsIntake.items)) ticketsIntake.items = [];
    ticketsIntake.items.unshift(ticket);
    ticketsIntake.items = ticketsIntake.items.slice(0, 500);
    persistTickets();
    pushNotification({
      type: 'ticket_intake',
      title: 'New WhatsApp job',
      body: `${name || phone}: ${issue || device || 'job'}`,
      payload: ticket,
    });
    return [
      '✅ *Job card received*',
      '',
      name ? '👤 ' + name : null,
      device ? '💻 ' + device : null,
      issue ? '⚠️ ' + issue : null,
      '',
      'We will follow up on this number.',
      !isRegistered(phone) ? 'Tip: reply *1* to REGISTER for invoices later.' : null,
      '',
      '0️⃣ Menu',
    ].filter(Boolean).join('\n');
  }

  function route(phone, message) {
    const msg = String(message || '').trim();
    const lower = msg.toLowerCase();

    // REGISTER block
    if (/register/i.test(msg) && /name\s*[:\-]/i.test(msg)) {
      return handleRegister(phone, msg);
    }
    if (/^register$/i.test(msg) || lower === '1' && !isRegistered(phone)) {
      // bare "1" when not registered → gate form
    }

    // JOB block
    if (/\bJOB\b/i.test(msg) && (/device\s*[:\-]/i.test(msg) || /issue\s*[:\-]/i.test(msg))) {
      return handleJob(phone, msg);
    }

    // Invoice number detail
    const invMatch = msg.match(/\b(INV[-\s]?\d{4}[-\s]?\d{1,6}|INV[-\s]?\d{1,6})\b/i);
    if (invMatch) {
      let num = invMatch[1].toUpperCase().replace(/\s+/g, '');
      if (/^INV\d+$/.test(num)) num = 'INV-' + num.slice(3);
      const all = Object.values(invoiceStatus || {});
      let matches = all.filter((r) => r.invoice_number === num);
      if (phone) {
        const locked = matches.filter((r) => r.client_phone === phone);
        if (locked.length) matches = locked;
        else if (matches.some((r) => r.client_phone)) {
          return '🔒 That invoice is not linked to this WhatsApp number.\n\n0️⃣ Menu';
        }
      }
      const inv = matches[0];
      if (!inv) {
        return '📄 Invoice not found. Use exact number e.g. INV-2026-0001\n\n0️⃣ Menu';
      }
      return [
        '📄 *Invoice ' + inv.invoice_number + '*',
        '',
        '👤 ' + (inv.client_name || 'Client'),
        '💵 Total: ' + moneyR(inv.total),
        '💳 Balance: ' + moneyR(inv.balance_due),
        '📊 Status: *' + String(inv.status || '').toUpperCase() + '*',
        inv.due_date ? '📅 Due: ' + String(inv.due_date).slice(0, 10) : null,
        '',
        '0️⃣ Menu',
      ].filter(Boolean).join('\n');
    }

    // Menu triggers
    if (/^(0|menu|hi|hello|hey|help|start|back)$/i.test(msg) || /\bmenu\b/i.test(msg)) {
      return menu(phone);
    }

    // Choice 1 profile
    if (/^(1|account|profile|my account)$/i.test(msg)) {
      if (!isRegistered(phone)) return registerGate();
      const c = getProfile(phone);
      const { invoices, quotes, tickets, intake } = docsForPhone(phone);
      const open = invoices.filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()));
      const ar = open.reduce((s, i) => s + (Number(i.balance_due ?? i.total) || 0), 0);
      return [
        '👤 *Your account*',
        '',
        'Name: *' + (c.name || '—') + '*',
        c.email ? 'Email: ' + c.email : null,
        'WhatsApp: ' + phone,
        c.company ? 'Company: ' + c.company : null,
        '',
        '📊 Open invoices: ' + open.length,
        '💳 Outstanding: *' + moneyR(ar) + '*',
        '📋 Quotes: ' + quotes.length,
        '🛠 Jobs: ' + (tickets.length + intake.length),
        '',
        '2️⃣ Invoices · 6️⃣ Statement · 5️⃣ Job',
        '',
        '0️⃣ Menu',
      ].filter((x) => x !== null).join('\n');
    }

    if (/^(2|invoices|my invoices)$/i.test(msg)) {
      if (!isRegistered(phone)) return registerGate();
      const { invoices } = docsForPhone(phone);
      if (!invoices.length) {
        return '📄 *Your invoices*\n\nNone linked yet.\nReply *5* for a job card.\n\n0️⃣ Menu';
      }
      const lines = ['📄 *Your invoices*', ''];
      for (const inv of invoices.slice(0, 12)) {
        lines.push(`• *${inv.invoice_number}* · ${moneyR(inv.balance_due ?? inv.total)} · *${String(inv.status || '').toUpperCase()}*`);
      }
      lines.push('', 'Send an invoice number for detail.', '', '0️⃣ Menu');
      return lines.join('\n');
    }

    if (/^(3|payment|pay|eft)$/i.test(msg)) {
      if (!isRegistered(phone)) return registerGate();
      const { invoices } = docsForPhone(phone);
      const open = invoices.filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()));
      const ar = open.reduce((s, i) => s + (Number(i.balance_due ?? i.total) || 0), 0);
      const lines = ['💳 *Payment / EFT*', ''];
      if (open.length) {
        lines.push(`Open: *${open.length}* · Outstanding *${moneyR(ar)}*`, '');
        for (const inv of open.slice(0, 8)) {
          lines.push(`• ${inv.invoice_number} — ${moneyR(inv.balance_due ?? inv.total)}`);
        }
        lines.push('', 'Use invoice number as EFT reference. Send POP here.');
      } else {
        lines.push('No open balance on this number.');
      }
      lines.push('', '0️⃣ Menu');
      return lines.join('\n');
    }

    if (/^(4|quotes|my quotes)$/i.test(msg)) {
      if (!isRegistered(phone)) return registerGate();
      const { quotes } = docsForPhone(phone);
      if (!quotes.length) return '📋 *Your quotes*\n\nNone on file.\n\n0️⃣ Menu';
      const lines = ['📋 *Your quotes*', ''];
      for (const q of quotes.slice(0, 10)) {
        lines.push(`• *${q.number || q.id}* · ${moneyR(q.total)} · ${String(q.status || 'draft').toUpperCase()}`);
      }
      lines.push('', '0️⃣ Menu');
      return lines.join('\n');
    }

    if (/^(5|job|repair|ticket)$/i.test(msg)) {
      return handleJob(phone, '');
    }

    if (/^(6|statement)$/i.test(msg)) {
      if (!isRegistered(phone)) return registerGate();
      const { profile, invoices } = docsForPhone(phone);
      const open = invoices.filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()));
      const ar = open.reduce((s, i) => s + (Number(i.balance_due ?? i.total) || 0), 0);
      const lines = [
        '📑 *Account statement*',
        '',
        '👤 ' + (profile?.name || 'Client'),
        '📱 ' + phone,
        `Date: ${new Date().toISOString().slice(0, 10)}`,
        '',
      ];
      if (!open.length) lines.push('No outstanding invoices.');
      else {
        lines.push(`Outstanding: *${moneyR(ar)}*`, '');
        for (const inv of open.slice(0, 15)) {
          lines.push(`• ${inv.invoice_number} · ${moneyR(inv.balance_due ?? inv.total)} · ${String(inv.status || '').toUpperCase()}`);
        }
      }
      lines.push('', '0️⃣ Menu');
      return lines.join('\n');
    }

    if (/^(7|human|agent)$/i.test(msg)) {
      return '🙋 A team member will reply on this chat shortly.\n\n0️⃣ Menu';
    }

    if (/^(8|hours|location|address)$/i.test(msg)) {
      return [
        '📍 *PC REPAIR DEX*',
        '',
        'Hours: Mon–Fri 09:00–17:00',
        'Sat: 09:00–13:00 (by appointment)',
        'Reply *7* for directions or a call-back.',
        '',
        '0️⃣ Menu',
      ].join('\n');
    }

    // Fallback
    return menu(phone);
  }

  /**
   * Official AutoResponder webhook
   * Enable "Connect your web server" → this URL only
   */
  app.post('/api/ar', (req, res) => {
    if (!checkArAuth(req)) {
      return res.status(403).json(reply('⚠️ Unauthorized. Check token / Basic Auth password.'));
    }

    const data = req.body || {};
    const q = data.query || {};
    const message = q.message || data.message || '';
    const sender = q.sender || data.sender || '';
    // Prefer phone from header if user set custom header Phone
    const headerPhone = req.headers['x-wa-phone'] || req.headers['x-phone'] || '';
    let phone = normalizePhone(headerPhone) || extractPhoneFromSender(sender);

    // Some AR builds put number in sender as jid-like
    if (!phone && q.senderNumber) phone = normalizePhone(q.senderNumber);

    try {
      const text = route(phone, message);
      return res.status(200).json(reply(text));
    } catch (e) {
      console.error('ar-brain', e);
      return res.status(200).json(reply('Temporary error. Reply *menu* or try again.'));
    }
  });

  // Health for AR testing
  app.get('/api/ar', (req, res) => {
    res.json({
      ok: true,
      name: 'SAIP AutoResponder Brain',
      version: '1.5.0',
      usage: 'POST JSON from AutoResponder Connect your web server',
      expects: '{ query: { sender, message } }',
      returns: '{ replies: [{ message }] }',
    });
  });
}

module.exports = { mountArBrain };
