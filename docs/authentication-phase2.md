# Administrator device verification: Phase 2

## Deployment status

Implemented locally. Do not claim the device restriction is active before enrollment. The first successful device registration atomically enables enforcement; all prior admin cookies without a credential identifier then stop working. No farmer, device telemetry, harvest or SMS records are removed.

## Environment and rollout

Use Node.js 22 or later, required by the installed SimpleWebAuthn 14 server release. Back up Aiven and retain the existing production signing secret.

For production set:

- WEBAUTHN_ORIGIN=https://pondsense-of-us.vercel.app
- WEBAUTHN_RP_ID=pondsense-of-us.vercel.app
- FRONTEND_URL=https://pondsense-of-us.vercel.app
- ADMIN_WEBAUTHN_BOOTSTRAP_SECRET: independent random secret, minimum 32 characters, generated and stored by the operator. Never use a VITE variable. Never commit or send it in chat.
- ADMIN_ACCOUNT_ID only if multiple historical administrator rows exist. Startup requires an unambiguous choice; it does not delete or demote historical accounts. Only the designated account can authenticate as admin.

Do not switch domain/RP ID after enrollment without a migration plan. HTTPS is required except on localhost. A credential registered on localhost cannot authenticate on the production domain. Test locally first; enroll production credentials separately.

Additive startup migrations create admin_security, admin_credentials, admin_auth_flows and admin_auth_rate. Existing credentials/password hashes and PIN remain intact. MySQL transactions lock the singleton security row for credential-slot operations, preventing concurrent fourth enrollments. Challenges and password-verification tokens are stored in MySQL, so Render restarts do not lose security state. Tokens expire and are hashed at rest. Remove expired flow rows periodically under an audited retention policy; no automatic history purge runs here.

## First device

1. Log in with the existing designated administrator password and PIN.
2. Before enforcement, the existing console remains accessible and explicitly reports that device protection is inactive.
3. The operator enters the bootstrap secret in the setup form. Complete the local Windows Hello/device PIN or biometric prompt yourself.
4. Synced/backup-eligible credentials are rejected. Use a compatible platform authenticator. No password-only fallback is enabled after activation.
5. Successful verification enables enforcement and creates an authenticated session tied to the credential. Remove the bootstrap secret from Render afterwards. Merely keeping it configured does not permit another bootstrap while enforcement is enabled.

## Second and third devices

On the candidate laptop, enter the correct password/PIN and choose Request enrollment. Share its short-lived request only with the authorized operator. On an enrolled laptop, freshly log in with WebAuthn and open Login security in the Admin Console, then use Approve a new login device to approve that exact request. Approval is bound to the candidate password-verification flow and an active approving credential. Return to the candidate, continue enrollment, and complete its platform authenticator prompt. Approval and registration expire after five minutes. A pending request expires after ten minutes. This is a security-sensitive approval: confirm the candidate laptop/operator out of band.

## Revocation and recovery

Fresh WebAuthn login (within five minutes) is required for approval and revocation. Revocation is recorded, not deleted, and blocks subsequent requests using that credential's cookies. A currently in-flight authorized request may finish. Enroll a replacement before revoking the last credential. Administrator login, approvals, registration and revocation are audited. Verification failures are audited where an authenticated flow identifies the administrator.

If all devices are lost, there is deliberately no public reset endpoint. A database/deployment operator must verify identity out of band, back up the database, revoke all admin credentials and outstanding flows, reset admin_security.enforced to FALSE, record the recovery in admin_audit_logs, configure a new bootstrap secret, and supervise first enrollment. Never use this process as routine password-only recovery. Removing a browser credential is not server revocation.

## Limitations and required acceptance tests

The cap is three active device-bound credentials, not a cryptographic guarantee of three physical laptops. The authenticatorAttachment field is client-reported; platform selection is not hardware attestation. Synced credentials are rejected using signed backup flags. No enterprise attestation or managed-laptop certificates are implemented. Some Mac/browser credential providers may offer only synced passkeys and will be rejected. Validate the actual Windows/Chrome/Edge hardware in use; browser WebAuthn support alone does not guarantee an eligible credential.

Sessions remain HttpOnly bearer cookies. Credential checks provide immediate server revocation, not per-request cryptographic proof of the laptop holding a copied session cookie. Device-bound session credentials or an mTLS access gateway are needed for that stronger guarantee. Password/PIN storage and separate admin-cookie/session redesign remain follow-up work.

Bounded shared database rate buckets limit admin password attempts and WebAuthn mutations across restarts/instances. These can temporarily throttle all admin users under attack; they are abuse controls, not identity checks.

Automated tests cover policy, capacity, token hashing and basic HTTP denial paths. Real platform enrollment, signatures, origin mismatch assertions, concurrent MySQL slot tests, recovery, revocation with copied cookies, and production Vercel proxy behavior still require acceptance testing. Do not represent mock tests as real-device certification. No real SMS is sent by these tests.
