# SAIP Sync + SA Invoice Pro — v5.2.0 Pro Studio Q2

## Security (backend)
- Rate-limited login/register (12 / 15 min)
- CORS locked to SAIP hosts, localhost, Capacitor
- Security headers (nosniff, frame-options, referrer)
- Password policy: 8+ chars, letter + number
- Forgot-password no longer returns reset token in JSON
- JWT_SECRET default warns on boot
- Notifications scoped by owner_user_id
- Body size limits reduced (8mb / 1mb)

## Admin portal
- Clear default credentials box + Fill default password
- Secrets tab for live Google Client ID / announcement / status token
- Post-login verifies `/api/admin/me` before showing Lab

## Admin seed
- Canonical `admin@sainvoice.pro` password recoverable every deploy
- Default: `Admin@SAIP2026!`

## APK CI
- Hardened Gradle (compileSdk 34)
- Run #19 success → SA-Invoice-Pro-Lab-v5.2.0.apk
