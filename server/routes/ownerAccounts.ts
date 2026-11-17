import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import type { Pool } from 'mysql2/promise';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { requireRole, verifyAuthToken, createAuthSession, type AuthRequest } from '../auth';
import { allowAdminAttempt } from './adminWebauthn';

export const validOwnerPassword = (value: unknown): value is string => typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value, 'utf8') <= 72;
export function ownerAccountsRouter(db: Pool | null) {
  const router = Router();
  const requireAdmin = requireRole('admin', db);
  router.use(['/admin/owners', '/owner/password'], (req, res, next) => {
    if (!db) return res.status(503).json({ message: 'Database unavailable.' });
    if (req.method !== 'GET') {
      const origins = [process.env.FRONTEND_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'].filter(Boolean);
      if (!req.is('application/json') || !req.headers.origin || !origins.includes(req.headers.origin)) return res.status(403).json({ message: 'Untrusted request origin.' });
    }
    next();
  });
  router.post('/admin/owners', requireAdmin, async (req: AuthRequest, res) => {
    const { fullName, phone, fishpenName } = req.body || {};
    if (typeof fullName !== 'string' || !fullName.trim() || fullName.length > 100 || !/^\+639\d{9}$/.test(String(phone)) || typeof fishpenName !== 'string' || !fishpenName.trim() || fishpenName.length > 100) return res.status(400).json({ message: 'Enter the owner name, Philippine mobile number, and fishpen name.' });
    const temporaryPassword = crypto.randomBytes(24).toString('base64url');
    const hash = await bcrypt.hash(temporaryPassword, 12);
    const c = await db!.getConnection();
    try {
      await c.beginTransaction();
      const [result] = await c.execute<ResultSetHeader>(`INSERT INTO users (full_name, phone, password_hash, role, account_status, must_change_password, temporary_password_expires_at)
        VALUES (?, ?, ?, 'farmer', 'ACTIVE', TRUE, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR))`, [fullName.trim(), phone, hash]);
      const deviceKey = `ps_${crypto.randomBytes(24).toString('base64url')}`;
      const [device] = await c.execute<ResultSetHeader>('INSERT INTO sensor_devices (device_name, api_key_hash, owner_user_id) VALUES (?, ?, ?)',
        ['PondSense ESP32', await bcrypt.hash(deviceKey, 10), result.insertId]);
      const [pen] = await c.execute<ResultSetHeader>('INSERT INTO sms_fishpens (owner_user_id, name, device_id) VALUES (?, ?, ?)', [result.insertId, fishpenName.trim(), device.insertId]);
      await c.execute('INSERT INTO owner_fishpen_assignments (owner_user_id, fishpen_id, updated_by) VALUES (?, ?, ?)', [result.insertId, pen.insertId, req.auth!.sub]);
      await c.execute('INSERT INTO admin_audit_logs (admin_id, action, details) VALUES (?, ?, ?)', [req.auth!.sub, 'owner_provisioned', JSON.stringify({ ownerId: result.insertId, fishpenId: pen.insertId, deviceId: device.insertId })]);
      await c.commit(); res.json({ id: result.insertId, temporaryPassword, deviceKey, deviceId: device.insertId, expiresInHours: 24 });
    } catch (error) { await c.rollback(); res.status((error as {code?: string}).code === 'ER_DUP_ENTRY' ? 409 : 503).json({ message: (error as {code?: string}).code === 'ER_DUP_ENTRY' ? 'That mobile number already has an account. Manage the existing account instead.' : 'Unable to create owner account.' }); }
    finally { c.release(); }
  });
  router.put('/admin/owners/:id/monitoring-device', requireAdmin, async (req: AuthRequest, res) => {
    const owner = Number(req.params.id);
    const deviceId = Number(req.body?.deviceId);
    if (!Number.isSafeInteger(owner) || owner <= 0 || !Number.isSafeInteger(deviceId) || deviceId <= 0) return res.status(400).json({ message: 'Choose a valid owner and monitoring device.' });
    const c = await db!.getConnection();
    try {
      await c.beginTransaction();
      const [rows] = await c.query<RowDataPacket[]>(`SELECT p.id AS fishpenId, p.device_id AS previousDeviceId
        FROM owner_fishpen_assignments a JOIN sms_fishpens p ON p.id = a.fishpen_id
        JOIN users u ON u.id = a.owner_user_id
        WHERE a.owner_user_id = ? AND p.owner_user_id = ? AND u.role = 'farmer' FOR UPDATE`, [owner, owner]);
      if (!rows.length) { await c.rollback(); return res.status(404).json({ message: 'Owner has no assigned fishpen.' }); }
      const [devices] = await c.query<RowDataPacket[]>('SELECT id FROM sensor_devices WHERE id = ? AND owner_user_id = ? AND is_active = 1 FOR UPDATE', [deviceId, owner]);
      if (!devices.length) { await c.rollback(); return res.status(403).json({ message: 'Device is not active or does not belong to this owner.' }); }
      await c.execute('UPDATE sms_fishpens SET device_id = ? WHERE id = ?', [deviceId, rows[0].fishpenId]);
      await c.execute('UPDATE sensor_devices SET is_active = 0 WHERE owner_user_id = ? AND id <> ? AND is_active = 1', [owner, deviceId]);
      await c.execute('INSERT INTO admin_audit_logs (admin_id, action, details) VALUES (?, ?, ?)',
        [req.auth!.sub, 'fishpen_monitor_changed', JSON.stringify({ ownerId: owner, fishpenId: rows[0].fishpenId, previousDeviceId: rows[0].previousDeviceId, deviceId })]);
      await c.commit(); res.json({ saved: true, deviceId, fishpenId: rows[0].fishpenId });
    } catch (error) {
      await c.rollback();
      res.status((error as { code?: string }).code === 'ER_DUP_ENTRY' ? 409 : 503).json({ message: 'Unable to assign this device. Check whether it monitors another fishpen.' });
    } finally { c.release(); }
  });
  router.post('/admin/owners/:id/device-key', requireAdmin, async (req: AuthRequest, res) => {
    const owner = Number(req.params.id);
    if (!Number.isSafeInteger(owner) || owner <= 0) return res.status(400).json({ message: 'Invalid owner.' });
    const deviceKey = `ps_${crypto.randomBytes(24).toString('base64url')}`;
    const hash = await bcrypt.hash(deviceKey, 10);
    const c = await db!.getConnection();
    try {
      await c.beginTransaction();
      const [rows] = await c.query<RowDataPacket[]>(`SELECT d.id FROM owner_fishpen_assignments a
        JOIN sms_fishpens p ON p.id = a.fishpen_id AND p.owner_user_id = a.owner_user_id
        JOIN sensor_devices d ON d.id = p.device_id AND d.owner_user_id = a.owner_user_id AND d.is_active = 1
        WHERE a.owner_user_id = ? FOR UPDATE`, [owner]);
      if (!rows.length) { await c.rollback(); return res.status(404).json({ message: 'No active fishpen monitor is assigned to this owner.' }); }
      await c.execute('UPDATE sensor_devices SET api_key_hash = ? WHERE id = ?', [hash, rows[0].id]);
      await c.execute('INSERT INTO admin_audit_logs (admin_id, action, details) VALUES (?, ?, ?)',
        [req.auth!.sub, 'device_key_replaced', JSON.stringify({ ownerId: owner, deviceId: rows[0].id })]);
      await c.commit(); res.json({ deviceId: Number(rows[0].id), deviceKey });
    } catch { await c.rollback(); res.status(503).json({ message: 'Unable to replace device key.' }); }
    finally { c.release(); }
  });
  router.post('/admin/owners/:id/reset-password', requireAdmin, async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid owner.' });
    const temporaryPassword = crypto.randomBytes(24).toString('base64url');
    const hash = await bcrypt.hash(temporaryPassword, 12);
    const c = await db!.getConnection();
    try {
      await c.beginTransaction();
      const [rows] = await c.query<RowDataPacket[]>('SELECT id FROM users WHERE id = ? AND role = ? FOR UPDATE', [id, 'farmer']);
      if (!rows.length) { await c.rollback(); return res.status(404).json({ message: 'Owner not found.' }); }
      await c.execute(`UPDATE users SET password_hash = ?, must_change_password = TRUE, temporary_password_expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR), auth_version = auth_version + 1 WHERE id = ?`, [hash, id]);
      await c.execute('INSERT INTO admin_audit_logs (admin_id, action, details) VALUES (?, ?, ?)', [req.auth!.sub, 'owner_password_reset', JSON.stringify({ ownerId: id })]);
      await c.commit(); res.json({ temporaryPassword, expiresInHours: 24 });
    } catch { await c.rollback(); res.status(503).json({ message: 'Unable to reset password.' }); }
    finally { c.release(); }
  });
  router.post('/owner/password', async (req, res) => {
    const auth = verifyAuthToken(req);
    if (!auth || auth.role !== 'farmer') return res.status(401).json({ message: 'Owner login required.' });
    if (!validOwnerPassword(req.body?.newPassword)) return res.status(400).json({ message: 'Use at least 12 characters, up to 72 UTF-8 bytes.' });
    if (!await allowAdminAttempt(db!, `password-change-${auth.sub}`, 10)) return res.status(429).json({ message: 'Too many attempts. Try again in five minutes.' });
    const c = await db!.getConnection();
    try {
      await c.beginTransaction();
      const [rows] = await c.query<RowDataPacket[]>('SELECT * FROM users WHERE id = ? AND role = ? FOR UPDATE', [auth.sub, 'farmer']);
      const user = rows[0];
      if (!user || user.account_status !== 'ACTIVE' || Number(user.auth_version) !== (auth.version ?? 0) || (user.must_change_password && user.temporary_password_expires_at && new Date(user.temporary_password_expires_at).getTime() <= Date.now()) || typeof req.body.currentPassword !== 'string' || !await bcrypt.compare(req.body.currentPassword, user.password_hash)) { await c.rollback(); return res.status(403).json({ message: 'Cannot change password. Check the current password or contact the administrator.' }); }
      if (await bcrypt.compare(req.body.newPassword, user.password_hash)) { await c.rollback(); return res.status(400).json({ message: 'Choose a different password from your temporary/current password.' }); }
      const hash = await bcrypt.hash(req.body.newPassword, 12);
      await c.execute('UPDATE users SET password_hash = ?, must_change_password = FALSE, temporary_password_expires_at = NULL, password_changed_at = UTC_TIMESTAMP(), auth_version = auth_version + 1 WHERE id = ?', [hash, auth.sub]);
      await c.commit(); createAuthSession(res, auth.sub, 'farmer', Number(user.auth_version) + 1); res.json({ changed: true });
    } catch { await c.rollback(); res.status(503).json({ message: 'Unable to change password.' }); }
    finally { c.release(); }
  });
  return router;
}
