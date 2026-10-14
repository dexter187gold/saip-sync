# SA Invoice Pro – Sync Server v4.3.0

**Pinky & the Brain Lab** · cloud sync · WhatsApp brain-engine · realtime `wa_clients` · admin portal

> “The same thing we do every night, Pinky — try to take over the world!”

## Admin portal

Open: `https://YOUR-HOST/admin`

| Field | Default |
|-------|---------|
| **Email** | `admin@sainvoice.pro` |
| **Password** | `Admin@SAIP2026!` |

Case-sensitive. Override with `ADMIN_EMAIL` / `ADMIN_PASSWORD` on Render.

## v4.3 highlights

- Full **Brain Control Lab** admin UI (dashboard, WA, tickets, invoices, outbox, users, tools)
- Login cold-start wake + clearer errors
- Force-register, outbox queue, phone lookup
- Real-time `wa_clients.json` for registration that sticks
- Job status API for AutoResponder messages

## Quick start

```bash
cp .env.example .env
npm install
npm start
```

## Deploy (Render)

```
JWT_SECRET=long-random-secret
STATUS_API_TOKEN=your-autoresponder-token
ADMIN_EMAIL=admin@sainvoice.pro
ADMIN_PASSWORD=Admin@SAIP2026!
PUBLIC_BASE_URL=https://your-service.onrender.com
```

Attach a **persistent disk** to `/opt/render/project/src/data` so WA clients survive redeploys.

## API

- `POST /api/auth/login` · `GET /admin`
- `POST /api/ar` — AutoResponder brain
- `GET /api/wa/pending` · `POST /api/tickets/status`
- `GET /api/wa/lookup?phone=&token=`
- `GET /health`
