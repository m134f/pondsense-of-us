// HTTPS acceptance rehearsal only: no hosting accounts, production data or real SMS.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import { preview } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PONDSENSE_PLAYWRIGHT || 'playwright');
const openssl = process.env.PONDSENSE_OPENSSL || 'C:/xampp/apache/bin/openssl.exe';
const sslConfig = process.env.PONDSENSE_OPENSSL_CONFIG || 'C:/xampp/apache/conf/openssl.cnf';
const origin = 'https://localhost:5199', api = 'http://127.0.0.1:5128';
const physicalPrimary = process.argv.includes('--physical-primary');
const repeatSignIn = physicalPrimary && process.argv.includes('--repeat-sign-in');
if (Boolean(process.env.PONDSENSE_MFA_PROFILE_DIR) !== repeatSignIn) throw new Error('An enrolled profile is only valid in repeat sign-in mode.');
const secret = () => randomBytes(32).toString('base64url');
let database = `pondsense_mfa_fixture_${Date.now()}`;
const user = `mfa_${Date.now()}`;
const rootPassword = process.env.PONDSENSE_MFA_LOCAL_DB_PASSWORD || '';
if (physicalPrimary && !rootPassword) throw new Error('Use the isolated physical Windows Hello test launcher.');
const db = await mysql.createConnection({ host: '127.0.0.1', port: 3307, user: 'root', password: rootPassword, connectTimeout: 2500, multipleStatements: true });
let server, app, browser, physicalContext, fixtureFiles = [];
async function stopApp() {
  if (!app) return;
  if (app.exitCode === null && app.signalCode === null) {
    const closed = once(app, 'close');
    app.kill();
    await closed;
  }
  app = undefined;
}

try {
  const [[instance]] = await db.query('SELECT @@datadir AS dir, @@version AS version, @@event_scheduler AS scheduler');
  assert.match(instance.dir.replaceAll('\\', '/'), /\/pondsense-admin-report-test-mfa-[a-f0-9]+\/?$/i);
  assert.match(instance.version, /^8\.4\.8(?:\D|$)/);
  assert.equal(instance.scheduler, 'OFF');
  const folder = await mkdtemp(join(physicalPrimary ? process.env.PONDSENSE_MFA_ARTIFACTS : tmpdir(), 'pondsense-local-mfa-'));
  const crt = join(folder, 'local.pem'), key = join(folder, 'local.key');
  const emptyEnv = join(folder, 'fixture.env');
  fixtureFiles = [crt, key, emptyEnv];
  await writeFile(emptyEnv, '# Synthetic fixture. No inherited app environment.\n', { flag: 'wx' });
  execFileSync(openssl, ['req', '-config', sslConfig, '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', crt], { windowsHide: true, stdio: 'ignore' });
  const cert = await readFile(crt);
  const spki = new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' });
  const dbPassword = secret();
  const login = { identifier: 'https-fixture-admin', password: secret(), pin: String(randomBytes(4).readUInt32LE() % 900000 + 100000) };
  let enrolledCredential;
  if (repeatSignIn) {
    const [fixtures] = await db.query('SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA');
    const names = fixtures.map(row => row.name).filter(name => /^pondsense_mfa_fixture_\d+$/.test(name));
    assert.equal(names.length, 1, 'Expected the original disposable enrollment database.');
    [database] = names;
    await db.changeUser({ database });
    const [credentials] = await db.query(`SELECT c.id, c.credential_hash, c.last_used_at, u.id AS admin_id
      FROM admin_credentials c JOIN admin_security s ON s.admin_id = c.admin_id AND s.enforced = TRUE
      JOIN users u ON u.id = s.admin_id AND u.role = 'admin' WHERE c.revoked_at IS NULL AND u.username = 'https-fixture-admin'`);
    assert.equal(credentials.length, 1, 'The real primary credential must already be enrolled.');
    [enrolledCredential] = credentials;
    // The previous fixture's generated password was never retained. Update only the clone's disposable login factors.
    await db.beginTransaction();
    try {
      await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(login.password, 12), enrolledCredential.admin_id]);
      await db.execute("UPDATE admin_settings SET setting_val = ? WHERE setting_key = 'admin_pin'", [login.pin]);
      await db.commit();
    } catch (error) { await db.rollback(); throw error; }
  } else {
    await db.query(`CREATE DATABASE \`${database}\`; USE \`${database}\``);
    const schema = (await readFile('server/schema.sql', 'utf8')).replace(/CREATE DATABASE IF NOT EXISTS pondsense;\s*USE pondsense;/, '');
    assert.match(schema.trimStart(), /^CREATE TABLE/);
    await db.query(schema);
  }
  await db.query("CREATE USER ?@'localhost' IDENTIFIED BY ?", [user, dbPassword]);
  await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${database}\`.* TO '${user}'@'localhost'`);
  const env = {
    SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP,
    DOTENV_CONFIG_PATH: emptyEnv, MYSQL_HOST: '127.0.0.1', MYSQL_PORT: '3307', MYSQL_DATABASE: database,
    MYSQL_SSL: 'false', PORT: '5128', FRONTEND_URL: origin, WEBAUTHN_ORIGIN: origin, WEBAUTHN_RP_ID: 'localhost',
    ADMIN_USERNAME: login.identifier, ADMIN_PASSWORD: login.password, ADMIN_PIN: login.pin, ADMIN_PHONE: '+639100000011', SESSION_SECRET: secret(),
    IPROG_SMS_API_TOKEN: '', WATER_SMS_THRESHOLDS_REVIEWED: 'false', PONDSENSE_PAUSE_HARDWARE_UPLOADS: 'true'
  };
  if (!repeatSignIn) execFileSync(process.execPath, ['--import', 'tsx', 'server/prepare-local-database.ts'], {
    env: { ...env, NODE_ENV: 'test', MYSQL_USER: 'root', MYSQL_PASSWORD: rootPassword }, windowsHide: true, stdio: 'ignore'
  });
  // Scope the API listener to loopback without modifying the application entry point.
  const loopback = `data:text/javascript,${encodeURIComponent(`import { Server } from 'node:net'; const listen = Server.prototype.listen;
    Server.prototype.listen = function(port, ...args) { return port === 5128 ? listen.call(this, port, '127.0.0.1', ...args) : listen.call(this, port, ...args); };`)}`;
  async function startApp(bootstrap) {
    await new Promise((resolve, reject) => {
      const check = createServer().once('error', reject);
      check.listen(5128, '127.0.0.1', () => check.close(resolve));
    });
    app = spawn(process.execPath, ['--import', loopback, '--import', 'tsx', 'server/index.ts'], {
      env: { ...env, NODE_ENV: 'production', MYSQL_USER: user, MYSQL_PASSWORD: dbPassword, ADMIN_WEBAUTHN_BOOTSTRAP_SECRET: bootstrap },
      stdio: 'ignore', windowsHide: true
    });
    for (let i = 0; i < 100 && app.exitCode === null; i++) {
      const health = await fetch(`${api}/api/health`).then(res => res.json()).catch(() => null);
      if (health?.database === 'mysql-connected') return;
      await wait(125);
    }
    throw new Error('Disposable API did not start.');
  }
  const initialBootstrap = repeatSignIn ? '' : secret();
  await startApp(initialBootstrap);
  server = await preview({ configFile: false, envFile: false, preview: {
    host: 'localhost', port: 5199, strictPort: true, https: { cert, key: await readFile(key) },
    proxy: { '/api': { target: api, changeOrigin: false } }
  } });
  const browserArgs = [`--ignore-certificate-errors-spki-list=${createHash('sha256').update(spki).digest('base64')}`];
  async function testPhysicalPrimary() {
    // Keep the real platform authenticator available in a temporary, non-incognito profile.
    const profile = repeatSignIn ? process.env.PONDSENSE_MFA_PROFILE_DIR : join(folder, 'edge-test-profile');
    assert.ok(profile);
    physicalContext = await chromium.launchPersistentContext(profile, {
      channel: 'msedge', headless: false, serviceWorkers: 'block', args: browserArgs
    });
    const page = physicalContext.pages()[0] || await physicalContext.newPage();
    await page.goto(`${origin}/admin/login`);
    assert.equal(await page.evaluate(() => isSecureContext), true);
    const sessionStatus = () => page.evaluate(async () => (await fetch('/api/admin/session')).status);
    const platformAvailable = await page.evaluate(() => PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    console.log(`Windows platform authenticator advertised: ${platformAvailable ? 'yes' : 'no'}.`);
    async function passwordStep(button = 'Login to Admin') {
      await page.getByLabel('Username or email').fill(login.identifier);
      await page.getByLabel('Admin password').fill(login.password);
      await page.getByLabel('Admin PIN').fill(login.pin);
      await page.getByRole('button', { name: button }).click();
    }
    function waitForDashboard() {
      return Promise.race([
        page.waitForURL(`${origin}/admin/dashboard`, { timeout: 300_000 }),
        page.getByRole('alert').first().waitFor({ timeout: 300_000 }).then(async () => {
          const message = await page.getByRole('alert').first().textContent();
          throw new Error(`Physical verification was not accepted: ${message}`);
        })
      ]);
    }
    await physicalContext.clearCookies();
    if (repeatSignIn) {
      const registered = async () => page.evaluate(async () => {
        const response = await fetch('/api/admin/security/devices');
        return (await response.json()).currentCredentialId;
      });
      async function awaitNativeSignIn(label) {
        assert.equal(await sessionStatus(), 401);
        await page.bringToFront();
        console.log(`READY: ${label}. Complete Windows Hello when it appears after Login to Admin.`);
        await passwordStep();
        await waitForDashboard();
        assert.equal(await sessionStatus(), 200);
        assert.equal(await registered(), enrolledCredential.id);
      }
      await awaitNativeSignIn('First sign-in with the enrolled primary credential');
      await page.getByRole('button', { name: 'Logout', exact: true }).click();
      await page.waitForURL(`${origin}/admin/login`);
      assert.equal(await sessionStatus(), 401);
      console.log('PASS: first sign-in accepted the existing credential; logout removed the admin session.');
      await awaitNativeSignIn('Second sign-in after logout, using the same credential');
      const [after] = await db.query('SELECT id, credential_hash FROM admin_credentials WHERE revoked_at IS NULL');
      assert.equal(after.length === 1 && after[0].id === enrolledCredential.id && after[0].credential_hash === enrolledCredential.credential_hash, true);
      console.log('PASS: physical repeat sign-in succeeded after logout without enrollment; the same registered credential was used both times.');
      await page.waitForEvent('close', { timeout: 120_000 }).catch(() => undefined);
      return;
    }
    await page.goto(`${origin}/admin/passkeys/enroll`);
    await passwordStep('Continue to passkey setup');
    await page.getByRole('heading', { name: 'Register the first administrator device' }).waitFor();
    assert.equal(await sessionStatus(), 401);
    await page.getByLabel('Operator bootstrap secret').fill(initialBootstrap);
    await page.getByLabel('Device name').fill('Primary Windows Hello - local test');
    await page.bringToFront();
    console.log(`READY: ${origin}/admin/login is waiting for the physical Windows Hello prompt.`);
    await waitForDashboard();
    assert.equal(await sessionStatus(), 200);
    const [[state]] = await db.query(`SELECT s.enforced, COUNT(c.id) AS active FROM admin_security s
      LEFT JOIN admin_credentials c ON c.admin_id = s.admin_id AND c.revoked_at IS NULL WHERE s.id = 1 GROUP BY s.enforced`);
    assert.equal(Number(state.enforced), 1);
    assert.equal(Number(state.active), 1);
    console.log('PASS: the physical primary credential enrolled; a verified HTTPS admin session and exactly one active credential were confirmed.');
    // Leave the resulting dashboard visible briefly; closing the test tab ends the fixture sooner.
    await page.waitForEvent('close', { timeout: 120_000 }).catch(() => undefined);
  }
  async function testVirtualAuthenticators() {
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: browserArgs });
  async function actor(withAuthenticator = true, backupFlags = {}, mobile = false) {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {})
    });
    const page = await context.newPage();
    await page.goto(`${origin}/admin/login`);
    await page.getByRole('heading', { name: 'Admin Login' }).waitFor();
    assert.equal(await page.evaluate(() => isSecureContext), true);
    let cdp, authenticatorId;
    if (withAuthenticator) {
      cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
        protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
        isUserVerified: true, automaticPresenceSimulation: true, ...backupFlags
      } }));
    }
    const call = (path, body) => page.evaluate(async ({ path, body }) => {
      const res = await fetch(`/api${path}`, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      return { status: res.status, data: await res.json() };
    }, { path, body });
    async function step(path, body, status = 200) {
      const result = await call(path, body);
      assert.equal(result.status, status, path);
      return result.data;
    }
    const signIn = () => step('/admin/login', login);
    async function enroll(token, label, bootstrapSecret, expectedStatus = 200) {
      const { options } = await step('/admin/security/enroll/options', { token, bootstrapSecret });
      const response = await page.evaluate(async options => {
        const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(options);
        return (await navigator.credentials.create({ publicKey })).toJSON();
      }, options);
      const verification = await step('/admin/security/enroll/verify', { token, label, response }, expectedStatus);
      if (expectedStatus !== 200) return verification;
      assert.equal(verification.verified, true);
      return (await step('/admin/security/devices')).currentCredentialId;
    }
    async function verify(expectedId) {
      const { token, webauthnRequired } = await signIn();
      assert.equal(webauthnRequired, true);
      await step('/admin/session', undefined, 401);
      const { options } = await step('/admin/security/authenticate/options', { token });
      const response = await page.evaluate(async options => {
        const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(options);
        return (await navigator.credentials.get({ publicKey })).toJSON();
      }, options);
      assert.equal((await step('/admin/security/authenticate/verify', { token, response })).verified, true);
      assert.equal((await step('/admin/security/devices')).currentCredentialId, expectedId);
      await step('/admin/security/authenticate/verify', { token, response }, 400);
    }
    const cookies = () => context.cookies(origin).then(values => values.filter(c => c.name === 'pondsense_auth'));
    const logout = () => step('/admin/logout', {});
    async function verifyInUi(expectedId) {
      await page.goto(`${origin}/admin/login`);
      await step('/admin/session', undefined, 401);
      await page.getByLabel('Username or email').fill(login.identifier);
      await page.getByLabel('Admin password').fill(login.password);
      await page.getByLabel('Admin PIN').fill(login.pin);
      await page.getByRole('button', { name: 'Login to Admin' }).click();
      await page.waitForURL(`${origin}/admin/dashboard`);
      assert.equal((await step('/admin/security/devices')).currentCredentialId, expectedId);
    }
    return { context, page, call, step, signIn, enroll, verify, verifyInUi, cookies, logout, cdp, authenticatorId };
  }

  const primary = await actor(), backup = await actor(true, {}, true), probe = await actor(false);
  const { token, bootstrapRequired } = await primary.signIn();
  assert.equal(bootstrapRequired, true);
  await primary.step('/admin/session', undefined, 401);
  await primary.step('/admin/security/enroll/options', { token }, 400);
  await primary.step('/admin/security/enroll/request', { token, policy: 'sync-eligible' }, 400);
  const primaryId = await primary.enroll(token, 'Virtual primary', initialBootstrap);
  const primaryCookie = await primary.cookies();
  assert.equal(primaryCookie.length, 1);
  assert.ok(primaryCookie[0].secure && primaryCookie[0].httpOnly && primaryCookie[0].sameSite === 'Lax');
  // Rehearse upgrading the pre-policy schema with an enrolled key in this disposable database.
  const credentialState = async () => (await db.query(
    'SELECT id, credential_hash, public_key, signature_counter, revoked_at FROM admin_credentials WHERE id = ?', [primaryId]
  ))[0][0];
  const enrolled = await credentialState();
  await db.query('ALTER TABLE admin_credentials DROP COLUMN credential_policy, DROP COLUMN backup_eligible, DROP COLUMN backed_up');
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import mysql from 'mysql2/promise';
    import { migrateAdminWebauthn } from './server/migrations/adminWebauthn.ts';
    const pool = mysql.createPool({ host: '127.0.0.1', port: 3307, user: 'root', database: process.env.MYSQL_DATABASE });
    try { await migrateAdminWebauthn(pool); await migrateAdminWebauthn(pool); } finally { await pool.end(); }
  `], { env, windowsHide: true });
  assert.deepEqual(await credentialState(), enrolled);
  const [[legacyPolicy]] = await db.query('SELECT credential_policy, backup_eligible, backed_up FROM admin_credentials WHERE id = ?', [primaryId]);
  assert.deepEqual(legacyPolicy, { credential_policy: 'device-bound', backup_eligible: null, backed_up: null });
  await primary.logout();
  await probe.context.addCookies(primaryCookie);
  await probe.step('/admin/session', undefined, 401);
  await primary.verifyInUi(primaryId);
  assert.equal(await primary.page.getByRole('button', { name: /Login security|Passkey settings/ }).count(), 0);
  assert.equal(await primary.page.locator('a[href="/admin/passkeys"]').count(), 0);
  console.log('PASS: primary enrollment, additive migration twice preserving the existing credential, signed login, challenge replay rejection, HTTPS cookie and logout revocation.');

  const mobilePrompt = await actor(false, {}, true);
  try {
    const requests = [];
    mobilePrompt.page.on('request', request => requests.push(new URL(request.url()).pathname));
    await mobilePrompt.page.evaluate(() => {
      navigator.credentials.get = async () => { throw new DOMException('Test browser could not supply a passkey', 'NotAllowedError'); };
    });
    await mobilePrompt.page.getByLabel('Username or email').fill(login.identifier);
    await mobilePrompt.page.getByLabel('Admin password').fill(login.password);
    await mobilePrompt.page.getByLabel('Admin PIN').fill(login.pin);
    await mobilePrompt.page.getByRole('button', { name: 'Login to Admin' }).click();
    await mobilePrompt.page.getByRole('alert').filter({ hasText: 'No passkey was sent to the server' }).waitFor();
    assert.ok(requests.includes('/api/admin/login'));
    assert.ok(!requests.includes('/api/admin/security/authenticate/options'));
    assert.ok(!requests.includes('/api/admin/security/authenticate/verify'));
    assert.equal((await mobilePrompt.cookies()).length, 0);
  } finally { await mobilePrompt.context.close(); }

  for (const backedUp of [false, true]) {
    const mobile = await actor(true, { defaultBackupEligibility: true, defaultBackupState: backedUp }, true);
    try {
      const { token } = await mobile.signIn();
      await mobile.step('/admin/security/enroll/request', { token });
      await primary.step('/admin/security/enroll/approve', { token });
      const denied = await mobile.enroll(token, 'Virtual mobile synced passkey', undefined, 400);
      assert.match(denied.message, /eligible for backup or sync/);
      assert.equal((await mobile.cookies()).length, 0);
    } finally { await mobile.context.close(); }
  }
  assert.equal((await primary.step('/admin/security/devices')).devices.length, 1);
  console.log('PASS: browser NotAllowedError sends no assertion; device-bound approvals still reject backup-eligible passkeys.');

  const sync = 'sync-eligible';
  const apple = await actor(true, { defaultBackupEligibility: true, defaultBackupState: false }, true);
  const android = await actor(true, { defaultBackupEligibility: true, defaultBackupState: true }, true);
  const syncedCopy = await actor(true, { defaultBackupEligibility: true, defaultBackupState: true });
  await apple.page.goto(`${origin}/admin/passkeys/enroll`);
  await apple.page.getByLabel('Username or email').fill(login.identifier);
  await apple.page.getByLabel('Admin password').fill(login.password);
  await apple.page.getByLabel('Admin PIN').fill(login.pin);
  await apple.page.getByRole('button', { name: 'Continue to passkey setup' }).click();
  await apple.page.getByLabel('Credential type', { exact: true }).selectOption(sync);
  await apple.page.getByText(/may be available on other devices/).waitFor();
  await apple.step('/admin/session', undefined, 401);
  await apple.page.getByRole('button', { name: 'Request device approval' }).click();
  const appleToken = await apple.page.getByLabel(/Enrollment request/).inputValue();
  await apple.step('/admin/security/enroll/options', { token: appleToken }, 400);
  await primary.step('/admin/security/enroll/approve', { token: appleToken }, 400);
  await apple.step('/admin/security/enroll/approve', { token: appleToken, policy: sync }, 401);
  await primary.page.goto(`${origin}/admin/passkeys`);
  await primary.page.getByRole('heading', { name: 'Passkeys', exact: true }).waitFor();
  await primary.page.getByText('Approve a new login device', { exact: true }).click();
  await primary.page.getByLabel('Enrollment request').fill(appleToken);
  await primary.page.getByLabel('Credential type to approve').selectOption(sync);
  await primary.page.getByText(/may be available on other devices/).waitFor();
  primary.page.once('dialog', dialog => dialog.accept());
  await primary.page.getByRole('button', { name: 'Approve device enrollment' }).click();
  await primary.page.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
  await apple.page.getByLabel('Device name').fill('Virtual iPhone passkey');
  await apple.page.getByRole('button', { name: 'Continue after approval' }).click();
  await apple.page.waitForURL(`${origin}/admin/dashboard`);
  const { currentCredentialId: appleId } = await apple.step('/admin/security/devices');
  assert.ok(appleId);
  await apple.logout();
  await apple.verifyInUi(appleId);
  const appleRow = async () => (await primary.step('/admin/security/devices')).devices.find(device => device.id === appleId);
  assert.equal((await appleRow()).credential_policy, sync);
  assert.equal((await appleRow()).backup_eligible, 1);
  assert.equal((await appleRow()).backed_up, 0);

  const androidFlow = await android.signIn();
  await android.step('/admin/security/enroll/request', { token: androidFlow.token, policy: sync });
  await apple.step('/admin/security/enroll/approve', { token: androidFlow.token, policy: sync }, 400);
  await apple.step(`/admin/security/devices/${primaryId}/revoke`, {}, 400);
  const rejected = await primary.step('/admin/security/enroll/approve', { token: androidFlow.token, policy: sync }, 400);
  assert.match(rejected.message, /Both passkey slots are in use/);
  await android.step('/admin/security/enroll/options', { token: androidFlow.token }, 400);
  const inventory = (await primary.step('/admin/security/devices')).devices;
  assert.equal(inventory.find(device => device.id === primaryId).credential_policy, 'device-bound');
  assert.equal(inventory.filter(device => !device.revoked_at).length, 2);
  await primary.step(`/admin/security/devices/${primaryId}/revoke`, {}, 400);

  // Emulate the provider syncing a disposable virtual credential to another browser.
  const { credentials: [fixture] } = await apple.cdp.send('WebAuthn.getCredentials', { authenticatorId: apple.authenticatorId });
  await syncedCopy.cdp.send('WebAuthn.addCredential', {
    authenticatorId: syncedCopy.authenticatorId,
    credential: { ...fixture, backupEligibility: true, backupState: true }
  });
  await syncedCopy.verify(appleId);
  assert.equal((await appleRow()).backed_up, 1);
  const [[auditEntry]] = await db.query("SELECT details FROM admin_audit_logs WHERE action = 'admin_device_login' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(JSON.parse(auditEntry.details), { credentialId: appleId, policy: sync, backupEligible: true, backedUp: true });
  await primary.page.reload();
  await primary.page.getByText('2 of 2 credentials enrolled.', { exact: false }).waitFor();
  assert.equal(await primary.page.getByText('Approve a new login device', { exact: true }).count(), 0);
  const appleItem = primary.page.getByRole('listitem').filter({ hasText: 'Virtual iPhone passkey' });
  await appleItem.getByText(/Sync-eligible passkey/).waitFor();
  await appleItem.getByText(/Backup state: Backed up/).waitFor();
  primary.page.once('dialog', dialog => dialog.accept());
  await appleItem.getByRole('button', { name: 'Revoke' }).click();
  await appleItem.getByText(/Revoked/).waitFor();
  await apple.step('/admin/session', undefined, 403);
  await syncedCopy.step('/admin/session', undefined, 403);
  await primary.step('/admin/session');
  await android.step('/admin/session', undefined, 401);
  console.log('PASS: one-click sign-in, explicit mobile approval, two-slot cap, synced copy audit, and individual revocation.');

  const backupFlow = await backup.signIn();
  await backup.step('/admin/security/enroll/options', { token: backupFlow.token, bootstrapSecret: initialBootstrap }, 400);
  await backup.step('/admin/security/enroll/request', { token: backupFlow.token });
  await primary.step('/admin/security/enroll/approve', { token: backupFlow.token });
  const backupId = await backup.enroll(backupFlow.token, 'Virtual backup');
  assert.notEqual(backupId, primaryId);
  await backup.logout();
  let limited = false;
  for (let i = 0; i < 13; i++) {
    const attempt = await probe.call('/admin/login', { ...login, password: 'incorrect-fixture-password' });
    if (attempt.status === 429) { limited = true; break; }
    assert.equal(attempt.status, 401);
  }
  assert.ok(limited);
  // The fixture exercises over a dozen logins. Simulate the rate-window rollover only here.
  await db.query('UPDATE admin_auth_rate SET resets_at = UTC_TIMESTAMP()');
  await backup.verify(backupId);
  const revoked = await primary.cookies();
  await backup.step(`/admin/security/devices/${primaryId}/revoke`, {});
  await probe.context.addCookies(revoked);
  await probe.step('/admin/session', undefined, 403);
  await backup.step(`/admin/security/devices/${backupId}/revoke`, {}, 400);
  const backupSession = await backup.cookies();
  const outstanding = await probe.signIn();
  await backup.step('/admin/security/sessions/terminate', {});
  await probe.context.addCookies(backupSession);
  await probe.step('/admin/session', undefined, 403);
  await probe.step('/admin/security/authenticate/options', { token: outstanding.token }, 400);
  await backup.verify(backupId);
  console.log('PASS: backup approval and independent login, device revocation, last-device guard, and end-all-sessions.');

  const farmerPhone = '+639100000012';
  const farmer = await backup.step('/admin/owners', { fullName: 'Synthetic farmer', phone: farmerPhone, fishpenName: 'Synthetic pen' });
  const farmerBrowser = await actor(false);
  await farmerBrowser.step('/login', { phone: farmerPhone, password: farmer.temporaryPassword });
  const farmerPassword = secret();
  await farmerBrowser.step('/owner/password', { currentPassword: farmer.temporaryPassword, newPassword: farmerPassword });
  await farmerBrowser.step('/readings', { partialManual: true, ph: 7 });
  const farmerSession = await farmerBrowser.step('/session');
  assert.equal(farmerSession.user.id, farmer.id);
  await farmerBrowser.step('/admin/session', undefined, 403);
  await farmerBrowser.page.goto(`${origin}/admin/passkeys`);
  await farmerBrowser.page.waitForURL(`${origin}/admin/login`);
  const [[row]] = await db.query('SELECT id, password_hash, auth_version FROM users WHERE id = ?', [farmer.id]);
  const legacyBrowser = await actor(false);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const legacyUnsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: farmer.id, role: 'farmer', version: row.auth_version, exp: Math.floor(Date.now() / 1000) + 1800 })}`;
  const legacyCookie = { name: 'pondsense_auth', value: `${legacyUnsigned}.${createHmac('sha256', env.SESSION_SECRET).update(legacyUnsigned).digest('base64url')}`, url: origin };
  await legacyBrowser.context.addCookies([legacyCookie]);
  assert.equal((await legacyBrowser.step('/session')).user.id, farmer.id);
  await legacyBrowser.step('/logout', {});
  await legacyBrowser.context.addCookies([legacyCookie]);
  await legacyBrowser.step('/session', undefined, 401);
  console.log('PASS: a valid pre-release farmer session survives the upgrade and its logout is revocable.');

  // Rehearse the operator-only recovery runbook on this synthetic database, not a public API.
  const superseded = await probe.signIn();
  const beforeRecovery = await backup.cookies();
  await db.beginTransaction();
  try {
    const [[security]] = await db.query('SELECT admin_id FROM admin_security WHERE id = 1 FOR UPDATE');
    await db.execute('UPDATE admin_credentials SET revoked_at = UTC_TIMESTAMP() WHERE admin_id = ? AND revoked_at IS NULL', [security.admin_id]);
    await db.execute('UPDATE admin_auth_flows SET consumed_at = UTC_TIMESTAMP() WHERE admin_id = ? AND consumed_at IS NULL', [security.admin_id]);
    await db.execute("UPDATE users SET auth_version = auth_version + 1 WHERE id = ? AND role = 'admin'", [security.admin_id]);
    await db.query('UPDATE admin_security SET enforced = FALSE WHERE id = 1');
    await db.execute("INSERT INTO admin_audit_logs (admin_id, action, details) VALUES (?, 'operator_recovery_rehearsal', '{}')", [security.admin_id]);
    await db.commit();
  } catch (error) { await db.rollback(); throw error; }
  await stopApp();
  const recoveryBootstrap = secret();
  await startApp(recoveryBootstrap);
  await probe.context.addCookies(beforeRecovery);
  await probe.step('/admin/session', undefined, 403);
  await probe.step('/admin/security/authenticate/options', { token: superseded.token }, 400);
  const recovered = await actor();
  const recovery = await recovered.signIn();
  assert.equal(recovery.bootstrapRequired, true);
  await recovered.step('/admin/session', undefined, 401);
  await recovered.step('/admin/security/enroll/options', { token: recovery.token, bootstrapSecret: initialBootstrap }, 400);
  assert.ok(await recovered.enroll(recovery.token, 'Virtual recovery device', recoveryBootstrap));
  const [[after]] = await db.query('SELECT id, password_hash, auth_version FROM users WHERE id = ?', [farmer.id]);
  assert.equal(after.id === row.id && after.password_hash === row.password_hash && after.auth_version === row.auth_version, true);
  const history = await farmerBrowser.step('/readings');
  assert.ok(history.sessions.some(record => record.ph === 7));
  console.log('PASS: supervised recovery, stale session and flow rejection, and unchanged farmer credentials and history on the same backend.');
  }
  if (physicalPrimary) await testPhysicalPrimary(); else await testVirtualAuthenticators();
} finally {
  await physicalContext?.close().catch(() => undefined);
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  await stopApp();
  await db.end();
  for (const file of fixtureFiles) await unlink(file).catch(() => undefined);
}
