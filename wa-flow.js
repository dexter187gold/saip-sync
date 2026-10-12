/**
 * WhatsApp client flow — Capitec-style number match
 * Registered phone → own docs only
 * New phone → register form before private docs
 * Job card allowed for new users (with soft register prompt)
 */

function moneyR(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'R0.00';
  return 'R' + v.toFixed(2);
}

function mountWaFlow(app, ctx) {
  const {
    statusAuth,
    normalizePhone,
    waClients,
    workspaces,
    invoiceStatus,
    ticketsIntake,
    persistTickets,
    pushNotification,
    now,
    uuidv4,
    PUBLIC_BASE,
  } = ctx;

  function getProfile(phone) {
    const p = normalizePhone(phone);
    if (!p) return null;
    return waClients[p] || null;
  }

  function isRegistered(phone) {
    const c = getProfile(phone);
    return !!(c && c.registered);
  }

  function registerGateText() {
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
      'After that, reply *menu*.',
      '',
      'Need a repair now? Reply *5* for a new job card (registration still recommended).',
      '',
      '0️⃣ Menu',
    ].join('\n');
  }

  /** Snapshot docs for this phone from workspaces + status index */
  function docsForPhone(phone) {
    const p = normalizePhone(phone);
    const profile = getProfile(p);
    const invoices = Object.values(invoiceStatus || {})
      .filter((r) => r.client_phone === p)
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));

    // Prefer workspace data if linked
    let quotes = [];
    let tickets = [];
    let portalHint = null;
    if (profile?.owner_user_id && profile?.linked_client_id) {
      const ws = workspaces[profile.owner_user_id]?.data || {};
      const cid = String(profile.linked_client_id);
      quotes = (ws.quotes || []).filter((q) => String(q.clientId) === cid)
        .sort((a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || '')));
      tickets = (ws.tickets || []).filter((t) => String(t.clientId) === cid)
        .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    }
    // Intake tickets by phone
    const intake = (ticketsIntake?.items || []).filter(
      (t) => normalizePhone(t.customer_phone) === p
    );

    return { profile, invoices, quotes, tickets, intake };
  }

  // ——— MAIN MENU (personalised) ———
  app.get('/api/wa/menu', statusAuth, (req, res) => {
    const phone = normalizePhone(req.query.phone || req.query.from || '');
    const reg = isRegistered(phone);
    const name = reg ? (getProfile(phone)?.name || 'Client') : null;

    const head = reg
      ? [`👋 *Hi ${name}*`, '📱 Number matched · your account', '']
      : ['👋 *PC REPAIR DEX*', 'New on WhatsApp? Register under *1* first.', ''];

    const body = [
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
      'Reply with a *number*.',
      '0️⃣ Menu',
    ];
    res.type('text/plain').send(body.join('\n'));
  });

  // ——— 1 PROFILE / CLIENT INFO ———
  app.get('/api/wa/profile', statusAuth, (req, res) => {
    const phone = normalizePhone(req.query.phone || req.query.from || '');
    if (!phone) {
      return res.type('text/plain').send('Could not read your number.\n\n0️⃣ Menu');
    }
    if (!isRegistered(phone)) {
      return res.type('text/plain').send(registerGateText());
    }
    const c = getProfile(phone);
    const { invoices, quotes, tickets, intake } = docsForPhone(phone);
    const open = invoices.filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()));
    const ar = open.reduce((s, i) => s + (Number(i.balance_due ?? i.total) || 0), 0);

    res.type('text/plain').send(
      [
        '👤 *Your account*',
        '',
        'Name: *' + (c.name || '—') + '*',
        c.email ? 'Email: ' + c.email : null,
        'WhatsApp: ' + phone,
        c.company ? 'Company: ' + c.company : null,
        c.address ? 'Address: ' + c.address : null,
        '',
        '📊 Open invoices: ' + open.length,
        '💳 Outstanding: *' + moneyR(ar) + '*',
        '📋 Quotes on file: ' + quotes.length,
        '🛠 Job cards: ' + (tickets.length + intake.length),
        '',
        '2️⃣ My invoices  ·  6️⃣ Statement  ·  5️⃣ New job',
        '',
        '0️⃣ Menu',
      ].filter((x) => x !== null).join('\n')
    );
  });

  // ——— 2 MY INVOICES (list, no mixing) ———
  app.get('/api/wa/my-invoices', statusAuth, (req, res) => {
    const phone = normalizePhone(req.query.phone || req.query.from || '');
    if (!phone) return res.type('text/plain').send('Number missing.\n\n0️⃣ Menu');
    if (!isRegistered(phone)) return res.type('text/plain').send(registerGateText());

    const { invoices } = docsForPhone(phone);
    if (!invoices.length) {
      return res.type('text/plain').send(
        [
          '📄 *Your invoices*',
          '',
          'No invoices linked to this number yet.',
          'After we bill you, they appear here automatically.',
          '',
          'Need a repair? Reply *5*',
          '',
          '0️⃣ Menu',
        ].join('\n')
      );
    }

    const lines = ['📄 *Your invoices*', ''];
    for (const inv of invoices.slice(0, 12)) {
      lines.push(
        `• *${inv.invoice_number}* · ${moneyR(inv.balance_due ?? inv.total)} · *${String(inv.status || 'unpaid').toUpperCase()}*`
      );
      if (inv.due_date) lines.push(`  Due ${String(inv.due_date).slice(0, 10)}`);
    }
    if (invoices.length > 12) lines.push(`…and ${invoices.length - 12} more`);
    lines.push('', 'Send an invoice number (e.g. INV-2026-0001) for full detail.', '', '0️⃣ Menu');
    res.type('text/plain').send(lines.join('\n'));
  });

  // ——— 3 PAYMENT ———
  app.get('/api/wa/payment', statusAuth, (req, res) => {
    const phone = normalizePhone(req.query.phone || req.query.from || '');
    if (!phone) return res.type('text/plain').send('Number missing.\n\n0️⃣ Menu');
    if (!isRegistered(phone)) return res.type('text/plain').send(registerGateText());

    const { invoices } = docsForPhone(phone);
    const open = invoices.filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()));
    const ar = open.reduce((s, i) => s + (Number(i.balance_due ?? i.total) || 0), 0);

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
      '',
      'Banking details: reply *bank* or ask our agent (*7*).',
      '',
      '0️⃣ Menu'
    );
    res.type('text/plain').send(lines.join('\n'));
  });

  // ——— 4 QUOTES ———
  app.get('/api/wa/my-quotes', statusAuth, (req, res) => {
    const phone = normalizePhone(req.query.phone || req.query.from || '');
    if (!phone) return res.type('text/plain').send('Number missing.\n\n0️⃣ Menu');
    if (!isRegistered(phone)) return res.type('text/plain').send(registerGateText());

    const { quotes } = docsForPhone(phone);
    if (!quotes.length) {
      return res.type('text/plain').send(
        ['📋 *Your quotes*', '', 'No quotes on file for this number.', '', 'Request one: describe the job and reply *7*.', '', '0️⃣ Menu'].join('\n')
      );
    }
    const lines = ['📋 *Your quotes*', ''];
    for (const q of quotes.slice(0, 10)) {
      lines.push(
        `• *${q.number || q.id}* · ${moneyR(q.total)} · ${String(q.status || 'draft').toUpperCase()}`
      );
    }
    lines.push('', '0️⃣ Menu');
    res.type('text/plain').send(lines.join('\n'));
  });

  // ——— 5 NEW JOB (allowed for new users) ———
  app.get('/api/wa/job-prompt', statusAuth, (req, res) => {
    const phone = normalizePhone(req.query.phone || req.query.from || '');
    const reg = isRegistered(phone);
    const name = reg ? getProfile(phone)?.name : null;

    res.type('text/plain').send(
      [
        '🛠 *New job card*',
        '',
        reg ? `Hi ${name} — send one message:` : 'You can open a job without invoices.',
        !reg ? 'Registration (*1*) is still recommended so we link the job to your profile.' : null,
        '',
        '*JOB*',
        'Name: ' + (name || 'Your name'),
        'Device: e.g. HP laptop',
        'Issue: what is wrong',
        'Urgency: normal / urgent',
        '',
        'Example:',
        'JOB',
        'Name: Thabo',
        'Device: Dell Latitude',
        'Issue: No power',
        'Urgency: urgent',
        '',
        '0️⃣ Menu',
      ].filter((x) => x !== null).join('\n')
    );
  });

  // Accept JOB block
  app.all('/api/wa/job', statusAuth, (req, res) => {
    const b = { ...(req.query || {}), ...(req.body || {}) };
    let phone = normalizePhone(b.phone || b.from || '');
    let name = (b.name || '').trim();
    let device = (b.device || '').trim();
    let issue = (b.issue || b.description || '').trim();
    let urgency = (b.urgency || 'normal').trim().toLowerCase();
    const text = String(b.text || b.message || b.body || '');

    if (text) {
      for (const line of text.split(/\r?\n/).map((l) => l.trim())) {
        const mName = line.match(/^(?:name)\s*[:\-]\s*(.+)$/i);
        const mDev = line.match(/^(?:device|pc|laptop)\s*[:\-]\s*(.+)$/i);
        const mIssue = line.match(/^(?:issue|problem|fault)\s*[:\-]\s*(.+)$/i);
        const mUrg = line.match(/^(?:urgency|priority)\s*[:\-]\s*(.+)$/i);
        if (mName) name = mName[1].trim();
        if (mDev) device = mDev[1].trim();
        if (mIssue) issue = mIssue[1].trim();
        if (mUrg) urgency = mUrg[1].trim().toLowerCase();
      }
    }

    if (!phone) {
      return res.type('text/plain').send('Phone missing. Message from WhatsApp.\n\n0️⃣ Menu');
    }
    if (!issue && !device) {
      return res.type('text/plain').send(
        ['Send:', '*JOB*', 'Name: …', 'Device: …', 'Issue: …', '', '0️⃣ Menu'].join('\n')
      );
    }

    const profile = getProfile(phone);
    if (profile?.name && !name) name = profile.name;

    const ticket = {
      id: uuidv4(),
      source: 'whatsapp',
      customer_name: name || profile?.name || null,
      customer_phone: phone,
      device: device || null,
      issue: issue || null,
      urgency: urgency || 'normal',
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
      body: `${ticket.customer_name || phone}: ${issue || device || 'job'}`,
      payload: ticket,
    });

    res.type('text/plain').send(
      [
        '✅ *Job card received*',
        '',
        ticket.customer_name ? '👤 ' + ticket.customer_name : null,
        ticket.device ? '💻 ' + ticket.device : null,
        ticket.issue ? '⚠️ ' + ticket.issue : null,
        '⏱ ' + (ticket.urgency || 'normal'),
        '',
        'Our team will follow up on this number.',
        !isRegistered(phone)
          ? 'Tip: reply *1* and REGISTER so future invoices link to you.'
          : null,
        '',
        '0️⃣ Menu',
      ].filter((x) => x !== null).join('\n')
    );
  });

  // ——— 6 STATEMENT ———
  app.get('/api/wa/statement', statusAuth, (req, res) => {
    const phone = normalizePhone(req.query.phone || req.query.from || '');
    if (!phone) return res.type('text/plain').send('Number missing.\n\n0️⃣ Menu');
    if (!isRegistered(phone)) return res.type('text/plain').send(registerGateText());

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
    if (!open.length) {
      lines.push('No outstanding invoices. Thank you!');
    } else {
      lines.push(`Outstanding: *${moneyR(ar)}*`, '', '*Open invoices:*');
      for (const inv of open.slice(0, 15)) {
        lines.push(
          `• ${inv.invoice_number} · ${moneyR(inv.balance_due ?? inv.total)} · ${String(inv.status || '').toUpperCase()}`
        );
      }
    }
    lines.push('', '0️⃣ Menu');
    res.type('text/plain').send(lines.join('\n'));
  });
}

module.exports = { mountWaFlow };
