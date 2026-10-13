# SA Invoice Pro – Sync Server v4.1.0

Cloud sync + WhatsApp **brain-engine v4.1** + realtime `wa_clients` store + admin portal + public status API.

## What’s new in 4.1.0

- Full **brain-engine** (no longer a placeholder) — REGISTER, menu, status, jobs, invoices
- **Real-time** writes to `data/wa_clients.json` so registration sticks immediately
- Unified SA phone normalisation (`082…` → `2782…`)
- `GET /api/wa/lookup?phone=…&token=…` for debug
- Job status outbox for AutoResponder (`/api/ar/outbox`, `/api/tickets/status`)
- Admin force-register, outbox queue, client lookup

## Admin portal login (default)

Open: `https://YOUR-HOST/admin`

| Field | Default |
|-------|---------|
| **Email** | `admin@sainvoice.pro` |
| **Password** | `Admin@SAIP2026!` |

Override with env `ADMIN_EMAIL` / `ADMIN_PASSWORD` on Render.

## WhatsApp registration (AutoResponder)

Point AR at `POST /api/ar` with status token. Clients can send:

```
REGISTER
Name: Full Name
Email: you@email.com
```

Or reply `1` for step-by-step. After success, `menu` should show **Profile active**.

Web form: `https://YOUR-HOST/forms/register`

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

**Note:** Free tier disk is ephemeral. Attach a persistent disk to `/opt/render/project/src/data` so WA clients survive redeploys.

## API overview

- Auth: `POST /api/auth/register` · `POST /api/auth/login`
- Admin UI: `GET /admin`
- Admin API: `/api/admin/*` (Bearer JWT)
- Workspace: `GET/PUT /api/workspace`
- WA pending: `GET /api/wa/pending` · mark imported `POST /api/wa/pending/:phone/imported`
- Tickets intake: `GET /api/tickets/intake`
- Job status push: `POST /api/tickets/status`
- AutoResponder brain: `POST /api/ar`
- Status invoice: `GET /api/status/invoice?number=…&token=…`
- WA lookup: `GET /api/wa/lookup?phone=…&token=…`

See `DOCUMENTATION.md` and `FRONTEND_INTEGRATION.md`.
