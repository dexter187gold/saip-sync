# SA Invoice Pro Sync — Security remediation status

## Fixed in the security hardening change
- The server refuses to start when `JWT_SECRET` is absent or shorter than 32 characters.
- Automatic administrator seeding is disabled unless `ADMIN_EMAIL` and `ADMIN_PASSWORD` are explicitly configured.
- Existing administrator password hashes are not overwritten during startup.
- Public forgot-password no longer creates or returns a recovery code.
- The legacy six-digit recovery endpoint is closed. The reset endpoint accepts only a private high-entropy token.
- Recovery responses are marked `Cache-Control: no-store`.

## Operational requirements before enabling self-service recovery
- Configure a transactional email provider with verified sender identity.
- Deliver high-entropy reset tokens privately; never include them in API responses or logs.
- Store only a hash of each reset token; enforce expiry, single use, rate limits and generic account-enumeration-resistant responses.
- Add tests for email delivery failure, expiry, replay, invalid tokens and user enumeration.

## Production deployment checklist
- Confirm `JWT_SECRET` is set to a unique random value of at least 32 characters in Render before deploying.
- Confirm `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set if a new administrator must be seeded. Existing administrator hashes remain unchanged.
- Do not rotate `JWT_SECRET` casually: doing so invalidates all outstanding sessions.
- Use the existing authenticated admin password-reset route for manual recovery until private email delivery is implemented.
- Keep PayFast inactive; Paystack is the active payment-provider roadmap.

## Data safety
This change does not modify user records, workspace records, invoices, payments, bank statements or Git-backed business data.
