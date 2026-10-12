/**
 * Multi-step WhatsApp flows + online HTML forms
 * Registration & job cards — one field at a time, or full web form
 */
const path = require('path');
const { v4: uuidv4 } = require('uuid');

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).replace(/\D/g, '');
  if (!s) return null;
  if (s.startsWith('0') && s.length === 10) s = '27' + s.slice(1);
  if (s.startsWith('27') && s.length > 11) s = s.slice(0, 11);
  if (s.length < 9 || s.length > 15) return null;
  return s;
}

const REGISTER_STEPS = [
  { key: 'name', prompt: '👤 What is your *full name and surname*?', required: true, validate: (v) => v.length >= 2 },
  { key: 'phone', prompt: '📱 What is your *cellphone / WhatsApp number*?\n(e.g. 0821234567)', required: true, validate: (v) => !!normalizePhone(v) },
  { key: 'email', prompt: '📧 What is your *email address*?\n(or reply *skip*)', required: false, validate: (v) => v === 'skip' || /@/.test(v) },
  { key: 'company', prompt: '🏢 *Company name*?\n(or reply *skip*)', required: false, validate: () => true },
  { key: 'address', prompt: '📍 *Street address*?\n(or reply *skip*)', required: false, validate: () => true },
  { key: 'city', prompt: '🏙 *City / town*?\n(or reply *skip*)', required: false, validate: () => true },
];

const JOB_STEPS = [
  { key: 'name', prompt: '👤 *Your name* for this job card?', required: true, validate: (v) => v.length >= 2 },
  { key: 'device', prompt: '💻 What *device* is it?\n(e.g. HP laptop, desktop, printer)', required: true, validate: (v) => v.length >= 2 },
  { key: 'issue', prompt: '⚠️ Describe the *issue / fault*:', required: true, validate: (v) => v.length >= 3 },
  { key: 'urgency', prompt: '⏱ *Urgency*?\nReply: *normal* or *urgent*', required: true, validate: (v) => /^(normal|urgent|high|low)$/i.test(v) },
];

function mountFlows(app, ctx) {
  const {
    DATA_DIR,
    loadJson,
    saveJson,
    waClients,
    persistWaClients,
    ticketsIntake,
    persistTickets,
    pushNotification,
    now,
    PUBLIC_BASE,
  } = ctx;

  const SESSIONS_FILE = path.join(DATA_DIR, 'wa_sessions.json');
  let sessions = loadJson(SESSIONS_FILE, {});

  function persistSessions() {
    saveJson(SESSIONS_FILE, sessions);
  }

  function sessionKey(phone, sender) {
    if (phone) return 'p:' + phone;
    const s = String(sender || 'unknown').trim().toLowerCase().slice(0, 80);
    return 's:' + s;
  }

  function getSession(phone, sender) {
    const k = sessionKey(phone, sender);
    const sess = sessions[k];
    if (!sess) return null;
    // expire after 2 hours
    if (sess.updated_at && Date.now() - new Date(sess.updated_at).getTime() > 2 * 3600 * 1000) {
      delete sessions[k];
      persistSessions();
      return null;
    }
    return { key: k, ...sess };
  }

  function setSession(phone, sender, data) {
    const k = sessionKey(phone, sender);
    sessions[k] = { ...data, updated_at: now() };
    // If we learned phone mid-flow, also index under phone key
    if (data.data && data.data.phone) {
      const pk = 'p:' + normalizePhone(data.data.phone);
      if (pk !== k) sessions[pk] = sessions[k];
    }
    persistSessions();
    return k;
  }

  function clearSession(phone, sender) {
    const k = sessionKey(phone, sender);
    delete sessions[k];
    if (phone) delete sessions['p:' + phone];
    persistSessions();
  }

  function startRegister(phone, sender) {
    setSession(phone, sender, {
      type: 'register',
      step: 0,
      data: {},
    });
    const formUrl = PUBLIC_BASE + '/forms/register';
    return [
      '📝 *Client registration*',
      '',
      'We will ask a few questions one at a time.',
      'Reply *cancel* anytime to stop.',
      '',
      '🌐 Prefer a web form?',
      formUrl,
      '',
      REGISTER_STEPS[0].prompt,
    ].join('\n');
  }

  function startJob(phone, sender, prefillName) {
    setSession(phone, sender, {
      type: 'job',
      step: 0,
      data: prefillName ? { name: prefillName } : {},
    });
    // If name prefilled from profile, skip to device
    if (prefillName) {
      setSession(phone, sender, {
        type: 'job',
        step: 1,
        data: { name: prefillName },
      });
      const formUrl = PUBLIC_BASE + '/forms/job';
      return [
        '🛠 *New job card*',
        '',
        'One question at a time. Reply *cancel* to stop.',
        '',
        '🌐 Web form: ' + formUrl,
        '',
        'Name on file: *' + prefillName + '*',
        JOB_STEPS[1].prompt,
      ].join('\n');
    }
    const formUrl = PUBLIC_BASE + '/forms/job';
    return [
      '🛠 *New job card*',
      '',
      'One question at a time. Reply *cancel* to stop.',
      '',
      '🌐 Web form: ' + formUrl,
      '',
      JOB_STEPS[0].prompt,
    ].join('\n');
  }

  function completeRegister(data, phoneFromChat) {
    const phone = normalizePhone(data.phone) || phoneFromChat;
    if (!phone || !data.name) {
      return { ok: false, text: 'Registration incomplete. Reply *1* to try again.' };
    }
    const existing = waClients[phone];
    const isNew = !existing || !existing.registered;
    const email = data.email && data.email !== 'skip' ? data.email : null;
    const company = data.company && data.company !== 'skip' ? data.company : null;
    const address = data.address && data.address !== 'skip' ? data.address : null;
    const city = data.city && data.city !== 'skip' ? data.city : null;

    waClients[phone] = {
      id: existing?.id || uuidv4(),
      phone,
      name: data.name,
      email: email || existing?.email || null,
      company: company || existing?.company || null,
      address: address || existing?.address || null,
      city: city || existing?.city || null,
      source: 'whatsapp_step_form',
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
      title: isNew ? 'New WhatsApp client' : 'Client profile updated',
      body: `${data.name} (${phone})`,
      payload: waClients[phone],
    });
    return {
      ok: true,
      phone,
      text: [
        isNew ? '✅ *Profile created successfully!*' : '✅ *Profile updated*',
        '',
        '👤 ' + data.name,
        email ? '📧 ' + email : null,
        company ? '🏢 ' + company : null,
        address ? '📍 ' + address : null,
        city ? '🏙 ' + city : null,
        '📱 ' + phone,
        '',
        'You are now *registered*.',
        'Reply *menu* or *2* for invoices.',
      ].filter(Boolean).join('\n'),
    };
  }

  function completeJob(data, phone) {
    const ticket = {
      id: uuidv4(),
      source: 'whatsapp_step_form',
      customer_name: data.name || null,
      customer_phone: phone || null,
      device: data.device || null,
      issue: data.issue || null,
      urgency: String(data.urgency || 'normal').toLowerCase(),
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
      body: `${data.name || phone}: ${data.issue || data.device}`,
      payload: ticket,
    });
    return [
      '✅ *Job card created*',
      '',
      data.name ? '👤 ' + data.name : null,
      data.device ? '💻 ' + data.device : null,
      data.issue ? '⚠️ ' + data.issue : null,
      '⏱ ' + (data.urgency || 'normal'),
      phone ? '📱 ' + phone : null,
      '',
      'We will follow up on WhatsApp.',
      'Reply *menu* for more options.',
    ].filter(Boolean).join('\n');
  }

  /**
   * Process message if user is in an active multi-step flow.
   * Returns reply string or null if no active flow.
   */
  function processFlow(phone, sender, message) {
    const msg = String(message || '').trim();
    if (!msg) return null;

    const sess = getSession(phone, sender);
    if (!sess) return null;

    if (/^(cancel|stop|exit|quit|0|menu)$/i.test(msg)) {
      clearSession(phone, sender);
      return 'Cancelled. Reply *menu* for options.';
    }

    const steps = sess.type === 'register' ? REGISTER_STEPS : sess.type === 'job' ? JOB_STEPS : null;
    if (!steps) {
      clearSession(phone, sender);
      return null;
    }

    let step = sess.step || 0;
    const data = { ...(sess.data || {}) };
    const current = steps[step];
    if (!current) {
      clearSession(phone, sender);
      return null;
    }

    let value = msg;
    if (!current.required && /^(skip|none|n\/?a|-)$/i.test(msg)) {
      value = 'skip';
    }

    if (!current.validate(value)) {
      return '❌ That does not look right.\n\n' + current.prompt;
    }

    if (current.key === 'phone') {
      data.phone = normalizePhone(value);
    } else if (current.key === 'email') {
      data.email = value === 'skip' ? 'skip' : value.toLowerCase();
    } else if (current.key === 'urgency') {
      data.urgency = value.toLowerCase();
    } else {
      data[current.key] = value === 'skip' ? 'skip' : value;
    }

    step += 1;

    // Finished?
    if (step >= steps.length) {
      clearSession(phone, sender);
      if (sess.type === 'register') {
        const result = completeRegister(data, phone);
        return result.text;
      }
      return completeJob(data, phone || normalizePhone(data.phone));
    }

    setSession(phone, sender, { type: sess.type, step, data });
    const next = steps[step];
    const progress = `(${step + 1}/${steps.length})`;
    return progress + ' ' + next.prompt;
  }

  // ——— Online HTML forms ———
  function formShell(title, bodyInner) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} · PC REPAIR DEX</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --accent:#38bdf8; --text:#f1f5f9; --muted:#94a3b8; --ok:#4ade80; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); min-height:100vh; }
  .wrap { max-width: 480px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 1.35rem; margin: 0 0 4px; }
  p.sub { color: var(--muted); margin: 0 0 24px; font-size: 0.9rem; }
  .card { background: var(--card); border-radius: 16px; padding: 20px; box-shadow: 0 8px 32px rgba(0,0,0,.35); }
  label { display:block; font-size: 0.8rem; color: var(--muted); margin: 14px 0 6px; }
  input, textarea, select { width:100%; padding: 12px 14px; border-radius: 10px; border:1px solid #334155; background:#0f172a; color:var(--text); font-size:1rem; }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  button { margin-top: 20px; width:100%; padding: 14px; border:none; border-radius: 12px; background: linear-gradient(135deg,#0ea5e9,#6366f1); color:#fff; font-weight:600; font-size:1rem; cursor:pointer; }
  button:active { transform: scale(0.98); }
  .ok { color: var(--ok); text-align:center; padding: 24px 8px; }
  .err { color: #f87171; font-size: 0.9rem; margin-top: 8px; }
  .brand { font-size: 0.75rem; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 8px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">PC REPAIR DEX</div>
  ${bodyInner}
</div>
</body>
</html>`;
  }

  app.get('/forms/register', (req, res) => {
    res.type('html').send(formShell('Register', `
      <h1>Client registration</h1>
      <p class="sub">Fill in once — we will link this to your WhatsApp number.</p>
      <div class="card">
        <form method="POST" action="/api/forms/register">
          <label>Full name *</label>
          <input name="name" required placeholder="Name and surname" autocomplete="name"/>
          <label>Cellphone / WhatsApp *</label>
          <input name="phone" required placeholder="0821234567" inputmode="tel" autocomplete="tel"/>
          <label>Email</label>
          <input name="email" type="email" placeholder="you@email.com" autocomplete="email"/>
          <label>Company</label>
          <input name="company" placeholder="Optional"/>
          <label>Address</label>
          <input name="address" placeholder="Optional"/>
          <label>City</label>
          <input name="city" placeholder="Optional"/>
          <label>Notes</label>
          <textarea name="notes" rows="2" placeholder="Optional"></textarea>
          <button type="submit">Create profile</button>
        </form>
      </div>`));
  });

  app.post('/api/forms/register', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const phone = normalizePhone(b.phone);
    if (!name || name.length < 2 || !phone) {
      return res.type('html').status(400).send(formShell('Error', `<div class="card"><p class="err">Name and valid phone are required.</p><p><a href="/forms/register" style="color:#38bdf8">Try again</a></p></div>`));
    }
    const data = {
      name,
      phone,
      email: String(b.email || '').trim() || 'skip',
      company: String(b.company || '').trim() || 'skip',
      address: String(b.address || '').trim() || 'skip',
      city: String(b.city || '').trim() || 'skip',
    };
    const result = completeRegister(data, phone);
    res.type('html').send(formShell('Done', `<div class="card"><div class="ok">${result.text.replace(/\n/g, '<br/>')}</div><p class="sub" style="text-align:center">You can close this page and return to WhatsApp.</p></div>`));
  });

  app.get('/forms/job', (req, res) => {
    res.type('html').send(formShell('Job card', `
      <h1>New job card</h1>
      <p class="sub">Tell us about the device and issue.</p>
      <div class="card">
        <form method="POST" action="/api/forms/job">
          <label>Your name *</label>
          <input name="name" required placeholder="Full name"/>
          <label>WhatsApp number</label>
          <input name="phone" placeholder="0821234567" inputmode="tel"/>
          <label>Device *</label>
          <input name="device" required placeholder="e.g. HP laptop"/>
          <label>Issue *</label>
          <textarea name="issue" required rows="3" placeholder="What is wrong?"></textarea>
          <label>Urgency</label>
          <select name="urgency">
            <option value="normal">Normal</option>
            <option value="urgent">Urgent</option>
          </select>
          <button type="submit">Submit job card</button>
        </form>
      </div>`));
  });

  app.post('/api/forms/job', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const device = String(b.device || '').trim();
    const issue = String(b.issue || '').trim();
    if (!name || !device || !issue) {
      return res.type('html').status(400).send(formShell('Error', `<div class="card"><p class="err">Name, device and issue are required.</p><p><a href="/forms/job" style="color:#38bdf8">Try again</a></p></div>`));
    }
    const phone = normalizePhone(b.phone);
    const text = completeJob({
      name,
      device,
      issue,
      urgency: String(b.urgency || 'normal').toLowerCase(),
    }, phone);
    res.type('html').send(formShell('Done', `<div class="card"><div class="ok">${text.replace(/\n/g, '<br/>')}</div><p class="sub" style="text-align:center">Return to WhatsApp — we will follow up.</p></div>`));
  });

  return {
    processFlow,
    startRegister,
    startJob,
    clearSession,
    getSession,
  };
}

module.exports = { mountFlows };
