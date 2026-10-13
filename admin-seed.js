/**
 * Ensures a working admin account exists for /admin portal login.
 */
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_EMAIL = 'admin@sainvoice.pro';
const DEFAULT_PASSWORD = 'Admin@SAIP2026!';

function upsertAdmin(users, workspaces, persistUsers, persistWorkspaces, now, email, password, forceReset) {
  const key = String(email || '').toLowerCase().trim();
  if (!key) return null;
  const ts = now();
  let user = users[key];
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
    console.log('[admin] Seeded admin:', key);
    return { seeded: true, email: key };
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
    console.log('[admin] Force-reset password for', key);
  }
  if (changed) {
    persistUsers();
    console.log('[admin] Updated admin:', key);
  }
  return { seeded: false, email: key };
}

function ensureDefaultAdmin(opts) {
  const {
    users,
    persistUsers,
    workspaces,
    persistWorkspaces,
    now,
  } = opts;

  const password = String(opts.adminPassword || process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD);
  const forceReset =
    opts.forceReset === true ||
    String(process.env.ADMIN_FORCE_RESET || '').trim() === '1';

  const primary = upsertAdmin(
    users, workspaces, persistUsers, persistWorkspaces, now,
    DEFAULT_EMAIL, password, forceReset
  );

  const envEmail = String(opts.adminEmail || process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  if (envEmail && envEmail !== DEFAULT_EMAIL) {
    upsertAdmin(users, workspaces, persistUsers, persistWorkspaces, now, envEmail, password, forceReset);
  }

  return { ok: true, primary };
}

module.exports = { ensureDefaultAdmin, DEFAULT_EMAIL, DEFAULT_PASSWORD };
