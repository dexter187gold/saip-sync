/**
 * SAIP Conversational Brain Engine v3
 * Intent detection · multi-step flows · short-term memory · FAQ · smart routing
 */

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).replace(/\D/g, '');
  if (!s) return null;
  if (s.startsWith('0') && s.length === 10) s = '27' + s.slice(1);
  if (s.startsWith('27') && s.length > 11) s = s.slice(0, 11);
  if (s.length < 9 || s.length > 15) return null;
  return s;
}

function moneyR(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'R0.00';
  return 'R' + v.toFixed(2);
}

/** Lightweight intent classifier (keyword + regex scoring) */
function detectIntent(message) {
  const t = String(message || '').trim().toLowerCase();
  if (!t) return { intent: 'empty', confidence: 1 };

  const rules = [
    { intent: 'cancel', score: 10, tests: [/^(cancel|stop|exit|quit)$/i, /\bcancel\b/] },
    { intent: 'menu', score: 10, tests: [/^(0|menu|back|main)$/i, /\bmain menu\b/] },
    { intent: 'greeting', score: 8, tests: [/^(hi|hello|hey|howdy|good morning|good afternoon|good evening)\b/i] },
    { intent: 'thanks', score: 8, tests: [/^(thanks|thank you|ty|thx|sharp|lekker)\b/i] },
    { intent: 'register', score: 9, tests: [/^(1|register|sign up|signup)$/i, /\bregister\b/, /\bsign\s*up\b/] },
    { intent: 'account', score: 8, tests: [/^(account|profile|my account)$/i, /\bmy account\b/] },
    { intent: 'invoices', score: 9, tests: [/^(2|invoices?|my invoices?)$/i, /\binvoice/] },
    { intent: 'payment', score: 9, tests: [/^(3|pay|payment|eft|banking|bank)$/i, /\bpay(ment)?\b/, /\beft\b/, /\bbank/] },
    { intent: 'quotes', score: 8, tests: [/^(4|quotes?|my quotes?)$/i, /\bquote/] },
    { intent: 'job', score: 9, tests: [/^(5|job|repair|ticket|fix)$/i, /\brepair\b/, /\bbroken\b/, /\bnot working\b/, /\bfault\b/] },
    { intent: 'statement', score: 8, tests: [/^(6|statement|balance)$/i, /\bstatement\b/] },
    { intent: 'human', score: 9, tests: [/^(7|human|agent|person|call me|callback)$/i, /\btalk to (a )?human\b/, /\breal person\b/] },
    { intent: 'hours', score: 8, tests: [/^(8|hours|location|address|where|open)$/i, /\bopening hours\b/, /\bwhere are you\b/] },
    { intent: 'faq_price', score: 7, tests: [/\bprice/, /\bcost/, /\bhow much/, /\brates?\b/, /\bfee/] },
    { intent: 'faq_warranty', score: 7, tests: [/\bwarranty/, /\bguarantee/, /\bcover(ed)?\b/] },
    { intent: 'faq_data', score: 7, tests: [/\bdata recovery/, /\blost (my )?files/, /\bhard drive/, /\bssd/] },
    { intent: 'faq_pickup', score: 6, tests: [/\bpick\s*up/, /\bcollection/, /\bdrop.?off/, /\bdeliver/] },
    { intent: 'pop', score: 8, tests: [/\bpop\b/, /\bproof of payment/, /\bpaid\b/, /\bi (have )?paid/] },
    { intent: 'feedback', score: 7, tests: [/\bfeedback/, /\breview/, /\brating/, /\bcomplain/] },
    { intent: 'status', score: 7, tests: [/\bstatus/, /\bupdate on/, /\bany news/, /\bprogress/] },
    { intent: 'quote_accept', score: 10, tests: [/\baccept\s+[A-Z0-9\-]+/i] },
    { intent: 'quote_reject', score: 10, tests: [/\breject\s+[A-Z0-9\-]+/i] },
    { intent: 'quote_deposit', score: 10, tests: [/\bdeposit\s+[A-Z0-9\-]+/i] },
    { intent: 'invoice_lookup', score: 10, tests: [/\bINV[-\s]?\d/i] },
    { intent: 'help', score: 6, tests: [/\bhelp\b/, /\bwhat can you/, /\boptions\b/] },
  ];

  let best = { intent: 'unknown', confidence: 0 };
  for (const r of rules) {
    for (const test of r.tests) {
      if (test.test(t)) {
        const conf = r.score / 10;
        if (conf > best.confidence) best = { intent: r.intent, confidence: conf };
      }
    }
  }
  return best;
}

const FAQ = {
  faq_price: [
    '💰 *Pricing*',
    '',
    'Diagnostics from *R150* (often waived if you proceed).',
    'Labour and parts quoted before work starts.',
    'Reply *5* for a job card or *4* for quotes.',
    '',
    '0️⃣ Menu',
  ].join('\n'),
  faq_warranty: [
    '🛡 *Warranty*',
    '',
    'Labour typically covered for *30 days* on the same fault.',
    'Parts follow manufacturer warranty where applicable.',
    'Keep your invoice number handy.',
    '',
    '0️⃣ Menu',
  ].join('\n'),
  faq_data: [
    '💾 *Data recovery*',
    '',
    'We assess drives carefully — no fixed price until diagnosed.',
    'Reply *5* and mention *data recovery* in the issue.',
    '',
    '0️⃣ Menu',
  ].join('\n'),
  faq_pickup: [
    '🚚 *Drop-off / collection*',
    '',
    'Drop-off during business hours preferred.',
    'Collection may be available in selected areas — reply *7* to arrange.',
    '',
    '0️⃣ Menu',
  ].join('\n'),
};

const FLOW_DEFS = {
  register: {
    steps: [
      { key: 'name', prompt: '👤 What is your *full name and surname*?', required: true, validate: (v) => v.length >= 2 },
      { key: 'phone', prompt: '📱 Your *cellphone / WhatsApp number*?\n(e.g. 0821234567)', required: true, validate: (v) => !!normalizePhone(v), transform: normalizePhone },
      { key: 'email', prompt: '📧 *Email address*?\n(or reply *skip*)', required: false, validate: (v) => v === 'skip' || /@/.test(v) },
      { key: 'company', prompt: '🏢 *Company*?\n(or *skip*)', required: false, validate: () => true },
      { key: 'city', prompt: '🏙 *City / town*?\n(or *skip*)', required: false, validate: () => true },
    ],
  },
  job: {
    steps: [
      { key: 'name', prompt: '👤 *Your name* for this job?', required: true, validate: (v) => v.length >= 2 },
      { key: 'device', prompt: '💻 What *device*?\n(e.g. HP laptop, desktop, printer)', required: true, validate: (v) => v.length >= 2 },
      { key: 'issue', prompt: '⚠️ Describe the *fault / issue*:', required: true, validate: (v) => v.length >= 3 },
      { key: 'urgency', prompt: '⏱ Urgency? Reply *normal* or *urgent*', required: true, validate: (v) => /^(normal|urgent|high|low)$/i.test(v), transform: (v) => v.toLowerCase() },
    ],
  },
  pop: {
    steps: [
      { key: 'invoice', prompt: '🧾 Which *invoice number* did you pay?\n(e.g. INV-2026-0001)', required: true, validate: (v) => /inv/i.test(v) || /\d{3,}/.test(v) },
      { key: 'amount', prompt: '💵 *Amount paid*?\n(e.g. 1500 or R1500)', required: true, validate: (v) => /\d/.test(v) },
      { key: 'ref', prompt: '🏷 *Bank reference* used?\n(or *skip*)', required: false, validate: () => true },
      { key: 'note', prompt: '📝 Any *note*?\n(or *skip*)', required: false, validate: () => true },
    ],
  },
  feedback: {
    steps: [
      { key: 'rating', prompt: '⭐ Rate us *1–5* (5 = excellent)', required: true, validate: (v) => /^[1-5]$/.test(v) },
      { key: 'comment', prompt: '💬 Any *comment*?\n(or *skip*)', required: false, validate: () => true },
    ],
  },
  callback: {
    steps: [
      { key: 'name', prompt: '👤 *Your name*?', required: true, validate: (v) => v.length >= 2 },
      { key: 'phone', prompt: '📱 Best *number to call*?', required: true, validate: (v) => !!normalizePhone(v), transform: normalizePhone },
      { key: 'when', prompt: '🕐 Preferred *time*?\n(e.g. today after 15:00)', required: true, validate: (v) => v.length >= 2 },
      { key: 'topic', prompt: '📌 What is it *about*?', required: true, validate: (v) => v.length >= 3 },
    ],
  },
};

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
    uuidv4,
    PUBLIC_BASE,
    getPayConfig,
  } = ctx;

  // Short-term memory per session key (last intents)
  const memory = {};

  function sessionKey(phone, sender) {
    if (phone) return 'p:' + phone;
    return 's:' + String(sender || 'unknown').trim().toLowerCase().slice(0, 80);
  }

  function remember(key, intent) {
    if (!memory[key]) memory[key] = { intents: [], updated: Date.now() };
    memory[key].intents.unshift({ intent, at: Date.now() });
    memory[key].intents = memory[key].intents.slice(0, 8);
    memory[key].updated = Date.now();
  }

  function getSess(phone, sender) {
    const k = sessionKey(phone, sender);
    const s = sessions[k];
    if (!s) return null;
    if (s.updated_at && Date.now() - new Date(s.updated_at).getTime() > 2 * 3600 * 1000) {
      delete sessions[k];
      persistSessions();
      return null;
    }
    return { key: k, ...s };
  }

  function setSess(phone, sender, data) {
    const k = sessionKey(phone, sender);
    sessions[k] = { ...data, updated_at: now() };
    if (data.data && data.data.phone) {
      const pk = 'p:' + normalizePhone(data.data.phone);
      if (pk !== k) sessions[pk] = sessions[k];
    }
    persistSessions();
  }

  function clearSess(phone, sender) {
    const k = sessionKey(phone, sender);
    delete sessions[k];
    if (phone) delete sessions['p:' + phone];
    persistSessions();
  }

  function isRegistered(phone) {
    const c = phone && waClients[phone];
    return !!(c && c.registered);
  }

  function profile(phone) {
    return phone ? waClients[phone] || null : null;
  }

  function payBlurb() {
    const pay = typeof getPayConfig === 'function' ? getPayConfig() : null;
    if (!pay || !pay.account_number) {
      return ['Bank details not set yet — reply *7* for help.'];
    }
    return [
      'Bank: *' + (pay.bank_name || '') + '*',
      'Name: ' + (pay.account_name || ''),
      'Account: *' + pay.account_number + '*',
      pay.branch_code ? 'Branch: ' + pay.branch_code : null,
      pay.reference_hint || 'Use invoice number as reference',
    ].filter(Boolean);
  }

  function menu(phone) {
    const reg = isRegistered(phone);
    const name = reg ? profile(phone)?.name : null;
    const base = PUBLIC_BASE || 'https://saip-sync.onrender.com';
    return [
      reg ? `👋 *Hi ${name}*` : '👋 *PC REPAIR DEX assistant*',
      reg ? '📱 Verified client account' : 'New here? Reply *1* — quick step-by-step signup.',
      '',
      '*Quick menu*',
      '1️⃣ Account / register',
      '2️⃣ Invoices',
      '3️⃣ Pay / banking',
      '4️⃣ Quotes',
      '5️⃣ New job / repair',
      '6️⃣ Statement',
      '7️⃣ Human / callback',
      '8️⃣ Hours & location',
      '',
      '*Also try*',
      '• *price* · *warranty* · *data recovery*',
      '• *I paid* (proof of payment)',
      '• *feedback*',
      '• invoice number e.g. INV-2026-0001',
      '',
      reg ? '✅ Registered' : '⚠️ Not registered',
      '🌐 ' + base + '/forms/register',
      '',
      'Reply a *number* or just type naturally.',
    ].join('\n');
  }

  function startFlow(type, phone, sender, prefill) {
    const def = FLOW_DEFS[type];
    if (!def) return menu(phone);
    let step = 0;
    const data = { ...(prefill || {}) };
    // skip steps already prefilled
    while (step < def.steps.length && data[def.steps[step].key]) step++;
    setSess(phone, sender, { type, step, data });
    if (step >= def.steps.length) {
      return finishFlow(type, data, phone, sender);
    }
    const headers = {
      register: '📝 *Registration* — one question at a time\n🌐 ' + (PUBLIC_BASE || '') + '/forms/register',
      job: '🛠 *Job card* — one question at a time\n🌐 ' + (PUBLIC_BASE || '') + '/forms/job',
      pop: '✅ *Proof of payment*',
      feedback: '⭐ *Feedback*',
      callback: '📞 *Callback request*',
    };
    return [
      headers[type] || type,
      'Reply *cancel* to stop.',
      '',
      `(${step + 1}/${def.steps.length}) ` + def.steps[step].prompt,
    ].join('\n');
  }

  function finishFlow(type, data, phone, sender) {
    clearSess(phone, sender);
    if (type === 'register') {
      const p = normalizePhone(data.phone) || phone;
      if (!p || !data.name) return 'Incomplete. Reply *1* to try again.';
      const existing = waClients[p];
      const isNew = !existing || !existing.registered;
      const clean = (v) => (v && v !== 'skip' ? v : null);
      waClients[p] = {
        id: existing?.id || uuidv4(),
        phone: p,
        name: data.name,
        email: clean(data.email) || existing?.email || null,
        company: clean(data.company) || existing?.company || null,
        city: clean(data.city) || existing?.city || null,
        source: 'whatsapp_brain',
        registered: true,
        linked_client_id: existing?.linked_client_id || null,
        owner_user_id: existing?.owner_user_id || null,
        created_at: existing?.created_at || now(),
        updated_at: now(),
        pending_import: isNew || !existing?.linked_client_id,
      };
      persistWaClients();
      pushNotification({
        type: 'wa_client_new',
        title: isNew ? 'New client' : 'Client updated',
        body: `${data.name} (${p})`,
        payload: waClients[p],
      });
      return [
        isNew ? '✅ *You are registered!*' : '✅ *Profile updated*',
        '',
        '👤 ' + data.name,
        '📱 ' + p,
        clean(data.email) ? '📧 ' + clean(data.email) : null,
        '',
        'Next: *2* invoices · *5* job · *menu*',
      ].filter(Boolean).join('\n');
    }
    if (type === 'job') {
      const ticket = {
        id: uuidv4(),
        source: 'whatsapp_brain',
        customer_name: data.name || null,
        customer_phone: phone || null,
        device: data.device || null,
        issue: data.issue || null,
        urgency: data.urgency || 'normal',
        status: 'new',
        created_at: now(),
      };
      if (!Array.isArray(ticketsIntake.items)) ticketsIntake.items = [];
      ticketsIntake.items.unshift(ticket);
      ticketsIntake.items = ticketsIntake.items.slice(0, 500);
      persistTickets();
      pushNotification({
        type: 'ticket_intake',
        title: 'New job card',
        body: `${data.name || phone}: ${data.issue || data.device}`,
        payload: ticket,
      });
      return [
        '✅ *Job card logged*',
        '',
        data.name ? '👤 ' + data.name : null,
        data.device ? '💻 ' + data.device : null,
        data.issue ? '⚠️ ' + data.issue : null,
        '⏱ ' + (data.urgency || 'normal'),
        '',
        'We will update you on this chat.',
        '0️⃣ Menu',
      ].filter(Boolean).join('\n');
    }
    if (type === 'pop') {
      pushNotification({
        type: 'pop_received',
        title: 'POP from WhatsApp',
        body: `${data.invoice} · ${data.amount} · ${phone || ''}`,
        payload: { ...data, phone },
      });
      return [
        '✅ *Payment note received*',
        '',
        'Invoice: *' + data.invoice + '*',
        'Amount: ' + data.amount,
        data.ref && data.ref !== 'skip' ? 'Ref: ' + data.ref : null,
        '',
        'Accounts will verify and update your invoice.',
        '0️⃣ Menu',
      ].filter(Boolean).join('\n');
    }
    if (type === 'feedback') {
      pushNotification({
        type: 'feedback',
        title: 'Feedback ' + data.rating + '/5',
        body: data.comment && data.comment !== 'skip' ? data.comment : 'No comment',
        payload: { ...data, phone },
      });
      return [
        '🙏 *Thank you!*',
        '',
        'Rating: *' + data.rating + '/5*',
        'We appreciate your feedback.',
        '0️⃣ Menu',
      ].join('\n');
    }
    if (type === 'callback') {
      pushNotification({
        type: 'callback',
        title: 'Callback: ' + data.name,
        body: `${data.phone} · ${data.when} · ${data.topic}`,
        payload: { ...data },
      });
      return [
        '📞 *Callback booked*',
        '',
        '👤 ' + data.name,
        '📱 ' + data.phone,
        '🕐 ' + data.when,
        '📌 ' + data.topic,
        '',
        'We will call you back.',
        '0️⃣ Menu',
      ].join('\n');
    }
    return menu(phone);
  }

  function processActiveFlow(phone, sender, message) {
    const sess = getSess(phone, sender);
    if (!sess || !FLOW_DEFS[sess.type]) return null;
    const msg = String(message || '').trim();
    if (/^(cancel|stop|exit|quit|menu|0)$/i.test(msg)) {
      clearSess(phone, sender);
      return 'Cancelled. Reply *menu* when you are ready.';
    }
    const def = FLOW_DEFS[sess.type];
    let step = sess.step || 0;
    const data = { ...(sess.data || {}) };
    const current = def.steps[step];
    if (!current) {
      clearSess(phone, sender);
      return null;
    }
    let value = msg;
    if (!current.required && /^(skip|none|n\/?a|-)$/i.test(msg)) value = 'skip';
    if (!current.validate(value)) {
      return '❌ Please try again.\n\n' + current.prompt;
    }
    if (current.transform) value = current.transform(value);
    data[current.key] = value;
    step += 1;
    if (step >= def.steps.length) {
      return finishFlow(sess.type, data, phone, sender);
    }
    setSess(phone, sender, { type: sess.type, step, data });
    return `(${step + 1}/${def.steps.length}) ` + def.steps[step].prompt;
  }

  function docsForPhone(phone) {
    const p = normalizePhone(phone);
    const invoices = Object.values(invoiceStatus || {})
      .filter((r) => r.client_phone === p)
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    let quotes = [];
    const prof = profile(p);
    if (prof?.owner_user_id && prof?.linked_client_id) {
      const ws = workspaces[prof.owner_user_id]?.data || {};
      quotes = (ws.quotes || []).filter((q) => String(q.clientId) === String(prof.linked_client_id));
    }
    return { invoices, quotes, profile: prof };
  }

  function requireReg(phone, sender) {
    if (isRegistered(phone)) return null;
    return startFlow('register', phone, sender, {});
  }

  function handleIntent(intent, phone, sender, message) {
    const sk = sessionKey(phone, sender);
    remember(sk, intent);

    if (intent === 'menu' || intent === 'empty') return menu(phone);
    if (intent === 'greeting') {
      return [
        isRegistered(phone) ? `Hey ${profile(phone).name}! 👋` : 'Hey! 👋 Welcome to *PC REPAIR DEX*.',
        '',
        'I can help with invoices, jobs, payments and more.',
        'Reply *menu* or just tell me what you need.',
      ].join('\n');
    }
    if (intent === 'thanks') {
      return 'You are welcome! 🙌\n\nReply *menu* anytime.';
    }
    if (intent === 'help') return menu(phone);
    if (intent === 'register' || intent === 'account') {
      if (isRegistered(phone) && intent === 'account') {
        const c = profile(phone);
        const { invoices } = docsForPhone(phone);
        const open = invoices.filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()));
        const ar = open.reduce((s, i) => s + (Number(i.balance_due ?? i.total) || 0), 0);
        return [
          '👤 *' + (c.name || 'Account') + '*',
          '📱 ' + phone,
          c.email ? '📧 ' + c.email : null,
          '',
          'Open invoices: ' + open.length,
          'Outstanding: *' + moneyR(ar) + '*',
          '',
          'Update profile? Reply *register*.',
          '0️⃣ Menu',
        ].filter((x) => x !== null).join('\n');
      }
      return startFlow('register', phone, sender, isRegistered(phone) ? { name: profile(phone)?.name } : {});
    }
    if (intent === 'job') {
      const pre = isRegistered(phone) ? { name: profile(phone)?.name } : {};
      return startFlow('job', phone, sender, pre);
    }
    if (intent === 'pop') return startFlow('pop', phone, sender, {});
    if (intent === 'feedback') return startFlow('feedback', phone, sender, {});
    if (intent === 'human') {
      // offer callback flow or instant ping
      pushNotification({
        type: 'inbox',
        title: 'Human requested',
        body: (profile(phone)?.name || phone || sender) + ': ' + String(message).slice(0, 80),
        payload: { phone, sender },
      });
      return [
        '🙋 *Team notified*',
        '',
        'Someone will reply on this chat.',
        'Prefer a phone call? Reply *callback*.',
        '',
        '0️⃣ Menu',
      ].join('\n');
    }
    if (/^callback$/i.test(String(message).trim()) || intent === 'callback') {
      return startFlow('callback', phone, sender, isRegistered(phone) ? { name: profile(phone)?.name, phone } : {});
    }

    if (FAQ[intent]) return FAQ[intent];

    if (intent === 'hours') {
      return [
        '📍 *PC REPAIR DEX*',
        '',
        'Mon–Fri 09:00–17:00',
        'Sat 09:00–13:00 (appointment)',
        'Sun closed',
        '',
        'Reply *7* for a callback.',
        '0️⃣ Menu',
      ].join('\n');
    }

    if (intent === 'invoices') {
      const gate = requireReg(phone, sender);
      if (gate) return gate;
      const { invoices } = docsForPhone(phone);
      if (!invoices.length) return '📄 No invoices linked yet.\n\nReply *5* if you need a repair.\n\n0️⃣ Menu';
      const lines = ['📄 *Your invoices*', ''];
      for (const inv of invoices.slice(0, 12)) {
        lines.push(`• *${inv.invoice_number}* · ${moneyR(inv.balance_due ?? inv.total)} · ${String(inv.status || '').toUpperCase()}`);
      }
      lines.push('', 'Send an invoice number for detail.', '0️⃣ Menu');
      return lines.join('\n');
    }

    if (intent === 'payment') {
      const gate = requireReg(phone, sender);
      if (gate) return gate;
      const { invoices } = docsForPhone(phone);
      const open = invoices.filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()));
      const ar = open.reduce((s, i) => s + (Number(i.balance_due ?? i.total) || 0), 0);
      const lines = ['💳 *Payment*', ''];
      if (open.length) {
        lines.push(`Outstanding: *${moneyR(ar)}*`, '');
        for (const inv of open.slice(0, 6)) lines.push(`• ${inv.invoice_number} — ${moneyR(inv.balance_due ?? inv.total)}`);
        lines.push('');
      } else lines.push('No open balance.', '');
      lines.push(...payBlurb(), '', 'Paid already? Reply *I paid*.', '0️⃣ Menu');
      return lines.join('\n');
    }

    if (intent === 'quotes') {
      const gate = requireReg(phone, sender);
      if (gate) return gate;
      const { quotes } = docsForPhone(phone);
      if (!quotes.length) return '📋 No quotes on file.\n\n0️⃣ Menu';
      const lines = ['📋 *Quotes*', '', 'ACCEPT QT-xxx · REJECT QT-xxx · DEPOSIT QT-xxx', ''];
      for (const q of quotes.slice(0, 10)) {
        lines.push(`• *${q.number || q.id}* · ${moneyR(q.total)}`);
      }
      lines.push('', '0️⃣ Menu');
      return lines.join('\n');
    }

    if (intent === 'statement') {
      const gate = requireReg(phone, sender);
      if (gate) return gate;
      const { invoices, profile: prof } = docsForPhone(phone);
      const open = invoices.filter((i) => ['unpaid', 'partial', 'overdue'].includes(String(i.status || '').toLowerCase()));
      const ar = open.reduce((s, i) => s + (Number(i.balance_due ?? i.total) || 0), 0);
      const lines = ['📑 *Statement*', '', '👤 ' + (prof?.name || 'Client'), `Outstanding: *${moneyR(ar)}*`, ''];
      if (!open.length) lines.push('Nothing outstanding.');
      else for (const inv of open.slice(0, 12)) lines.push(`• ${inv.invoice_number} · ${moneyR(inv.balance_due ?? inv.total)}`);
      lines.push('', '0️⃣ Menu');
      return lines.join('\n');
    }

    if (intent === 'invoice_lookup') {
      const m = String(message).match(/\b(INV[-\s]?\d{4}[-\s]?\d{1,6}|INV[-\s]?\d{1,6})\b/i);
      if (!m) return 'Send a full invoice number e.g. INV-2026-0001';
      let num = m[1].toUpperCase().replace(/\s+/g, '');
      if (/^INV\d+$/.test(num)) num = 'INV-' + num.slice(3);
      let matches = Object.values(invoiceStatus || {}).filter((r) => r.invoice_number === num);
      if (phone) {
        const locked = matches.filter((r) => r.client_phone === phone);
        if (locked.length) matches = locked;
        else if (matches.some((r) => r.client_phone)) return '🔒 That invoice is not on this WhatsApp number.';
      }
      const inv = matches[0];
      if (!inv) return '📄 Invoice not found.\n\n0️⃣ Menu';
      return [
        '📄 *' + inv.invoice_number + '*',
        '',
        '👤 ' + (inv.client_name || 'Client'),
        '💵 Total: ' + moneyR(inv.total),
        '💳 Balance: ' + moneyR(inv.balance_due),
        '📊 ' + String(inv.status || '').toUpperCase(),
        '',
        'Paid? Reply *I paid*.',
        '0️⃣ Menu',
      ].join('\n');
    }

    if (intent === 'quote_accept' || intent === 'quote_reject' || intent === 'quote_deposit') {
      const m = String(message).match(/\b(accept|reject|deposit)\s+([A-Za-z0-9\-]+)/i);
      if (!m) return 'Use: ACCEPT QT-2026-0001';
      const act = m[1].toLowerCase();
      const ref = m[2].toUpperCase();
      pushNotification({
        type: 'quote_action',
        title: 'Quote ' + act + ' ' + ref,
        body: (profile(phone)?.name || phone || '') + '',
        payload: { act, ref, phone },
      });
      if (act === 'accept') return '✅ Quote *' + ref + '* accepted. We will follow up.\n\n0️⃣ Menu';
      if (act === 'reject') return 'Noted — *' + ref + '* declined.\n\n0️⃣ Menu';
      return ['💰 Deposit for *' + ref + '*', '', ...payBlurb(), 'Ref: *DEP-' + ref + '*', '', '0️⃣ Menu'].join('\n');
    }

    if (intent === 'status') {
      const gate = requireReg(phone, sender);
      if (gate) return gate;
      return 'For live job status reply *7* (human) or send your job details.\nInvoice status: send the INV number.\n\n0️⃣ Menu';
    }

    // unknown — helpful fallback with memory hint
    const recent = (memory[sk]?.intents || []).map((x) => x.intent).slice(0, 3);
    return [
      'I am not sure I caught that 🤔',
      '',
      'Try:',
      '• *menu* — full options',
      '• *5* — new repair job',
      '• *2* — invoices',
      '• *I paid* — proof of payment',
      '• or type *price* / *warranty*',
      recent.length ? '\n_Recent: ' + recent.join(', ') + '_' : null,
    ].filter(Boolean).join('\n');\n  }

  /**
   * Main entry: returns reply string
   */
  function handleMessage(phone, sender, message) {
    // Active multi-step first
    const flowReply = processActiveFlow(phone, sender, message);
    if (flowReply) return flowReply;

    // Explicit callback keyword mid-chat
    if (/^callback$/i.test(String(message || '').trim())) {
      return startFlow('callback', phone, sender, isRegistered(phone) ? { name: profile(phone)?.name, phone } : {});
    }

    const { intent, confidence } = detectIntent(message);
    return handleIntent(intent, phone, sender, message);
  }

  return {
    handleMessage,
    detectIntent,
    menu,
    startFlow,
    FLOW_DEFS,
  };
}

module.exports = { createBrainEngine, detectIntent, FLOW_DEFS, FAQ, normalizePhone, moneyR };
