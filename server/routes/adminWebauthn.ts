import crypto from 'node:crypto';
import { Router } from 'express';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { generateRegistrationOptions, generateAuthenticationOptions, verifyRegistrationResponse, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { createAuthSession, requireAdmin, type AuthRequest } from '../auth';
import { acceptableAdminCredential, canEnrollAdminCredential } from '../services/AdminDevicePolicy';

export const flowHash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export async function allowAdminAttempt(db: Pool, bucket: string, limit: number) {
  await db.execute(`INSERT INTO admin_auth_rate (bucket, attempts, resets_at) VALUES (?, 1, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE))
    ON DUPLICATE KEY UPDATE attempts = IF(resets_at <= UTC_TIMESTAMP(), 1, attempts + 1),
    resets_at = IF(resets_at <= UTC_TIMESTAMP(), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE), resets_at)`, [bucket]);
  const [rows] = await db.query<RowDataPacket[]>('SELECT attempts FROM admin_auth_rate WHERE bucket = ?', [bucket]);
  return Number(rows[0]?.attempts) <= limit;
}
export async function passwordVerifiedFlow(db: Pool, admin: number) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.execute("INSERT INTO admin_auth_flows (token_hash, admin_id, kind, expires_at) VALUES (?, ?, 'password', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE))", [flowHash(token), admin]);
  return token;
}

function configuration() {
  const origin = process.env.WEBAUTHN_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:5173';
  const url = new URL(origin);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('WebAuthn requires a configured HTTPS origin.');
  return { origin: url.origin, rpID: process.env.WEBAUTHN_RP_ID || url.hostname };
}

export function adminWebauthnRouter(db: Pool | null) {
  const router = Router();
  router.use('/admin/security', async (req, res, next) => {
    if (!db) return res.status(503).json({ message: 'Database unavailable.' });
    try {
      if (req.method !== 'GET' && (req.headers.origin !== configuration().origin || !req.is('application/json'))) return res.status(403).json({ message: 'Untrusted request origin.' });
      if (req.method !== 'GET' && !await allowAdminAttempt(db, 'device-verification', 120)) return res.status(429).json({ message: 'Too many device requests. Wait five minutes.' });
      next();
    } catch { res.status(503).json({ message: 'Configure the production WebAuthn origin first.' }); }
  });

  async function transaction(res: import('express').Response, action: (c: PoolConnection) => Promise<unknown>) {
    const c = await db!.getConnection();
    try {
      await c.beginTransaction(); const result = await action(c); await c.commit();
      if (res.locals.adminDeviceSession) {
        const { admin, credential } = res.locals.adminDeviceSession;
        createAuthSession(res, admin, 'admin', 0, credential);
      }
      res.json(result);
    }
    catch (error) { await c.rollback(); console.warn('Admin device operation rejected:', (error as Error).message); res.status(400).json({ message: (error as Error).message || 'Device verification failed.' }); }
    finally { c.release(); }
  }
  async function flow(c: PoolConnection, token: unknown, kinds: string[]) {
    if (typeof token !== 'string' || token.length > 100) throw new Error('Invalid verification request. Log in again.');
    const [rows] = await c.query<RowDataPacket[]>('SELECT * FROM admin_auth_flows WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP() FOR UPDATE', [flowHash(token)]);
    if (!rows[0] || !kinds.includes(rows[0].kind)) throw new Error('Verification expired or not approved. Log in again.');
    const [settings] = await c.query<RowDataPacket[]>('SELECT * FROM admin_security WHERE id = 1 FOR UPDATE');
    if (Number(settings[0]?.admin_id) !== Number(rows[0].admin_id)) throw new Error('Unauthorized administrator.');
    return { f: rows[0], settings: settings[0] };
  }
  const audit = (c: PoolConnection, admin: number, action: string, details: unknown) => c.execute('INSERT INTO admin_audit_logs (admin_id, action, details) VALUES (?, ?, ?)', [admin, action, JSON.stringify(details)]);
  const fresh = (req: AuthRequest, res: import('express').Response, next: import('express').NextFunction) => {
    if (!req.auth?.credentialId || !req.auth.verifiedAt || Date.now() / 1000 - req.auth.verifiedAt > 300) return res.status(403).json({ message: 'Log in again with your enrolled device before managing devices.' });
    next();
  };

  router.post('/admin/security/authenticate/options', async (req, res) => transaction(res, async c => {
    const { f } = await flow(c, req.body.token, ['password']);
    const [credentials] = await c.query<RowDataPacket[]>('SELECT credential_id FROM admin_credentials WHERE admin_id = ? AND revoked_at IS NULL', [f.admin_id]);
    if (!credentials.length) throw new Error('First device enrollment is required.');
    const options = await generateAuthenticationOptions({ rpID: configuration().rpID, userVerification: 'required', allowCredentials: credentials.map(row => ({ id: row.credential_id, transports: ['internal'] })) });
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
      const result = await verifyAuthenticationResponse({ response: req.body.response, expectedChallenge: f.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true, credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: Number(row.signature_counter), transports: ['internal'] } });
      if (!result.verified || !acceptableAdminCredential(result.authenticationInfo)) throw new Error('Device-bound authentication required.');
      await c.execute('UPDATE admin_credentials SET signature_counter = ?, last_used_at = UTC_TIMESTAMP() WHERE id = ?', [result.authenticationInfo.newCounter, row.id]);
      await audit(c, f.admin_id, 'admin_device_login', { credentialId: row.id });
      res.locals.adminDeviceSession = { admin: Number(f.admin_id), credential: Number(row.id) };
      return { verified: true };
    } catch { await audit(c, f.admin_id, 'admin_device_login_denied', { credentialId: row.id }); return { verified: false }; }
  }));

  router.post('/admin/security/enroll/request', async (req, res) => transaction(res, async c => {
    const { f, settings } = await flow(c, req.body.token, ['password']);
    if (!settings.enforced) throw new Error('Use the first-device bootstrap process.');
    await c.execute("UPDATE admin_auth_flows SET kind = 'enrollPending', expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE) WHERE token_hash = ?", [f.token_hash]);
    return { requested: true };
  }));
  router.post('/admin/security/enroll/approve', requireAdmin, fresh, async (req: AuthRequest, res) => transaction(res, async c => {
    const { f } = await flow(c, req.body.token, ['enrollPending']);
    if (Number(f.admin_id) !== req.auth!.sub) throw new Error('Unauthorized enrollment.');
    await c.execute("UPDATE admin_auth_flows SET kind = 'enrollApproved', challenge = ?, expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE) WHERE token_hash = ?", [String(req.auth!.credentialId), f.token_hash]);
    await audit(c, f.admin_id, 'admin_device_enrollment_approved', { approver: req.auth!.credentialId });
    return { approved: true };
  }));
  router.post('/admin/security/enroll/options', async (req, res) => transaction(res, async c => {
    const { f, settings } = await flow(c, req.body.token, ['password', 'enrollApproved']);
    if (settings.enforced) {
      const [approvers] = await c.query<RowDataPacket[]>('SELECT id FROM admin_credentials WHERE id = ? AND admin_id = ? AND revoked_at IS NULL', [f.challenge, f.admin_id]);
      if (f.kind !== 'enrollApproved' || !approvers.length) throw new Error('An enrolled device must approve this request first.');
    } else {
      const secret = process.env.ADMIN_WEBAUTHN_BOOTSTRAP_SECRET || '';
      if (secret.length < 32 || typeof req.body.bootstrapSecret !== 'string' || !crypto.timingSafeEqual(Buffer.from(flowHash(secret)), Buffer.from(flowHash(req.body.bootstrapSecret)))) throw new Error('The operator bootstrap secret is required for the first device.');
    }
    const [credentials] = await c.query<RowDataPacket[]>('SELECT credential_id FROM admin_credentials WHERE admin_id = ? AND revoked_at IS NULL', [f.admin_id]);
    if (!canEnrollAdminCredential(credentials.length)) throw new Error('Three devices are already registered. Revoke one first.');
    const options = await generateRegistrationOptions({ rpName: 'PondSense of Us Admin', rpID: configuration().rpID, userID: new TextEncoder().encode(`pondsense-admin-${f.admin_id}`), userName: 'PondSense Administrator', attestationType: 'none', authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required' }, excludeCredentials: credentials.map(row => ({ id: row.credential_id })) });
    await c.execute("UPDATE admin_auth_flows SET kind = 'register', challenge = ? WHERE token_hash = ?", [JSON.stringify({ challenge: options.challenge, approver: settings.enforced ? Number(f.challenge) : null }), f.token_hash]);
    return { options };
  }));
  router.post('/admin/security/enroll/verify', async (req, res) => transaction(res, async c => {
    const { f, settings } = await flow(c, req.body.token, ['register']);
    const metadata = JSON.parse(f.challenge);
    if (settings.enforced) {
      const [approvers] = await c.query<RowDataPacket[]>('SELECT id FROM admin_credentials WHERE id = ? AND admin_id = ? AND revoked_at IS NULL', [metadata.approver, f.admin_id]);
      if (!approvers.length) throw new Error('Enrollment approval is no longer valid.');
    }
    const [credentials] = await c.query<RowDataPacket[]>('SELECT id FROM admin_credentials WHERE admin_id = ? AND revoked_at IS NULL', [f.admin_id]);
    if (!canEnrollAdminCredential(credentials.length)) throw new Error('Three devices are already registered.');
    const { origin, rpID } = configuration();
    const result = await verifyRegistrationResponse({ response: req.body.response, expectedChallenge: metadata.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    if (!result.verified || !result.registrationInfo || !acceptableAdminCredential(result.registrationInfo)) throw new Error('A non-synced, device-bound platform credential is required.');
    const info = result.registrationInfo;
    if (req.body.response?.authenticatorAttachment !== 'platform') throw new Error('Use this laptop platform authenticator, not a portable key.');
    const label = String(req.body.label || 'Administrator laptop').trim().slice(0, 100);
    const [insert] = await c.execute<ResultSetHeader>('INSERT INTO admin_credentials (admin_id, credential_id, credential_hash, public_key, signature_counter, label) VALUES (?, ?, ?, ?, ?, ?)', [f.admin_id, info.credential.id, flowHash(info.credential.id), Buffer.from(info.credential.publicKey), info.credential.counter, label]);
    await c.execute('UPDATE admin_auth_flows SET consumed_at = UTC_TIMESTAMP() WHERE token_hash = ?', [f.token_hash]);
    await c.execute('UPDATE admin_security SET enforced = TRUE WHERE id = 1');
    await audit(c, f.admin_id, 'admin_device_enrolled', { credentialId: insert.insertId, label });
    res.locals.adminDeviceSession = { admin: Number(f.admin_id), credential: insert.insertId };
    return { verified: true };
  }));

  router.get('/admin/security/devices', requireAdmin, async (req: AuthRequest, res) => {
    const [devices] = await db!.query<RowDataPacket[]>('SELECT id, label, created_at, last_used_at, revoked_at FROM admin_credentials WHERE admin_id = ? ORDER BY id', [req.auth!.sub]);
    res.json({ devices, currentCredentialId: req.auth!.credentialId || null });
  });
  router.post('/admin/security/devices/:id/revoke', requireAdmin, fresh, async (req: AuthRequest, res) => transaction(res, async c => {
    const [settings] = await c.query<RowDataPacket[]>('SELECT admin_id FROM admin_security WHERE id = 1 FOR UPDATE');
    if (Number(settings[0]?.admin_id) !== req.auth!.sub) throw new Error('Unauthorized administrator.');
    const id = Number(req.params.id);
    const [devices] = await c.query<RowDataPacket[]>('SELECT id FROM admin_credentials WHERE admin_id = ? AND revoked_at IS NULL', [req.auth!.sub]);
    if (devices.length <= 1) throw new Error('Enroll a replacement before revoking the last device.');
    if (!devices.some(row => Number(row.id) === id)) throw new Error('Active device not found.');
    await c.execute('UPDATE admin_credentials SET revoked_at = UTC_TIMESTAMP() WHERE id = ? AND admin_id = ?', [id, req.auth!.sub]);
    await audit(c, req.auth!.sub, 'admin_device_revoked', { credentialId: id });
    return { revoked: true };
  }));
  return router;
}
