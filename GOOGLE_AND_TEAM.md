# Google sign-in + Team workspace (Render)

## Why Render (not GitHub)
OAuth callback hits the live API. Secrets belong on **Render Environment**, not only GitHub Actions.

## Google Cloud Console
1. OAuth client ID → **Web application**
2. Redirect URI: `https://saip-sync.onrender.com/api/auth/google/callback`
3. Origins: `https://saip-sync.onrender.com` and your app workers.dev URL

## Render env
```
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=****
PUBLIC_BASE_URL=https://saip-sync.onrender.com
APP_PUBLIC_URL=https://sa-invoice-pro.pcrepairdex.workers.dev
JWT_SECRET=<long random>
ADMIN_PASSWORD=<strong>
```

Check: `GET /api/auth/google/status` → `enabled: true`

## Team
Owner: Team → Create invite code. Member: sign in → Join code → shared workspace pull.
