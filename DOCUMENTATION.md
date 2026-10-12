# SA Invoice Pro · saip-sync — Full Documentation (AI Handoff)

**Last updated:** 2026-10-12  
**Live server:** https://saip-sync.onrender.com  
**Health:** `GET /health` (expect version ≥ 3.3.0)  
**GitHub (sync):** `dexter187gold/saip-sync`  
**App repo (client):** `dexter187gold/sa-invoice-pro` (offline-first PWA / Android stack)  
**Business site:** pc-repair-dex  
**Admin portal:** https://saip-sync.onrender.com/admin  
**AR brain:** `POST https://saip-sync.onrender.com/api/ar`

---

## 1. Mission & goals

### Primary goal
Run a **competitive SME stack** for PC REPAIR DEX:
- Invoicing, quotes, job cards, clients, payments (SA Invoice Pro app)
- Multi-device cloud sync (bypass pure offline-first isolation)
- WhatsApp AutoResponder as a **professional client chatbot** with live status
- Phone-locked client data (no document mixing)
- Admin control for password reset, deletes, tickets, WA clients

### Success criteria (owner intent)
- Surpass competitor WhatsApp + invoice bots
- Clients self-serve: register, invoices, pay info, jobs, statements
- Business gets notifications, intake tickets, reminders, portal links
- Works today on **unofficial AR** path; dual-ready for Meta Cloud API later

---

## 2. Architecture

```
┌─────────────────────┐     JWT / workspace JSON      ┌──────────────────────┐
│  SA Invoice Pro App │◄────────────────────────────►│  saip-sync (Render)  │
│  IndexedDB offline  │     auto-push on save         │  JSON file storage   │
│  Android + Desktop  │                               │  Node / Express      │
└─────────────────────┘                               └──────────┬───────────┘
                                                                 │
                    POST /api/ar  { query: { sender, message } }  │
                    ← { replies: [{ message }] }                 │
┌─────────────────────┐                                          │
│ AutoResponder WA    │◄─────────────────────────────────────────┘
│ Expert · web server │
└─────────────────────┘
```

### Storage
- **App:** IndexedDB (offline-first)
- **Server:** JSON files under `data/` on Render disk (users, workspaces, invoice_status, wa_clients, tickets_intake, notifications, sessions, etc.)
- **Not** SQLite (Render native module issues on Node 26 → pure JSON)

### Auth tokens
| Token | Use |
|-------|-----|
| `JWT_SECRET` | App/cloud user JWT (login, workspace, admin) |
| `STATUS_API_TOKEN` | AutoResponder / public status (`SaIpStAtUs_7f3a9c2e1b8d4f6a0e5c9b3d7a1f4e8`) |
| `ADMIN_EMAIL` | Only this cloud user may open `/admin` |

---

## 3. Coding stack

### saip-sync (this repo)
- **Runtime:** Node.js 20 (see `.node-version` if present)
- **Framework:** Express
- **Auth:** bcryptjs, jsonwebtoken
- **IDs:** uuid
- **Config:** dotenv
- **Hosting:** Render free/web service
- **Modules:**
  - `server.js` — bootstrap, auth, workspace, status push
  - `ar-brain.js` — HTTP adapter for AutoResponder
  - `brain-engine.js` — intents, multi-step flows, FAQ, memory
  - `flows.js` — online HTML forms `/forms/register`, `/forms/job`
  - `quarters.js` — Q2–Q4 (pay config, reminders, inbox, quote actions)
  - `quarters-late.js` — Q5–Q10 (inventory, SLA, analytics, Cloud API stubs, audit, backup)
  - `admin.js` — SME admin portal UI + APIs
  - `portal.js` — client portal tokens / HTML view
  - `wa-flow.js` — legacy WA text endpoints

### SA Invoice Pro app (separate repo)
- Stack-style WBA (web-based Android) + desktop
- Local-first IndexedDB
- Cloud sync client → `PUT /api/workspace`, status push
- Features evolved: SLA hours, client categories, reminders, statement PDF, auto-push, portal buttons, etc.

### WhatsApp path
- **Current:** AutoResponder (unofficial) → `Connect your web server` → `POST /api/ar`
- **Contract:** Request body includes `query.sender`, `query.message`; response `{ replies: [{ message: "..." }] }`
- **Auth:** Basic Auth password **or** header `X-Status-Token` = status token
- **Future:** Meta Cloud API dual-mode stubs under `/api/cloud-api/*`

---

## 4. AutoResponder setup (canonical)

1. Rule: received messages (or `.*`)
2. Action: **Connect your web server**
3. URL: `https://saip-sync.onrender.com/api/ar`
4. Method: POST JSON
5. Basic Auth password (or custom header): `SaIpStAtUs_7f3a9c2e1b8d4f6a0e5c9b3d7a1f4e8`
6. Expect AR to send sender + message; brain extracts phone when possible

### Phone detection limitation
AR often sends **contact name only**. Registration flow therefore **asks for Phone** step-by-step or via online form.

### Client UX modes
1. **Step-by-step chat** (recommended): reply `1` or `5`
2. **Online forms:** `/forms/register`, `/forms/job`
3. **Bulk paste** still works if message looks like `REGISTER` + `Name:` fields

### Natural language (brain-engine)
Examples: `price`, `warranty`, `I paid`, `feedback`, `callback`, `repair`, invoice numbers, `ACCEPT QT-…`

---

## 5. Key API surface

### Public / status
- `GET /health`
- `GET /api/ar` — brain metadata
- `POST /api/ar` — AutoResponder webhook
- `GET /api/status/invoice?number=&token=`
- `GET /api/status/verify?token=`
- `GET /forms/register`, `POST /api/forms/register`
- `GET /forms/job`, `POST /api/forms/job`
- `GET /admin` — admin HTML portal

### Authenticated (Bearer JWT)
- `POST /api/auth/register|login`
- `GET /api/auth/me`
- `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`
- `GET|PUT /api/workspace`
- `POST /api/status/push`
- Admin: `/api/admin/*` (stats, users reset/delete, WA clients, tickets, notifications)

### Quarters extras
- Pay config, overdue reminders, agent inbox, quote actions
- Inventory low-stock, SLA escalate, analytics, ops status
- Cloud API webhook stubs, audit log, backup export

---

## 6. Feature history (quarters program)

| Q | Theme | Status |
|---|--------|--------|
| Q1 | AR brain, identity/menu, registration gate | Done |
| Q2 | Banking/pay config, overdue reminders | Done |
| Q3 | Multi-agent inbox / human handoff | Done |
| Q4 | Quote accept / reject / deposit on WA | Done |
| Q5 | Inventory low-stock alerts | Done (API) |
| Q6 | SLA escalation | Done (API) |
| Q7 | Analytics summary | Done (API) |
| Q8 | Ops status | Done |
| Q9 | Meta Cloud API dual stubs | Done (stub) |
| Q10 | Audit + backup + rate guard | Done |

### Additional shipped
- Phone-locked invoices
- Multi-step register/job/POP/feedback/callback
- Intent classifier + FAQ
- Online forms
- Admin portal (reset password, delete user, tickets, WA clients)
- Client portal module (`portal.js`)
- Intent: stretch Gemini/AR hybrid (see §8)

---

## 7. App-side expectations (sa-invoice-pro)

When continuing app work, prefer:
- Debounced **auto-push** workspace + invoice status to saip-sync on save
- Client fields: phone normalized SA (`27…`), SLA hours cap, categories (SLA/COD)
- Statement PDF + caption share
- Cloud settings UI: server URL, login, push
- Notifications poll → bubble for new WA clients / tickets
- Portal link generation per client

---

## 8. Gemini / LLM rate limits — how to stretch to month end

### Reality
Gemini free/paid tiers **cap requests per day or per minute**. AutoResponder + saip-sync **do not consume Gemini quota** for rule/intent replies.

### Strategy: hybrid brain (recommended)

| Layer | Handles | Gemini used? |
|-------|---------|----------------|
| **A. Local brain-engine** (current) | Menu, register, job, invoices, pay, FAQ keywords, POP, callback | **No** |
| **B. Gemini** (optional later) | Only free-text the local brain marks `unknown` with low confidence | **Yes** |
| **C. Human** | Escalation `7` / callback | No |

**Effect:** 80–95% of WhatsApp traffic stays on saip-sync → Gemini quota lasts the month.

### Efficiency rules if you add Gemini later
1. **Gate:** Call Gemini only if `intent === 'unknown'` AND message length > 12.
2. **Cache:** Hash normalized message → store reply 24h (same question = 0 quota).
3. **Short system prompt:** Business facts only; forbid inventing invoice balances (must call status APIs).
4. **Daily budget:** e.g. max 50 Gemini calls/day; after that fallback to menu + human.
5. **Batch admin work:** Use Gemini in Cursor/chat for *coding*, not for every WA ping.
6. **Split roles:**
   - Grok/Cursor: architecture, repo edits, debugging
   - Gemini: occasional copy, one-off analysis, rare unknown WA messages
   - AR brain: all structured flows 24/7

### What you achieve with this split
- Clients always get **instant structured answers** (invoices, jobs, pay) even when Gemini is capped
- Gemini reserved for **edge cases** and **dev assistance**
- Predictable cost/limits until monthly reset
- No dependency on Gemini for revenue-critical paths

### Do **not**
- Route every AR message through Gemini (burns quota in hours)
- Let Gemini invent balances without `/api/status` or workspace data

---

## 9. Roadmap (soon / next)

### Near term
1. Confirm admin portal + multi-step AR in production
2. App: ensure workspace auto-push so invoice/quote data is non-empty on server
3. Set full banking via `PUT /api/pay/config` or admin extension
4. Import pending WA clients into app client list (notifications → one-tap)
5. Optional: Gemini gateway endpoint `POST /api/ar/llm` with daily budget + cache

### Medium
- Official WhatsApp Cloud API when WABA approved (dual-mode already stubbed)
- Richer admin: pay config UI, bulk reminders, promote admin role
- Tasker automation for overdue push
- Play Store listing guidance for the Android wrapper

### Later
- True LLM tool-calling against status/workspace APIs
- Persistent Postgres if JSON file limits are hit
- Multi-tenant SaaS (currently single-business oriented)

---

## 10. Operator runbook

### Deploy
Push to `main` on `saip-sync` → Render auto-deploy.

### Verify
```bash
curl https://saip-sync.onrender.com/health
curl https://saip-sync.onrender.com/api/ar
```

### Admin
Open `/admin` → login as `ADMIN_EMAIL` cloud user.

### AR test
Send on WhatsApp Business (rule active):
- `menu`
- `1` → step register
- `5` → step job
- `price`

### Env (Render)
```
PORT=3847
JWT_SECRET=<long random>
STATUS_API_TOKEN=SaIpStAtUs_7f3a9c2e1b8d4f6a0e5c9b3d7a1f4e8
ADMIN_EMAIL=pcrepairdex@gmail.com
PUBLIC_BASE_URL=https://saip-sync.onrender.com
```

---

## 11. Instructions for another AI

When continuing this project:

1. **Read this file first**, then `server.js` mounts, then `brain-engine.js` / `admin.js`.
2. **Prefer surgical pushes** to `dexter187gold/saip-sync` `main`.
3. **Never break** `POST /api/ar` response shape `{ replies: [{ message }] }`.
4. **Phone isolation:** invoice/status lookups must respect `client_phone` when present.
5. **Do not** reintroduce native sqlite on Render without a clear Node version pin + build strategy.
6. App changes go to `sa-invoice-pro`; sync contract is workspace JSON + status push.
7. Owner wants **working, testable features**, not placeholder lists of 200 items.
8. WhatsApp path stays AR-first until owner enables official Cloud API.
9. For Gemini: implement only behind budget gate + cache; default traffic stays on brain-engine.
10. Admin destructive actions must keep primary `ADMIN_EMAIL` protected.

---

## 12. Known gaps / risks

- Render free tier cold starts + ephemeral disk (JSON can reset on some host moves — export backups via `/api/backup/export`)
- AR sender without phone → must collect Phone in flow
- Workspace empty until app syncs → invoices/quotes on WA stay empty
- Meta Cloud API is stub only until WABA + token
- Unofficial WhatsApp tools risk ToS/ban; official API is the long-term path

---

## 13. Glossary

| Term | Meaning |
|------|--------|
| AR | AutoResponder for WhatsApp |
| SAIP | SA Invoice Pro |
| saip-sync | Cloud sync + bot backend |
| brain-engine | Intent + multi-step conversation core |
| POP | Proof of payment |
| WABA | WhatsApp Business Account (Meta) |

---

*This document is the handoff source of truth for product intent, architecture, and next steps.*
