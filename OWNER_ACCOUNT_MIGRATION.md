# Administrator-provisioned owners: local implementation

## Production hold and backup gate

The owner exported the Aiven database on 2026-11-18. The export was restored to a new isolated local test database: all 27 tables and their row counts matched the dump, and 23 foreign-key relationships were checked without orphaned records. Original backup contents and live databases were not modified by restoration. The local engine is MariaDB 10.4, not the production MySQL 8.4 engine; the test import omitted GTID/session logging commands and adjusted table collations only. Do not put exports or credentials in Git. Production deployment is authorized separately by the owner.

## Behavior

Public registration is retired (HTTP 410). Private APIs require an active server-verified owner session and one valid assigned fishpen. Previously public monitoring is no longer accessible anonymously. ESP32 uploads keep their existing device-key authentication. Administrator login and staged WebAuthn remain separate and unchanged.

Admin Users creates an owner and one fishpen atomically. A random temporary password appears once, expires after 24 hours, and is stored only as bcrypt. Deliver it privately, never in ordinary SMS alerts. The owner must change it before accessing private features. Resetting a password or suspending an owner revokes old cookies through auth_version. Reset does not reactivate suspended accounts. Existing passwords and records are preserved.

## Additive migration

Startup runs server/migrations/provisionedOwners.ts after existing migrations. It adds these users columns, tolerating already-present columns:

```sql
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN temporary_password_expires_at DATETIME NULL;
ALTER TABLE users ADD COLUMN password_changed_at DATETIME NULL;
```

Existing owners are not forced to change passwords automatically. Existing PENDING/REJECTED/SUSPENDED accounts are not silently activated. An administrator can reactivate an account after assigning its valid fishpen. The pre-existing owner_fishpen_assignments migration only backfills owners with exactly one unambiguous fishpen; ambiguous or missing assignments must be resolved in Admin Settings. No historical rows are deleted or reassigned by this feature.

## Environment and local preview

- Keep the existing strong SESSION_SECRET stable; production must not use a fallback or frontend-exposed secret.
- Set FRONTEND_URL to the exact browser origin. Set WEBAUTHN_ORIGIN and WEBAUTHN_RP_ID to the correct deployment domain; preserve enrolled administrator credentials and bootstrap configuration.
- Use Node 22 or newer, existing Render backend/Vercel proxy settings, and Aiven MySQL connection variables. No new authentication secret is required.
- For local work use a disposable restored database, FRONTEND_URL=http://localhost:5173 and existing local WebAuthn settings. The ignored .env.local API target now points to http://127.0.0.1:5000 instead of production. Restart Vite after changing it.
- Disable real SMS credentials and scheduled SMS in the disposable environment before starting the API. Run npm run dev only after checking the database target. npm run dev:web previews the frontend alone; login needs the local API.

## Verification performed

Release verification: 42 selected unit/HTTP tests passed, plus the opt-in restored-database integration test in server/provisionedOwners.integration.test.ts. The integration test applied the additive migration twice, preserved existing user hashes/statuses and historical table counts, provisioned two separate owners/fishpens, exercised forced password changes, duplicate-phone rejection, suspension/session revocation, and password reset. Test fixtures remain only in the disposable restored database. No real SMS was sent. Production build passed with the existing bundle-size warning.

41 tests passed covering additive migrations, administrator WebAuthn guards, owner provisioning, forced password change, reset, expiration, session revocation, assignment isolation, SMS rules, manual validation, harvest arithmetic and DSS behavior. Provisioning SQL is mocked, not a real MySQL restore test. Build passed. Mocked browser checks at 320, 390 and 1280 pixels cover anonymous login-only UI, required password changes and missing assignments without horizontal overflow. Screenshots: outputs/owner-access-320.png, outputs/owner-access-390.png, outputs/owner-access-1280.png. Browser tests never contact production APIs or send SMS.

## Deployment checklist

1. Verify the backup and disposable restore described above.
2. Run migrations against the restored database; compare record counts and inspect assignments. Confirm the existing authorized admin can still log in and pass its current WebAuthn stage.
3. Test two real owner fixtures for cross-owner denial, all private routes, new/reset temporary passwords, suspension/reactivation, harvest history and device uploads. Confirm rejected device keys remain rejected.
4. Test actual MySQL transactions, duplicate-phone rollback and temporary-password timestamps. Mock SQL does not prove these properties on Aiven.
5. Check production environment values, proxy cookies, HTTPS, same-origin routing and database migration permissions. Existing DB SSL configuration disables certificate verification when enabled; harden separately with the provider CA before claiming full certificate validation.
6. Deploy backend and frontend in a coordinated maintenance window after explicit approval. Additive columns can remain if application code is rolled back, but rollback to old code restores its old public registration behavior.
7. Smoke-test admin access first, then owner login/password change, isolation, charts/history, harvest, SMS settings and live ESP32 uploads. Never test real SMS without explicit approval and a controlled recipient.

## Remaining limitations

The earlier local-only notes below describe the initial implementation stage. The backup restore and real-SQL lifecycle tests above have since passed. Production MySQL 8.4, real SMS delivery, hardware uploads and physical authenticators still require production smoke checks. Unknown-account and wrong-password messages are now the same, although timing differences can remain.

Production backup/restore, real MySQL migration, hardware uploads, real SMS delivery and physical WebAuthn authenticators were not tested here. Login throttling is currently shared across owners and may need per-account refinement for larger deployments. Unknown-account versus wrong-password responses can still reveal account existence. Existing local historical caches are retained for compatibility but never authorize access. Removing login/signup UI is not a substitute for server guards. Temporary credentials remain visible until the administrator hides/leaves the one-time result; use a private workstation.
