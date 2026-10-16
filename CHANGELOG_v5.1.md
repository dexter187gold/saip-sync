# SA Invoice Pro Sync v5.1.0 — Pro Studio

Parity with **sa-invoice-pro v5.1.0**.

## Live config (mounted)

| Endpoint | Who | Purpose |
|----------|-----|--------|
| `GET /api/config/app` | Browser + APK | Public flags, Google Client ID, announcement |
| `GET /api/admin/config` | Admin JWT | Public + masked secrets |
| `PUT /api/admin/config/public` | Admin | Save public fields |
| `PUT /api/admin/config/secrets` | Admin | Save API tokens, PayFast, SMTP, webhooks |

## Changes in 5.1.0
- Config API mounted in `server.js` (createConfigStore + mountConfigApi)
- `/` and `/health` report **5.1.0 Pro Studio**
- Default `app_version` / `min_app_version` 5.1.0 / 5.0.0
- Expanded document_types_enabled list
- Announcement string for Pro Studio

## Operator
1. Render auto-deploys on push to main
2. Admin Lab → set Google Client ID (public) + secrets
3. Confirm `GET https://saip-sync.onrender.com/api/config/app`
