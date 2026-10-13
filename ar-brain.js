/**
 * AutoResponder brain v3.1
 * Phone extraction hardened — SA numbers always map to registered clients
 */
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

function extractPhoneFromSender(sender) {
  if (!sender) return null;
  const s = String(sender);
  const cleaned = s.replace(/@.*$/, '').replace(/^whatsapp:/i, '');
  const matches = cleaned.match(/(\+?\d[\d\s\-]{7,}\d)/g);
  if (matches && matches.length) return normalizePhone(matches[matches.length - 1]);
  return normalizePhone(cleaned);
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

function mountArBrain(app, ctx) {
  const {
    ALLOWED_STATUS_TOKENS,
    DEFAULT_STATUS_TOKEN,
    brain,
    PUBLIC_BASE,
    now,
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

  app.post('/api/ar', (req, res) => {
    if (!checkArAuth(req)) {
      return res.status(403).json(reply('⚠️ Unauthorized. Check Basic Auth / X-Status-Token.'));
    }
    const data = req.body || {};
    const q = data.query || {};
    const message = q.message || data.message || '';
    const sender = q.sender || data.sender || '';
    const phone = extractPhoneFromBody(data, req);

    lastDebug = {
      at: (now && now()) || new Date().toISOString(),
      sender,
      messagePreview: String(message).slice(0, 200),
      phoneResolved: phone,
      intent: brain && brain.detectIntent ? brain.detectIntent(message) : null,
    };

    try {
      if (!brain || typeof brain.handleMessage !== 'function') {
        return res.status(200).json(reply('Brain not loaded. Reply *menu*.'));
      }
      if (!phone) {
        return res.status(200).json(reply([
          '⚠️ Could not read your WhatsApp number.',
          '',
          'In AutoResponder, pass the sender as %fromnumber% (or contact id with country code).',
          'Then reply *menu* again.',
        ].join('\n')));
      }
      const text = brain.handleMessage(phone, sender, message);
      return res.status(200).json(reply(text));
    } catch (e) {
      console.error('ar-brain', e);
      return res.status(200).json(reply('Temporary error. Reply *menu*.'));
    }
  });

  app.get('/api/ar', (req, res) => {
    res.json({
      ok: true,
      name: 'SAIP AutoResponder Brain',
      version: '3.1.0',
      engine: 'brain-engine',
      features: [
        'intent_classifier',
        'multi_step_register_job_pop_feedback_callback',
        'faq_price_warranty_data_pickup',
        'short_term_memory',
        'natural_language_routing',
        'online_forms',
        'robust_sa_phone_match',
      ],
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
