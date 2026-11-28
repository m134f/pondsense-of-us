# Admin WebAuthn on mobile

Use the same registered origin and RP ID as the Windows Hello credential. For
production, the expected origin is `https://pondsense-of-us.vercel.app` and
the expected RP ID is `pondsense-of-us.vercel.app`. Check the values returned
by the running service rather than assuming that environment variables match
those defaults. The web origin is not the Render API hostname.

## Identify the failing step

On the enrolled Windows laptop, verify that fresh admin sign-in succeeds and
open `/admin/passkeys` directly and check **Authorized login devices**. A label alone does not
prove a credential is on the phone; a successful sign-in and a matching
last-verification timestamp do. Do not revoke the working credential.

On each phone, open the production URL directly in the browser, not an
embedded viewer. Compare only these fields, using the browser's Network
inspector or remote device inspection. Do not export a HAR or copy credential
IDs, challenges, approval codes, assertions, passwords, PINs, or cookies.

| Step | Safe evidence | Meaning |
| --- | --- | --- |
| `POST /api/admin/login` | Status, RP ID, timeout, user verification, count of allow-listed credentials | Password/PIN returns a flow token and passkey challenge for normal sign-in, not an admin session. Only unrevoked credentials are offered. |
| Native browser prompt | Browser error name; absence of an `authenticate/verify` request | The browser did not return a signed assertion, so the server did not reject an assertion or issue a cookie at this step. |
| `POST /api/admin/security/authenticate/verify` | Status, `verified` boolean, and whether the response set a cookie | The server received an assertion. A failure here is distinct from a native prompt error. |
| `GET /api/admin/session` | Status | After successful verification, confirms that the browser accepted and sent the session cookie. |

The local candidate records WebAuthn backup eligibility (BE) and the last
verified backup state (BS). Check **Passkeys** or use a provisioned
read-only connection to a database that has the new schema:

```sql
SELECT s.enforced, c.label, c.credential_policy, c.backup_eligible,
       c.backed_up, c.created_at, c.last_used_at, c.revoked_at
FROM admin_security AS s
LEFT JOIN admin_credentials AS c ON c.admin_id = s.admin_id
WHERE s.id = 1
ORDER BY c.created_at;
```

Existing credentials remain device-bound. Their flags are unknown until the
next successful signed authentication. Backup eligibility is permanent for
a credential; backup state can change and is not updated until the next
successful assertion. Successful authentications and enrollments audit the
policy and both flags without logging the assertion or tokens.

## Separately approved mobile enrollment

1. First rehearse on isolated HTTPS staging, with disposable accounts and a
   credential enrolled on that RP ID. Keep production credentials untouched.
2. On the phone, open `/admin/passkeys/enroll` directly, fill the admin login
   fields, and select **Continue to passkey setup**. Then choose
   **Sync-eligible mobile passkey** and select
   **Request device approval**. Confirm the request in person or over an
   authenticated channel with the approving administrator.
3. On the already enrolled device, complete a fresh sign-in with a
   device-bound passkey such as Windows Hello. In **Passkeys > Approve
   a new login device**, enter the code and explicitly select **Sync-eligible
   mobile passkey**. The server rejects mismatched approval types. The
   pending request expires in ten minutes; the approval is valid for five
   minutes. Approval alone never creates a session on the phone.
4. On the requesting phone, select **Continue after approval** and complete
   user verification with the built-in passkey provider. The OS can use
   Face ID, fingerprint, or its supported local verification method. The
   server requires the verified WebAuthn user-verification flag; it does not
   learn which biometric or screen lock the OS used. Log out and verify
   another sign-in. Repeat with a separate enrollment for the other phone.

## Security and rollout

- A synced passkey may be usable on other devices with access to the same
  Apple or Google account. Approval authorizes the credential, not the
  physical phone or a particular provider. Local user verification and the
  PondSense password/PIN are still required. Secure the cloud account and
  its recovery methods, and do not use a shared passkey vault for admin access.
- The two-slot cap counts credentials, not phones. One Windows Hello
  credential plus one approved mobile credential fits. A synced copy uses
  the same slot. Only an active device-bound credential can approve
  enrollment or revoke a device-bound credential. The last device-bound
  credential cannot be revoked through the portal.
- Revoke a mobile passkey in **Passkeys** if the phone or cloud account
  is lost. This invalidates PondSense access for every copy and its existing
  sessions, but does not erase the passkey from the provider. Other
  credentials remain active. If all device-bound credentials are lost, use
  supervised operator recovery and enroll a replacement device-bound
  credential before reapproving mobile access.
- The additive migration changes only `admin_credentials`: new policy
  defaults to `device-bound`; both flag columns start nullable. No existing
  keys, IDs, counters, or farmer data are rewritten. Apply the reviewed DDL
  separately from startup. Do not run the broad local database preparation
  command against production. The strict local MFA backend is the base for
  this change; the older production bootstrap fallback must not be retained
  in a future mobile release. Keep the live origin and RP ID stable.
- Before any rollout, test physical Windows Hello, iPhone Safari/Chrome,
  and Android Chrome on isolated HTTPS staging. The local browser rehearsal
  simulates sync across two browser contexts; it does not exercise Apple or
  Google cloud infrastructure or biometrics.
