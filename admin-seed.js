/**
 * Ensures a working admin account exists for /admin portal login.
 */
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_EMAIL = 'admin@sainvoice.pro';
const DEFAULT_PASSWORD = 'Admin@SAIP2026!';

/**
 * Create or promote the admin user. Call once at server startup.
 */
function ensureDefaultAdmin(opts) {
  const {
    users,
    persistUsers,
    workspaces,
    persistWorkspaces,
    now,
  } = opts;

  const key = String(opts.adminEmail || process.env.ADMIN_EMAIL || DEFAULT_EMAIL)
    .toLowerCase()
    .trim();
  const password = String(opts.adminPassword || process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD);
  const forceReset =
    opts.forceReset === true ||
    String(process.env.ADMIN_FORCE_RESET || '').trim() === '1';

  if (!key) return { ok: false, reason: 'no_email' };

  let user = users[key];
  const ts = now();

  if (!user) {
    const id = uuidv4();
    users[key] = {
      id,
      email: key,
      password_hash: bcrypt.hashSync(password, 10),
      name: 'Lab Director',
      role: 'admin',
      created_at: ts,
      updated_at: ts,
    };
    if (!workspaces[id]) {
      workspaces[id] = {
        data: { clients: [], invoices: [], tickets: [], settings: {} },
        version: 1,
        updated_at: ts,
      };
      persistWorkspaces();
    }
    persistUsers();
    console.log('[admin] Seeded default admin:', key);
    return { ok: true, seeded: true, email: key };
  }

  let changed = false;
  if (user.role !== 'admin') {
    user.role = 'admin';
    changed = true;
  }
  if (forceReset && password) {
    user.password_hash = bcrypt.hashSync(password, 10);
    user.updated_at = ts;
    changed = true;
    console.log('[admin] ADMIN_FORCE_RESET: password updated for', key);
  }
  if (changed) {
    persistUsers();
    console.log('[admin] Ensured admin role for', key);
  }
  return { ok: true, seeded: false, email: key, forced: forceReset };
}

module.exports = { ensureDefaultAdmin, DEFAULT_EMAIL, DEFAULT_PASSWORD };
