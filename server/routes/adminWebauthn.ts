import crypto from 'node:crypto';
import { Router } from 'express';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { generateRegistrationOptions, generateAuthenticationOptions, verifyRegistrationResponse, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { clearAuthSession, createAuthSession, requireAdmin, type AuthRequest } from '../auth';
import { allowSource } from '../loginRate';
import { trustedOrigins } from '../trustedOrigin';
import { acceptableAdminCredential, canEnrollAdminCredential, isAdminCredentialPolicy, MAX_ADMIN_CREDENTIALS, type AdminCredentialPolicy } from '../services/AdminDevicePolicy';

export const flowHash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export async function passwordVerifiedFlow(db: Pool, admin: number) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.execute("INSERT INTO admin_auth_flows (token_hash, admin_id, kind, expires_at) VALUES (?, ?, 'password', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE))", [flowHash(token), admin]);
  return token;
}

async function authenticationOptions(db: Pool | PoolConnection, admin: number) {
  const [credentials] = await db.query<RowDataPacket[]>('SELECT credential_id, credential_policy FROM admin_credentials WHERE admin_id = ? AND revoked_at IS NULL', [admin]);
  if (!credentials.length) return null;
  return generateAuthenticationOptions({ rpID: configuration().rpID, userVerification: 'required', allowCredentials: credentials.map(row => ({
    id: row.credential_id, ...(row.credential_policy === 'device-bound' ? { transports: ['internal' as const] } : {})
  })) });
}

export async function prepareAdminPasskeyLogin(db: Pool, admin: number, requestOrigin: string | undefined) {
  if (requestOrigin !== configuration().origin) return null;
  const options = await authenticationOptions(db, admin);
  if (!options) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  await db.execute("INSERT INTO admin_auth_flows (token_hash, admin_id, kind, challenge, expires_at) VALUES (?, ?, 'authenticate', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE))", [flowHash(token), admin, options.challenge]);
  return { token, options };
}

function configuration() {
  const origin = process.env.WEBAUTHN_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:5173';
  const url = new URL(origin);
  const rpID = process.env.WEBAUTHN_RP_ID || url.hostname;
  if (process.env.NODE_ENV === 'production' && (!trustedOrigins().includes(url.origin) || rpID !== url.hostname)) {
    throw new Error('WebAuthn must use the configured public HTTPS origin and its exact DNS name.');
  }
  return { origin: url.origin, rpID };
}

class AdminFlowError extends Error {}
const slotsFull = 'Both passkey slots are in use. Revoke a passkey before enrolling a replacement.';

function requestedPolicy(value: unknown): AdminCredentialPolicy {
  if (value === undefined) return 'device-bound';
  if (!isAdminCredentialPolicy(value)) throw new AdminFlowError('Invalid enrollment policy.');
  return value;
}

type Enrollment = { policy: AdminCredentialPolicy; approver?: number; challenge?: string };
function readEnrollment(value: string): Enrollment {
  try {
    const metadata = JSON.parse(value);
    if (isAdminCredentialPolicy(metadata?.policy)) return metadata;
  } catch { /* A request started before the policy change must be restarted. */ }
  throw new AdminFlowError('Start a new enrollment request.');
}

async function hasDeviceBoundApprover(c: PoolConnection, admin: number, credential: number | undefined) {
  if (!Number.isSafeInteger(credential) || !credential || credential < 1) return false;
  const [rows] = await c.query<RowDataPacket[]>(
    "SELECT id FROM admin_credentials WHERE id = ? AND admin_id = ? AND revoked_at IS NULL AND credential_policy = 'device-bound'",
    [credential, admin]
  );
  return rows.length === 1;
}

export function adminWebauthnRouter(db: Pool | null) {
  const router = Router();
  router.use('/admin/security', async (req, res, next) => {
    if (!db) return res.status(503).json({ message: 'Database unavailable.' });
    try {
      if (req.method !== 'GET' && (req.headers.origin !== configuration().origin || !req.is('application/json'))) return res.status(403).json({ message: 'Untrusted request origin.' });
      if (req.method !== 'GET' && !await allowSource(db, req, 'device-verification', 80)) return res.status(429).set('Retry-After', '300').json({ message: 'Too many device requests. Wait five minutes.' });
      next();
    } catch { res.status(503).json({ message: 'Configure the production WebAuthn origin first.' }); }
  });

  async function transaction(res: import('express').Response, action: (c: PoolConnection) => Promise<unknown>) {
    const c = await db!.getConnection();
    try {
      await c.beginTransaction(); const result = await action(c);
      let issueSession: { admin: number; credential: number; version: number } | undefined;
      if (res.locals.adminDeviceSession) {
        const { admin, credential } = res.locals.adminDeviceSession;
        const [[user]] = await c.execute<RowDataPacket[]>('SELECT auth_version FROM users WHERE id = ? AND role = ?', [admin, 'admin']);
        if (!user) throw new AdminFlowError('Administrator is no longer available.');
        issueSession = { admin, credential, version: Number(user.auth_version) };
      }
      await c.commit();
      if (issueSession) createAuthSession(res, issueSession.admin, 'admin', issueSession.version, issueSession.credential);
      if (res.locals.clearEndedAdminSession) clearAuthSession(res);
      res.json(result);
    }
    catch (error) { await c.rollback(); res.status(400).json({ message: error instanceof AdminFlowError ? error.message : 'Device verification failed. Log in again to retry.' }); }
    finally { c.release(); }
  }
  async function flow(c: PoolConnection, token: unknown, kinds: string[]) {
    if (typeof token !== 'string' || token.length > 100) throw new AdminFlowError('Invalid verification request. Log in again.');
    const [settings] = await c.query<RowDataPacket[]>('SELECT * FROM admin_security WHERE id = 1 FOR UPDATE');
    const [rows] = await c.query<RowDataPacket[]>('SELECT * FROM admin_auth_flows WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP() FOR UPDATE', [flowHash(token)]);
    if (!rows[0] || !kinds.includes(rows[0].kind)) throw new AdminFlowError('Verification expired or not approved. Log in again.');
    if (Number(settings[0]?.admin_id) !== Number(rows[0].admin_id)) throw new AdminFlowError('Unauthorized administrator.');
    return { f: rows[0], settings: settings[0] };
  }
  const audit = (c: PoolConnection, admin: number, action: string, details: unknown) => c.execute('INSERT INTO admin_audit_logs (admin_id, action, details) VALUES (?, ?, ?)', [admin, action, JSON.stringify(details)]);
  const fresh = (req: AuthRequest, res: import('express').Response, next: import('express').NextFunction) => {
    if (!req.auth?.credentialId || !req.auth.verifiedAt || Date.now() / 1000 - req.auth.verifiedAt > 300) return res.status(403).json({ message: 'Log in again with your enrolled device before managing devices.' });
    next();
  };

  router.post('/admin/security/authenticate/options', async (req, res) => transaction(res, async c => {
    const { f } = await flow(c, req.body.token, ['password']);
    const options = await authenticationOptions(c, f.admin_id);
    if (!options) throw new AdminFlowError('First device enrollment is required.');
    await c.execute("UPDATE admin_auth_flows SET kind = 'authenticate', challenge = ? WHERE token_hash = ?", [options.challenge, f.token_hash]);
    return { options };
  }));
  router.post('/admin/security/authenticate/verify', async (req, res) => transaction(res, async c => {
    const { f } = await flow(c, req.body.token, ['authenticate']);
    // Consume even a failed assertion, so it cannot be replayed or retried indefinitely.
    await c.execute('UPDATE admin_auth_flows SET consumed_at = UTC_TIMESTAMP() WHERE token_hash = ?', [f.token_hash]);
    const [rows] = await c.query<RowDataPacket[]>('SELECT * FROM admin_credentials WHERE admin_id = ? AND credential_hash = ? AND revoked_at IS NULL FOR UPDATE', [f.admin_id, flowHash(String(req.body.response?.id))]);
    if (!rows[0]) { await audit(c, f.admin_id, 'admin_device_login_denied', {}); return { verified: false }; }
    const row = rows[0];
    try {
      const { origin, rpID } = configuration();
      const result = await verifyAuthenticationResponse({ response: req.body.response, expectedChallenge: f.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true, credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: Number(row.signature_counter) } });
      if (!result.verified || !isAdminCredentialPolicy(row.credential_policy) || !acceptableAdminCredential(result.authenticationInfo, row.credential_policy)) {
        await audit(c, f.admin_id, 'admin_device_login_denied', { credentialId: row.id, reason: 'credential_policy' });
        return { verified: false };
      }
      const { newCounter, credentialDeviceType, credentialBackedUp } = result.authenticationInfo;
      const backupEligible = credentialDeviceType === 'multiDevice';
      await c.execute('UPDATE admin_credentials SET signature_counter = ?, last_used_at = UTC_TIMESTAMP(), backup_eligible = ?, backed_up = ? WHERE id = ?', [newCounter, backupEligible, credentialBackedUp, row.id]);
      await audit(c, f.admin_id, 'admin_device_login', { credentialId: row.id, policy: row.credential_policy, backupEligible, backedUp: credentialBackedUp });
      res.locals.adminDeviceSession = { admin: Number(f.admin_id), credential: Number(row.id) };
      return { verified: true };
    } catch { await audit(c, f.admin_id, 'admin_device_login_denied', { credentialId: row.id }); return { verified: false }; }
  }));

  router.post('/admin/security/enroll/request', async (req, res) => transaction(res, async c => {
    const { f, settings } = await flow(c, req.body.token, ['password']);
    if (!settings.enforced) throw new AdminFlowError('Use the first-device bootstrap process.');
    const policy = requestedPolicy(req.body.policy);
    await c.execute("UPDATE admin_auth_flows SET kind = 'enrollPending', challenge = ?, expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE) WHERE token_hash = ?", [JSON.stringify({ policy }), f.token_hash]);
    return { requested: true };
  }));
  router.post('/admin/security/enroll/approve', requireAdmin, fresh, async (req: AuthRequest, res) => transaction(res, async c => {
    const { f } = await flow(c, req.body.token, ['enrollPending']);
    if (Number(f.admin_id) !== req.auth!.sub) throw new AdminFlowError('Unauthorized enrollment.');
    const { policy } = readEnrollment(f.challenge);
    if (requestedPolicy(req.body.policy) !== policy) throw new AdminFlowError('Choose the same credential type as the enrollment request.');
    const approver = req.auth!.credentialId;
    if (!await hasDeviceBoundApprover(c, f.admin_id, approver)) throw new AdminFlowError('Sign in with an authorized device-bound passkey before approving enrollment.');
    const [[{ activeCount }]] = await c.query<RowDataPacket[]>('SELECT COUNT(*) AS activeCount FROM admin_credentials WHERE admin_id = ? AND revoked_at IS NULL', [f.admin_id]);
    if (!canEnrollAdminCredential(Number(activeCount))) throw new AdminFlowError(slotsFull);
    await c.execute("UPDATE admin_auth_flows SET kind = 'enrollApproved', challenge = ?, expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE) WHERE token_hash = ?", [JSON.stringify({ policy, approver }), f.token_hash]);
    await audit(c, f.admin_id, 'admin_device_enrollment_approved', { approver, policy });
    return { approved: true };
  }));
  router.post('/admin/security/enroll/options', async (req, res) => transaction(res, async c => {
    const { f, settings } = await flow(c, req.body.token, ['password', 'enrollApproved']);
    const [credentials] = await c.query<RowDataPacket[]>('SELECT credential_id FROM admin_credentials WHERE admin_id = ? AND revoked_at IS NULL', [f.admin_id]);
    let enrollment: Enrollment = { policy: 'device-bound' };
    if (settings.enforced) {
      if (f.kind !== 'enrollApproved') throw new AdminFlowError('An enrolled device must approve this request first.');
      enrollment = readEnrollment(f.challenge);
      if (!await hasDeviceBoundApprover(c, f.admin_id, enrollment.approver)) throw new AdminFlowError('Enrollment approval is no longer valid.');
    } else {
      if (f.kind !== 'password' || credentials.length) throw new AdminFlowError('The operator must verify the enrollment state before continuing.');
      const secret = process.env.ADMIN_WEBAUTHN_BOOTSTRAP_SECRET || '';
      if (secret.length < 32 || typeof req.body.bootstrapSecret !== 'string' || !crypto.timingSafeEqual(Buffer.from(flowHash(secret)), Buffer.from(flowHash(req.body.bootstrapSecret)))) throw new AdminFlowError('The operator bootstrap secret is required for the first device.');
    }
    if (!canEnrollAdminCredential(credentials.length)) throw new AdminFlowError(slotsFull);
    const options = await generateRegistrationOptions({ rpName: 'PondSense of Us Admin', rpID: configuration().rpID, userID: new TextEncoder().encode(`pondsense-admin-${f.admin_id}`), userName: 'PondSense Administrator', attestationType: 'none', authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required' }, excludeCredentials: credentials.map(row => ({ id: row.credential_id })) });
    await c.execute("UPDATE admin_auth_flows SET kind = 'register', challenge = ? WHERE token_hash = ?", [JSON.stringify({ ...enrollment, challenge: options.challenge }), f.token_hash]);
    return { options };
  }));
  router.post('/admin/security/enroll/verify', async (req, res) => transaction(res, async c => {
    const { f, settings } = await flow(c, req.body.token, ['register']);
    const metadata = readEnrollment(f.challenge);
    const [credentials] = await c.query<RowDataPacket[]>('SELECT id FROM admin_credentials WHERE admin_id = ? AND revoked_at IS NULL', [f.admin_id]);
    if (settings.enforced) {
      if (!await hasDeviceBoundApprover(c, f.admin_id, metadata.approver)) throw new AdminFlowError('Enrollment approval is no longer valid.');
    } else if (metadata.policy !== 'device-bound' || metadata.approver !== undefined || credentials.length || (process.env.ADMIN_WEBAUTHN_BOOTSTRAP_SECRET || '').length < 32) {
      throw new AdminFlowError('First-device enrollment is no longer available.');
    }
    if (!canEnrollAdminCredential(credentials.length)) throw new AdminFlowError(slotsFull);
    if (typeof metadata.challenge !== 'string' || !metadata.challenge) throw new AdminFlowError('Start a new enrollment request.');
    const { origin, rpID } = configuration();
    const result = await verifyRegistrationResponse({ response: req.body.response, expectedChallenge: metadata.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    if (!result.verified || !result.registrationInfo || !acceptableAdminCredential(result.registrationInfo, metadata.policy)) {
      throw new AdminFlowError(metadata.policy === 'sync-eligible'
        ? 'This request was approved for a sync-eligible passkey. Use your phone passkey provider or start a new request.'
        : 'A device-bound platform passkey is required. Passkeys eligible for backup or sync need separate approval.');
    }
    const info = result.registrationInfo;
    if (req.body.response?.authenticatorAttachment !== 'platform') throw new AdminFlowError('Use this device\'s built-in authenticator, not a portable key.');
    const label = String(req.body.label || 'Administrator device').trim().slice(0, 100);
    const backupEligible = info.credentialDeviceType === 'multiDevice';
    const [insert] = await c.execute<ResultSetHeader>('INSERT INTO admin_credentials (admin_id, credential_id, credential_hash, public_key, signature_counter, label, credential_policy, backup_eligible, backed_up) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [f.admin_id, info.credential.id, flowHash(info.credential.id), Buffer.from(info.credential.publicKey), info.credential.counter, label, metadata.policy, backupEligible, info.credentialBackedUp]);
    await c.execute('UPDATE admin_auth_flows SET consumed_at = UTC_TIMESTAMP() WHERE token_hash = ?', [f.token_hash]);
    await c.execute('UPDATE admin_security SET enforced = TRUE WHERE id = 1');
    await audit(c, f.admin_id, 'admin_device_enrolled', { credentialId: insert.insertId, policy: metadata.policy, backupEligible, backedUp: info.credentialBackedUp, approver: metadata.approver });
    res.locals.adminDeviceSession = { admin: Number(f.admin_id), credential: insert.insertId };
    return { verified: true };
  }));

  router.get('/admin/security/devices', requireAdmin, async (req: AuthRequest, res) => {
    const [devices] = await db!.query<RowDataPacket[]>('SELECT id, label, created_at, last_used_at, revoked_at, credential_policy, backup_eligible, backed_up FROM admin_credentials WHERE admin_id = ? ORDER BY id', [req.auth!.sub]);
    res.json({ devices, currentCredentialId: req.auth!.credentialId || null, maxCredentials: MAX_ADMIN_CREDENTIALS });
  });
  router.post('/admin/security/sessions/terminate', requireAdmin, fresh, async (req: AuthRequest, res) => transaction(res, async c => {
    const admin = req.auth!.sub;
    await c.query('SELECT id FROM admin_security WHERE id = 1 FOR UPDATE');
    const [changed] = await c.execute<ResultSetHeader>("UPDATE users SET auth_version = auth_version + 1 WHERE id = ? AND role = 'admin' AND auth_version = ?", [admin, req.auth!.version ?? 0]);
    if (changed.affectedRows !== 1) throw new AdminFlowError('The administrator session has ended. Log in again.');
    await c.execute('UPDATE admin_auth_flows SET consumed_at = UTC_TIMESTAMP() WHERE admin_id = ? AND consumed_at IS NULL', [admin]);
    await audit(c, admin, 'admin_sessions_terminated', {});
    res.locals.clearEndedAdminSession = true;
    return { terminated: true };
  }));
  router.post('/admin/security/devices/:id/revoke', requireAdmin, fresh, async (req: AuthRequest, res) => transaction(res, async c => {
    const [settings] = await c.query<RowDataPacket[]>('SELECT admin_id FROM admin_security WHERE id = 1 FOR UPDATE');
    if (Number(settings[0]?.admin_id) !== req.auth!.sub) throw new Error('Unauthorized administrator.');
    const id = Number(req.params.id);
    const [devices] = await c.query<RowDataPacket[]>('SELECT id, credential_policy FROM admin_credentials WHERE admin_id = ? AND revoked_at IS NULL', [req.auth!.sub]);
    const target = devices.find(row => Number(row.id) === id);
    if (!target) throw new AdminFlowError('Active device not found.');
    if (target.credential_policy === 'device-bound') {
      if (!await hasDeviceBoundApprover(c, req.auth!.sub, req.auth!.credentialId)) throw new AdminFlowError('Use a device-bound passkey to revoke another device-bound passkey.');
      if (!devices.some(row => row !== target && row.credential_policy === 'device-bound')) throw new AdminFlowError('Enroll a replacement before revoking the last device-bound passkey.');
    }
    await c.execute('UPDATE admin_credentials SET revoked_at = UTC_TIMESTAMP() WHERE id = ? AND admin_id = ?', [id, req.auth!.sub]);
    await audit(c, req.auth!.sub, 'admin_device_revoked', { credentialId: id, policy: target.credential_policy });
    return { revoked: true };
  }));
  return router;
}
