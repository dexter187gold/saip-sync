# SA Invoice Pro Sync v5.0.0 — Professional Lab

Parity release with **sa-invoice-pro v5.0.0** (web + APK).

## Live config (this is the rollout control plane)

| Endpoint | Who | Purpose |
|----------|-----|--------|
| `GET /api/config/app` | Browser + APK | Public flags, Google Client ID, announcement, document types |
| `GET /api/admin/config` | Admin JWT | Public + masked secrets |
| `PUT /api/admin/config/public` | Admin | Save public fields |
| `PUT /api/admin/config/secrets` | Admin | Save API tokens, PayFast, SMTP, webhooks |

## Wire-up (one-time in admin.js)

Before the final `console.log('[admin] portal...')` inside `mountAdmin`:

```js
  try {
    const { createConfigStore } = require('./config-store');
    const { mountConfigApi } = require('./config-api');
    const configStore = createConfigStore(DATA_DIR, loadJson, saveJson);
    ctx.configStore = configStore;
    mountConfigApi(app, { configStore, adminAuth });
  } catch (e) {
    console.error('[admin] config API mount failed', e.message);
  }
```

Bump `server.js` `/` and `/health` version strings to `5.0.0`.

## Operator checklist
1. Deploy this repo to Render
2. Login admin portal
3. Set Google Client ID (public) + status API token (secret)
4. Rebuild/redeploy sa-invoice-pro 5.0.0 — apps fetch `/api/config/app` on launch
