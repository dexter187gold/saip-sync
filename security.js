/**
 * SAIP security middleware — rate limit, headers, CORS lock, input guards
 * v5.2.0 Pro Studio Q2
 */
const crypto = require('crypto');

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 12;
const GLOBAL_WINDOW_MS = 60 * 1000;
const GLOBAL_MAX = 120;

const buckets = new Map();

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    b = { start: now, count: 0 };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count <= max;
}

function mountSecurity(app, opts = {}) {
  const allowedOrigins = String(opts.allowedOrigins || process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.removeHeader('X-Powered-By');
    next();
  });

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins.length) {
      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    } else if (origin) {
      const ok =
        /localhost(:\d+)?$/i.test(origin) ||
        /127\.0\.0\.1(:\d+)?$/i.test(origin) ||
        /sainvoice\.pro$/i.test(origin) ||
        /saip-sync\.onrender\.com$/i.test(origin) ||
        /capacitor:\/\//i.test(origin) ||
        /ionic:\/\//i.test(origin);
      if (ok) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Status-Token, X-Requested-With');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.use((req, res, next) => {
    const ip = clientIp(req);
    if (!rateLimit('g:' + ip, GLOBAL_MAX, GLOBAL_WINDOW_MS)) {
      return res.status(429).json({ error: 'Too many requests. Slow down.' });
    }
    next();
  });
}

function loginRateLimit(req, res, next) {
  const ip = clientIp(req);
  const email = String(req.body?.email || '').toLowerCase().trim();
  const key = 'login:' + ip + ':' + email;
  if (!rateLimit(key, LOGIN_MAX, LOGIN_WINDOW_MS)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }
  next();
}

function registerRateLimit(req, res, next) {
  const ip = clientIp(req);
  if (!rateLimit('reg:' + ip, 8, LOGIN_WINDOW_MS)) {
    return res.status(429).json({ error: 'Too many registrations from this IP.' });
  }
  next();
}

function strongPassword(pw) {
  const s = String(pw || '');
  if (s.length < 8) return { ok: false, error: 'Password must be at least 8 characters' };
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) {
    return { ok: false, error: 'Password must include letters and numbers' };
  }
  return { ok: true };
}

function safeEmail(email) {
  const e = String(email || '').toLowerCase().trim();
  if (!e || e.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

function timingSafeEqualStr(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) {
    try { crypto.timingSafeEqual(x, x); } catch {}
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

module.exports = {
  mountSecurity,
  loginRateLimit,
  registerRateLimit,
  strongPassword,
  safeEmail,
  clientIp,
  timingSafeEqualStr,
};
