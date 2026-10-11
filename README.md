# SA Invoice Pro – Sync Server v1.0.1

Multi-device workspace sync + public status API for AutoResponder.

**v1.0.1** – Switched to pure JSON file storage (no native modules). Works reliably on Render free tier.

## Quick start (local)

```bash
cp .env.example .env
# edit .env → set strong JWT_SECRET and STATUS_API_TOKEN
npm install
npm start
```

Server runs on `http://localhost:3847` by default.

## Deploy on Render

1. Create a new **Web Service** → connect this repo
2. **Runtime:** Node
3. **Build Command:** `npm install`
4. **Start Command:** `npm start`
5. Environment variables (required):

```
JWT_SECRET=your-long-random-secret-here
STATUS_API_TOKEN=your-status-token-for-autoresponder
```

Node version is pinned to **20.x** via `engines` and `.node-version`.

After deploy, copy the public URL (e.g. `https://saip-sync-xxxx.onrender.com`).

## API Overview

### Auth
- `POST /api/auth/register` `{ "email", "password", "name?" }`
- `POST /api/auth/login` `{ "email", "password" }` → JWT
- `GET  /api/auth/me` (Bearer token)

### Workspace (multi-device)
- `GET  /api/workspace` → pull full data
- `PUT  /api/workspace` `{ "data": { clients, invoices, tickets, settings } }`

### Status (for AutoResponder)
Require `?token=YOUR_STATUS_API_TOKEN`

- `GET /api/status/invoice?number=INV-0042&token=...`
- `GET /api/status/client?phone=27821234567&token=...`
- `POST /api/status/push` (authenticated) – push one or many invoice statuses

## Frontend integration

See `FRONTEND_INTEGRATION.md`.
