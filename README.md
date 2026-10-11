# SA Invoice Pro – Sync Server

Multi-device workspace sync + public status API for AutoResponder.

## Quick start (local)

```bash
cp .env.example .env
# edit .env → set strong JWT_SECRET and STATUS_API_TOKEN
npm install
npm start
```

Server runs on `http://localhost:3847` by default.

## Deploy (Render – recommended)

1. Create a new **Web Service** on Render
2. Connect this repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables:
   - `JWT_SECRET` → long random string
   - `STATUS_API_TOKEN` → long random string (give this to AutoResponder)
   - `PORT` → leave default (Render sets it)

## API Overview

### Auth
- `POST /api/auth/register` `{ email, password, name? }`
- `POST /api/auth/login` `{ email, password }` → returns JWT
- `GET  /api/auth/me` (Bearer token)

### Workspace (multi-device)
- `GET  /api/workspace` → pull full data
- `PUT  /api/workspace` `{ data: { clients, invoices, tickets, settings } }`

### Status (for AutoResponder)
All status endpoints require `?token=YOUR_STATUS_API_TOKEN`

- `GET /api/status/invoice?number=INV-0042&token=...`
- `GET /api/status/client?phone=27821234567&token=...`
- `POST /api/status/push` (authenticated) – push one or many invoice statuses

## Frontend integration

See `FRONTEND_INTEGRATION.md` for the exact changes needed in sa-invoice-pro.
