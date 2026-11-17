# Authentication Phase 1

Not deployed automatically. Back up Aiven before running the updated backend.

## Environment and lockout prevention

- Production requires SESSION_SECRET (or legacy JWT_SECRET), at least 32 random characters; never put it in VITE variables. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
- Preserve the current strong secret to preserve sessions. Replacing it invalidates existing sessions, not passwords.
- Set FRONTEND_URL to the exact production browser origin (no trailing slash) for account-management origin checks.
- Existing administrator hashes and stored PIN are not replaced. Confirm the authorized operator knows both before rollout. Rotate historical default credentials through a controlled operator procedure; this phase deliberately does not auto-rotate them and lock out the operator.
- For an empty database only: explicitly set ADMIN_USERNAME, ADMIN_PHONE, ADMIN_PASSWORD, ADMIN_PIN. No default password/PIN is provisioned.
- Production startup fails if migration fails. Deploy in a maintenance window and keep a rollback backup.

## Additive migration

Startup runs migrateAccountStatus after existing storage initialization. First add account_status with ACTIVE for existing rows, then change the default for future rows to PENDING. Add auth_version default 0. Reruns do not reactivate suspended/rejected users. No readings, users, logs or harvests are deleted.

## Access workflow

New registrations remain PENDING. Admin Users has a Pending Registrations filter, Approve/Reject, Suspend and Reactivate actions. PATCH /api/admin/users/:id/status requires admin authentication, trusted Origin and JSON. Status changes and audit insertion occur in one transaction. Farmer sessions are checked against current database role, status and version before existing API routers. Each status change invalidates prior farmer sessions permanently. Device API-key authentication remains separate.

## Remaining work

Phase 2 WebAuthn and three-device restrictions are not implemented. Existing plaintext PIN storage, shared admin/farmer cookie, legacy eight-hour sessions, login rate limiting and broader CSRF hardening remain follow-up risks. Default administrator credentials already stored are preserved for lockout prevention, not declared secure. Exactly-one-admin enforcement is not added in this phase. Browser and live Aiven/ESP32/SMS acceptance tests are required before production rollout; do not send real SMS in automated tests.
