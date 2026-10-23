# SAIP Sync — Git-durable cloud backend

Express server for **SA Invoice Pro** auth + workspace snapshots.

## Why Git?

Render free tier **wipes the local disk** on every restart/redeploy.  
This server keeps `data/*.json` in a **private GitHub repo** so:

1. **On boot** → `git pull` restores users + workspaces  
2. **On every save** → debounced `git commit` + `git push`  
3. **App every 5 min** → push/pull workspace via API (normal path)

```
App (IndexedDB)  ←→  saip-sync (Render)  ←→  private Git repo
     ↑ 5 min                 ↑ boot pull / save push
```

## Render setup

1. Create a **private** repo e.g. `saip-sync-data` (empty is fine).
2. Create a GitHub **fine-grained PAT** with Contents Read+Write on that repo only.
3. Deploy this folder to Render (Web Service, Node).
4. Set env vars:

| Variable | Example |
|----------|---------|
| `JWT_SECRET` | long random string |
| `GIT_DATA_ENABLED` | `true` |
| `GIT_DATA_REPO` | `https://github.com/YOU/saip-sync-data.git` |
| `GIT_DATA_TOKEN` | `github_pat_…` |
| `GIT_DATA_BRANCH` | `main` |
| `ADMIN_EMAIL` | your login email |

5. Redeploy. Check `/health` — `git.enabled` should be `true`.

## Local

```bash
cp .env.example .env
# fill GIT_* and JWT_SECRET
npm install
npm start
```

## API (used by the SPA)

- `POST /api/auth/register` `{ email, password, name }`
- `POST /api/auth/login` `{ email, password }`
- `POST /api/auth/forgot-password` `{ email }` → `{ recovery_code }`
- `POST /api/auth/reset-password` `{ email, code, password }`
- `GET  /api/workspace` (Bearer) — pull snapshot
- `PUT  /api/workspace` (Bearer) `{ data }` — push snapshot
- `GET  /health` — version + git status

## Security

- Keep `saip-sync-data` **private** — it holds bcrypt password hashes and business data.
- Rotate the PAT if leaked.
- Do not commit `.env` or real tokens.
