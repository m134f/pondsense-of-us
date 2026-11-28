# PondSense mobile passkey staging acceptance

Candidate: `codex/mobile-passkey-staging`, based on `b34e5f57`. This is not a
production deploy. The Vercel config in this branch still points to production
for a future reviewed release. **Do not use it to publish staging.** The
staging launcher serves the built frontend and a loopback backend exclusively.

## Gates before exposing staging

- Export the current app schema using the original Aiven CA and hostname
  verification. Keep the SQL and SHA-256 in the protected local backup folder.
- Restore the dump offline, check its table manifest and integrity, and run
  the additive admin-only migration twice. Compare all existing columns and
  rows and verify the original schema validator still accepts the result.
  Never attach the restored database to a public service.
- Complete the production build, auth tests, isolated HTTPS WebAuthn suite,
  and unlisted/farmer browser checks. Do not reconfigure Render or Vercel.
- Start the temporary HTTPS tunnel with synthetic accounts and a fresh
  browser-access password. The launcher binds MySQL, the API and the gateway
  to loopback; it does not import production data or load production dotenv
  files. SMS and telemetry ingress are disabled. Verify the staging health
  marker, authenticated response headers, unauthorized admin API denial, and
  the absence of a sitemap before sharing the link.

## Physical device acceptance, in order

Use the exact staging URL on every device, opened directly in the browser.
Enter only the credentials in the private staging note on the workstation.
The browser-access prompt and the PondSense form have different credentials.
Do not send passwords, PINs, bootstrap secrets, approval codes, passkey
details, or unredacted Network logs in chat.
Open **Passkeys** using the settings gear beside **Logout**. Older staging
builds show the same controls under **Login security** in the header.

1. **Windows Hello.** Open `/admin/login` in Edge or Chrome. Enter the
   staging admin username, password and PIN. For first-device enrollment,
   enter the staging bootstrap secret and click **Set up Windows Hello /
   device verification**. Choose Windows Hello, not a cloud-synced passkey.
   Confirm **Device-bound passkey** in **Passkeys**. Log out and
   repeat sign-in with **Login to Admin**, which opens the native passkey prompt.
2. **iPhone enrollment.** In Safari open the same staging Admin Login.
   After filling the login fields, select **Set up or recover a passkey >
   Request enrollment of a new device >
   Sync-eligible mobile passkey > Request device approval**.
3. **Approve the iPhone.** Within five minutes of Windows Hello
   verification, open **Passkeys > Approve a new login device** on
   Windows. Enter the request shown on the phone; select **Sync-eligible
   mobile passkey** and click **Approve device enrollment**. On Safari,
   return to **Continue after approval** and finish the native passkey
   prompt. Label the credential to make it easy to revoke later.
4. **iPhone Safari and Chrome.** Log out in Safari, sign in again, and
   complete the passkey prompt. Repeat in Chrome using the
   same saved passkey rather than enrolling a duplicate. Record separately
   whether each browser found it, completed local verification, and opened
   the dashboard.
5. **Capacity.** With Windows and iPhone enrolled, Passkeys should show
   two active credentials. The server rejects a third approval until a
   passkey is revoked. To test Android separately, use a disposable fixture.
6. **Revocation.** Leave the iPhone sessions open. From a fresh Windows
   Hello session, use **Passkeys > Revoke** for the iPhone
   credential. Refresh both iPhone browsers: neither should retain an
   admin session or be able to sign in with the revoked passkey. Windows
   should still work.
7. **Farmer regression.** In a separate browser profile use the staging
   farmer account at `/login`. Verify Dashboard, History and Harvest
   load. Confirm no Admin Login link in the public pages or farmer
   navigation. A direct request to a protected admin page must send the
   farmer to Admin Login.
8. **Indexing and closeout.** Verify the staging response sets
   `X-Robots-Tag: noindex, nofollow`, and `/sitemap.xml` is absent. Note
   browser versions, results and any native passkey error. End the
   disposable tunnel after testing. A restarted quick tunnel gets a
   different RP ID and needs new staging enrollments.

## Rollback

On staging, stop the tunnel and isolated processes. There is no production
traffic or data to restore. The additive database changes need no column or
table drops. For a future production rollback after any mobile enrollment,
terminate sessions and revoke only the new sync-eligible credentials first;
preserve all device-bound credentials. Roll back to a verified **strict-MFA**
build, never an older build that can issue a password/PIN-only admin session.
Use the private backup restore only for disaster recovery, not routine
application rollback.
