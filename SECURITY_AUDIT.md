# SAIP Security Audit — v5.2.0 Pro Studio Q2

## Findings (pre-fix) → Mitigations

| # | Severity | Issue | Fix in 5.2 |
|---|----------|-------|------------|
| 1 | High | `forgot-password` returned `reset_url` with raw token | Generic response; token only logged server-side |
| 2 | High | Default `JWT_SECRET` if env missing | Console warn; set `JWT_SECRET` on Render |
| 3 | High | Hardcoded status API token in source | Prefer `STATUS_API_TOKEN` env; rotate via Admin Secrets |
| 4 | Medium | CORS `*` on all routes | Locked to SAIP / localhost / Capacitor origins |
| 5 | Medium | No login rate limit | 12 attempts / 15 min per IP+email |
| 6 | Medium | Weak password min 6 | Register/reset require 8+ with letter+number |
| 7 | Medium | 15mb JSON body (DoS) | Limit 8mb JSON / 1mb urlencoded |
| 8 | Low | `X-Powered-By: Express` | Removed |
| 9 | Low | Notifications not owner-scoped | Filter by `owner_user_id` |

## What is NOT a bypass

- Admin routes require JWT + admin role/email — live probe returns `Missing token`
- `/.env`, `/data/users.json` → 404
- Status endpoints require known status token

## Required env on Render

```
JWT_SECRET=<long random>
ADMIN_PASSWORD=Admin@SAIP2026!
ADMIN_EMAIL=pcrepairdex@gmail.com
STATUS_API_TOKEN=<rotate from default>
CORS_ORIGINS=https://your-frontend.example,http://localhost:5173
```

## Admin login (verified live)

- Email: `admin@sainvoice.pro`
- Password: `Admin@SAIP2026!` (case-sensitive, capital A)
