# Changelog

## 4.3.0 — Pinky & the Brain Lab (2026-10-14)

### Server
- Health + root API report **4.3.0**
- Codename: World Domination Mega Pack · Pinky & the Brain
- Features: admin_portal_v4.3, brain_engine_v4.3, realtime_wa_clients

### Admin portal
- Brain Control Lab **v4.3** UI (dashboard, WA, tickets, invoices, outbox, users, tools)
- Login: cold-start wake, password hint, clearer errors
- Force-register, outbox queue, phone lookup

### Brain / WA (4.1+)
- Full brain-engine (REGISTER sticks)
- Real-time `wa_clients.json` persist
- Job status + outbox for AutoResponder

### Admin login
| Email | Password |
|-------|----------|
| admin@sainvoice.pro | Admin@SAIP2026! |

### Deploy note
Attach a persistent disk to `data/` on Render so WA clients survive redeploys.
