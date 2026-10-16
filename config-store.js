/**
 * Lab config & secrets store — editable in Admin Portal.
 * Public keys: GET /api/config/app (web + APK)
 * Secrets: admin only
 */
const path = require('path');

const PUBLIC_KEYS = [
  'google_client_id', 'app_version', 'min_app_version', 'feature_flags',
  'support_whatsapp', 'support_email', 'maintenance_message', 'theme_default',
  'document_types_enabled', 'oauth_enabled', 'update_channel', 'announcement',
];
const SECRET_KEYS = [
  'status_api_token', 'payfast_merchant_id', 'payfast_merchant_key', 'payfast_passphrase',
  'google_client_secret', 'smtp_host', 'smtp_user', 'smtp_pass', 'webhook_secret', 'ar_brain_key',
];

function defaultConfig() {
  return {
    public: {
      google_client_id: '',
      app_version: '5.0.0',
      min_app_version: '4.3.0',
      feature_flags: { oauth_google: true, pdfjs_preview: true, wa_import: true, reports_export: true },
      support_whatsapp: '',
      support_email: 'support@sainvoice.pro',
      maintenance_message: '',
      theme_default: 'brain',
      document_types_enabled: ['invoice','quote','statement','payslip','sla','nda','popia','job_card','tax_cover','receipt','delivery'],
      oauth_enabled: true,
      update_channel: 'stable',
      announcement: 'Lab v5.0 — professional document suite & live config.',
    },
    secrets: {
      status_api_token: '', payfast_merchant_id: '', payfast_merchant_key: '', payfast_passphrase: '',
      google_client_secret: '', smtp_host: '', smtp_user: '', smtp_pass: '', webhook_secret: '', ar_brain_key: '',
    },
    updated_at: null,
    updated_by: null,
  };
}

function createConfigStore(DATA_DIR, loadJson, saveJson) {
  const FILE = path.join(DATA_DIR, 'lab_config.json');
  let cfg = { ...defaultConfig(), ...loadJson(FILE, {}) };
  if (!cfg.public) cfg.public = defaultConfig().public;
  if (!cfg.secrets) cfg.secrets = defaultConfig().secrets;
  cfg.public = { ...defaultConfig().public, ...cfg.public };
  cfg.secrets = { ...defaultConfig().secrets, ...cfg.secrets };

  function persist() {
    cfg.updated_at = new Date().toISOString();
    saveJson(FILE, cfg);
  }

  function getPublic() {
    return { ok: true, config: { ...cfg.public }, version: cfg.public.app_version || '5.0.0', updated_at: cfg.updated_at };
  }

  function getAdminView() {
    const secrets = {};
    for (const [k, v] of Object.entries(cfg.secrets || {})) {
      const s = String(v || '');
      secrets[k] = s ? { set: true, preview: s.slice(0, 4) + '…' + s.slice(-2), length: s.length } : { set: false };
    }
    return { ok: true, public: cfg.public, secrets, secret_keys: SECRET_KEYS, public_keys: PUBLIC_KEYS, updated_at: cfg.updated_at, updated_by: cfg.updated_by };
  }

  function updatePublic(patch, by) {
    if (!patch || typeof patch !== 'object') throw new Error('public object required');
    for (const [k, v] of Object.entries(patch)) {
      if (PUBLIC_KEYS.includes(k) || k === 'feature_flags' || k === 'document_types_enabled') cfg.public[k] = v;
    }
    cfg.updated_by = by || null;
    persist();
    return getAdminView();
  }

  function updateSecrets(patch, by) {
    if (!patch || typeof patch !== 'object') throw new Error('secrets object required');
    for (const [k, v] of Object.entries(patch)) {
      if (!SECRET_KEYS.includes(k)) continue;
      if (v === '') cfg.secrets[k] = '';
      else if (v != null && String(v).length > 0) cfg.secrets[k] = String(v);
    }
    cfg.updated_by = by || null;
    persist();
    return getAdminView();
  }

  function getSecret(key) { return cfg.secrets?.[key] || ''; }

  return { getPublic, getAdminView, updatePublic, updateSecrets, getSecret, PUBLIC_KEYS, SECRET_KEYS };
}

module.exports = { createConfigStore, PUBLIC_KEYS, SECRET_KEYS, defaultConfig };
