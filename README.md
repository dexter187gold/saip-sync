# SA Invoice Pro – Sync Server v4.0.0

Cloud sync + WhatsApp brain + **admin portal** + public status API.

## Admin portal login (default)

Open: `https://YOUR-HOST/admin`

| Field | Default |
|-------|---------|
| **Email** | `admin@sainvoice.pro` |
| **Password** | `Admin@SAIP2026!` |

These are created automatically on first server start if missing.  
Override with env vars `ADMIN_EMAIL` and `ADMIN_PASSWORD` on Render.

To force a password reset after deploy, set:

```
ADMIN_FORCE_RESET=1
ADMIN_PASSWORD=YourNewPassword
```

…restart once, then remove `ADMIN_FORCE_RESET`.

## Quick start (local)

```bash
cp .env.example .env
npm install
npm start
```

Server: `http://localhost:3847` · Admin: `http://localhost:3847/admin`

## Deploy on Render

1. Web Service → this repo  
2. Build: `npm install` · Start: `npm start`  
3. Env:

```
JWT_SECRET=long-random-secret
STATUS_API_TOKEN=your-autoresponder-token
ADMIN_EMAIL=admin@sainvoice.pro
ADMIN_PASSWORD=Admin@SAIP2026!
PUBLIC_BASE_URL=https://your-service.onrender.com
```

## API overview

- Auth: `POST /api/auth/register` · `POST /api/auth/login`
- Admin UI: `GET /admin`
- Admin API: `/api/admin/*` (Bearer JWT, role admin)
- Workspace: `GET/PUT /api/workspace`
- Status (AutoResponder): `GET /api/status/invoice?number=…&token=…`

See `DOCUMENTATION.md` and `FRONTEND_INTEGRATION.md`.
