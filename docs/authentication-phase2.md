# Administrator device verification: Phase 2

## Deployment status

Implemented locally. Password and PIN can start a short-lived WebAuthn flow but never grant normal admin access, even before first enrollment or during recovery. The first successful registration activates the authenticator and creates the first privileged session. Existing compatible authenticator registrations on the same origin can continue to be used; existing cookies require a fresh login. No farmer, device telemetry, harvest or SMS records are removed.

## Environment and rollout

Use Node.js 22 or later, required by the installed SimpleWebAuthn 14 server release. Back up Aiven and retain the existing production signing secret.

For production set:

- WEBAUTHN_ORIGIN=https://pondsense-of-us.vercel.app
- WEBAUTHN_RP_ID=pondsense-of-us.vercel.app
- FRONTEND_URL=https://pondsense-of-us.vercel.app
- ADMIN_WEBAUTHN_BOOTSTRAP_SECRET: independent random secret, minimum 32 characters, generated and stored by the operator for initial enrollment or supervised recovery only. Never use a VITE variable. Never commit or send it in chat.
- AUTH_TRUSTED_PROXY_CIDRS: optional. Configure only verified ingress peers for both the Vercel rewrite and direct Render path. Without it, Render ignores forwarded addresses and uses shared login budgets with per-account limits. Do not use Render outbound ranges or trust all proxies by default.
- ADMIN_ACCOUNT_ID only if multiple historical administrator rows exist. Startup requires an unambiguous choice; it does not delete or demote historical accounts. Only the designated account can authenticate as admin.

Do not switch domain/RP ID after enrollment without a migration plan. HTTPS is required except on localhost. A credential registered on localhost cannot authenticate on the production domain. Test locally first; enroll production credentials separately.

Run only reviewed additive migrations separately after approval. Normal startup validates the schema without DDL. Existing admin tables, credential records, password hashes and PIN remain intact. The shared-release migration adds the session revocation table. MySQL serializes enrollment and administrative session termination on the singleton security row. Challenges and password-verification tokens are stored in MySQL; flow tokens expire and are hashed at rest. Remove expired flow rows periodically under an audited retention policy; no automatic history purge runs here.

## First device

1. Log in with the existing designated administrator password and PIN.
2. With no active credentials, the login page offers first-device enrollment instead of opening the console.
3. The operator enters the bootstrap secret in the setup form. Complete the local Windows Hello/device PIN or biometric prompt yourself.
4. First-device enrollment rejects synced/backup-eligible credentials. Use a compatible device-bound platform authenticator. An independent recovery backup must be separately enrolled as device-bound, not a cloud-synced copy of an approved mobile passkey.
5. Successful verification enables enforcement and creates an authenticated session tied to the credential. Enroll and verify the backup immediately; remove the bootstrap secret from Render afterwards. Merely keeping it configured does not permit another bootstrap while enforcement is enabled.

## Second and third devices

On the candidate device, enter the correct password/PIN, choose Request enrollment, and select the credential type. Share its short-lived request only with the authorized operator. On an enrolled device, freshly log in with a device-bound passkey and use the settings gear beside Logout to open Passkeys, then approve the exact request and its credential type. Approval is bound to the candidate password-verification flow and an active device-bound approver. Return to the candidate, continue enrollment, and complete its platform authenticator prompt. Approval and registration expire after five minutes. A pending request expires after ten minutes. Confirm the candidate and operator out of band. See [mobile passkey enrollment](admin-mobile-webauthn.md).

## Revocation and recovery

Fresh WebAuthn login (within five minutes) is required for approval and revocation. Only a device-bound session can revoke a device-bound credential, and it cannot revoke the last one. Revocation is recorded, not deleted, and blocks subsequent requests using that credential's cookies, including any synced copies. A currently in-flight authorized request may finish. Administrator login, approvals, registration and revocation are audited.

Use **End all admin sessions** after fresh WebAuthn authentication if a session is lost or suspected copied. It invalidates outstanding sign-in flows and current sessions without removing enrolled authenticators. Ordinary logout invalidates only the current cookie.

If all devices are lost, there is deliberately no public reset endpoint. Use an authorized database/deployment operator with independent access to the hosting and database accounts:

1. Verify the administrator's identity out of band and confirm a current restorable backup. Rehearse this on isolated staging first.
2. In one audited transaction, lock the designated admin security row, mark its old credentials revoked and outstanding flows consumed, increment the designated admin's session version, and set `admin_security.enforced` to `FALSE`. Do not delete credential or audit records or change any farmer record.
3. Set a new independent bootstrap secret through the approved server configuration path. Supervise first-device enrollment with the correct password, PIN, bootstrap secret and a successful WebAuthn verification. No privileged session exists in the interim.
4. Verify both a newly enrolled primary and a separately enrolled backup, and remove the temporary bootstrap secret. Confirm old credentials and sessions remain denied.

## Limitations and required acceptance tests

The cap is two active credentials, not two physical devices. The authenticatorAttachment field is client-reported; platform selection is not hardware attestation. Signed backup flags enforce the policy of each credential: device-bound is the default, and sync-eligible credentials require separate approval. No enterprise attestation or managed-device certificates are implemented. Validate actual Windows Hello and mobile browsers on staging; generic WebAuthn support does not guarantee eligibility.

Sessions remain HttpOnly, Secure in production, host-only, SameSite Lax bearer cookies and expire after one hour for admin and eight hours for farmers. Logout/termination provide server-side revocation, not per-request cryptographic proof of which laptop holds an otherwise valid cookie. A request already in flight may still finish. Legacy PIN storage and separate cookie names remain follow-up work. Do not use a shared, disclosed, or demo password in production.

Individual account and verified-source limits use shared MySQL counters across restarts/instances. Users on the same genuine source IP can still share the higher IP cap (for example, a busy campus network), but one farmer reaching their account cap does not exhaust other accounts' quotas.

Before enabling this release in production, on the actual HTTPS staging domain with an isolated database and SMS disabled: enroll the primary with Windows Hello; deny an unsigned assertion and password/PIN-only access; separately approve and enroll the backup; verify independent sign-in on both; test logout, session termination and device revocation; rehearse recovery with neither test authenticator available; and verify the correct ingress IP is applied through both paths. Never use production credentials or keys for this test.
