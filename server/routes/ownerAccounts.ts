import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import type { Pool } from 'mysql2/promise';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { requireRole, verifyAuthToken, createAuthSession, type AuthRequest } from '../auth';
import { allowAttempt } from '../loginRate';
import { isTrustedJsonRequest } from '../trustedOrigin';

export const validOwnerPassword = (value: unknown): value is string => typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value, 'utf8') <= 72;
export function ownerAccountsRouter(db: Pool | null, legacyManagement = false) {
  const router = Router();
  const requireAdmin = requireRole('admin', db);
  router.use(['/admin/owners', '/owner/password'], (req, res, next) => {
    if (!db) return res.status(503).json({ message: 'Database unavailable.' });
    if (req.method !== 'GET') {
      if (!isTrustedJsonRequest(req)) return res.status(403).json({ message: 'Untrusted request origin.' });
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
      const [pen] = await c.execute<ResultSetHeader>('INSERT INTO sms_fishpens (owner_user_id, name) VALUES (?, ?)', [result.insertId, fishpenName.trim()]);
      await c.execute('INSERT INTO owner_fishpen_assignments (owner_user_id, fishpen_id, updated_by) VALUES (?, ?, ?)', [result.insertId, pen.insertId, req.auth!.sub]);
      await c.execute('INSERT INTO admin_audit_logs (admin_id, action, details) VALUES (?, ?, ?)', [req.auth!.sub, 'owner_provisioned', JSON.stringify({ ownerId: result.insertId, fishpenId: pen.insertId })]);
      await c.commit(); res.set('Cache-Control', 'no-store').json({ id: result.insertId, temporaryPassword, expiresInHours: 24 });
    } catch (error) { await c.rollback(); res.status((error as {code?: string}).code === 'ER_DUP_ENTRY' ? 409 : 503).json({ message: (error as {code?: string}).code === 'ER_DUP_ENTRY' ? 'That mobile number already has an account. Manage the existing account instead.' : 'Unable to create owner account.' }); }
    finally { c.release(); }
  });
  router.put('/admin/owners/:id/monitoring-device', requireAdmin, async (req: AuthRequest, res) => {
    if (!legacyManagement) return res.status(410).json({ message: 'Manage assignments under registered hardware.' });
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
    if (!legacyManagement) return res.status(410).json({ message: 'Replace keys under registered hardware.' });
    const owner = Number(req.params.id);
    if (!Number.isSafeInteger(owner) || owner <= 0) return res.status(400).json({ message: 'Invalid owner.' });
    const expectedDeviceId = req.body?.expectedDeviceId;
    if (expectedDeviceId !== undefined && (!Number.isSafeInteger(expectedDeviceId) || expectedDeviceId <= 0)) return res.status(400).json({ message: 'Invalid device.' });
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
      if (expectedDeviceId !== undefined && Number(rows[0].id) !== expectedDeviceId) {
        await c.rollback(); return res.status(409).json({ message: 'The monitoring device changed. Refresh the Devices page before replacing its key.' });
      }
      await c.execute('UPDATE sensor_devices SET api_key_hash = ? WHERE id = ?', [hash, rows[0].id]);
      await c.execute('INSERT INTO admin_audit_logs (admin_id, action, details) VALUES (?, ?, ?)',
        [req.auth!.sub, 'device_key_replaced', JSON.stringify({ ownerId: owner, deviceId: rows[0].id })]);
      await c.commit(); res.set('Cache-Control', 'no-store').json({ deviceId: Number(rows[0].id), deviceKey });
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
      await c.commit(); res.set('Cache-Control', 'no-store').json({ temporaryPassword, expiresInHours: 24 });
    } catch { await c.rollback(); res.status(503).json({ message: 'Unable to reset password.' }); }
    finally { c.release(); }
  });
  router.delete('/admin/owners/:id', requireAdmin, async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0 || req.body?.confirm !== 'DELETE') {
      return res.status(400).json({ message: 'Confirm the farmer account deletion.' });
    }
    if (!req.auth?.credentialId || !req.auth.verifiedAt || Date.now() / 1000 - req.auth.verifiedAt > 300) {
      return res.status(403).json({ message: 'Log in again with your admin passkey before deleting an account.' });
    }
    const c = await db!.getConnection();
    try {
      await c.beginTransaction();
      const [[farmer]] = await c.execute<RowDataPacket[]>(`SELECT account_status FROM users
        WHERE id = ? AND role = 'farmer' AND phone <> '+639000000000' FOR UPDATE`, [id]);
      if (!farmer || farmer.account_status !== 'SUSPENDED') {
        await c.rollback();
        return res.status(farmer ? 409 : 404).json({ message: farmer ? 'Suspend this farmer account before deleting it.' : 'Farmer account not found.' });
      }
      // Serialize account/fishpen changes and check historical references that lack foreign keys.
      const [pens] = await c.execute<RowDataPacket[]>(`SELECT id, device_id, owner_enabled, owner_alert_phone, caretaker_phone, caretaker_enabled
        FROM sms_fishpens WHERE owner_user_id = ? FOR UPDATE`, [id]);
      const [[links]] = await c.execute<RowDataPacket[]>(`WITH target AS (SELECT ? AS id),
        pens AS (SELECT id FROM sms_fishpens WHERE owner_user_id = (SELECT id FROM target))
        SELECT (
          EXISTS (SELECT 1 FROM water_readings WHERE user_id = target.id) OR
          EXISTS (SELECT 1 FROM alerts WHERE user_id = target.id) OR
          EXISTS (SELECT 1 FROM corrective_action_log WHERE user_id = target.id) OR
          EXISTS (SELECT 1 FROM recommendation_history WHERE owner_user_id = target.id) OR
          EXISTS (SELECT 1 FROM harvest_batches WHERE owner_user_id = target.id OR fishpen_id IN (SELECT id FROM pens)) OR
          EXISTS (SELECT 1 FROM sensor_devices WHERE owner_user_id = target.id) OR
          EXISTS (SELECT 1 FROM sensor_telemetry WHERE owner_user_id = target.id OR fishpen_id IN (SELECT id FROM pens)) OR
          EXISTS (SELECT 1 FROM hardware_assignments WHERE owner_user_id = target.id OR fishpen_id IN (SELECT id FROM pens)) OR
          EXISTS (SELECT 1 FROM planning_sms_log WHERE owner_user_id = target.id) OR
          EXISTS (SELECT 1 FROM sms_water_state WHERE fishpen_id IN (SELECT id FROM pens)) OR
          EXISTS (SELECT 1 FROM sms_water_attempts WHERE owner_user_id = target.id OR fishpen_id IN (SELECT id FROM pens)) OR
          EXISTS (SELECT 1 FROM sms_critical_incidents WHERE owner_user_id = target.id OR fishpen_id IN (SELECT id FROM pens)) OR
          EXISTS (SELECT 1 FROM sms_critical_state WHERE owner_user_id = target.id OR fishpen_id IN (SELECT id FROM pens)) OR
          EXISTS (SELECT 1 FROM sms_critical_notifications WHERE owner_user_id = target.id OR fishpen_id IN (SELECT id FROM pens)) OR
          EXISTS (SELECT 1 FROM admin_audit_logs WHERE admin_id = target.id) OR
          EXISTS (SELECT 1 FROM owner_fishpen_assignments
            WHERE updated_by = target.id OR (owner_user_id = target.id AND fishpen_id NOT IN (SELECT id FROM pens))
            OR (owner_user_id <> target.id AND fishpen_id IN (SELECT id FROM pens)))
        ) AS inUse FROM target`, [id]);
      if (links.inUse || pens.some(pen => pen.device_id != null || pen.owner_alert_phone != null || pen.caretaker_phone != null || !pen.owner_enabled || pen.caretaker_enabled)) {
        await c.rollback();
        return res.status(409).json({ message: 'This account has linked history, monitoring, or SMS settings. Keep it suspended to preserve those records.' });
      }
      await c.execute('DELETE FROM owner_fishpen_assignments WHERE owner_user_id = ?', [id]);
      await c.execute('DELETE FROM sms_fishpens WHERE owner_user_id = ?', [id]);
      const [result] = await c.execute<ResultSetHeader>("DELETE FROM users WHERE id = ? AND role = 'farmer' AND account_status = 'SUSPENDED'", [id]);
      if (result.affectedRows !== 1) throw new Error('Farmer account changed during deletion.');
      await c.execute('INSERT INTO admin_audit_logs (admin_id, action, details) VALUES (?, ?, ?)', [req.auth.sub, 'farmer_deleted', JSON.stringify({ ownerId: id })]);
      await c.commit();
      res.json({ deleted: true });
    } catch (error) {
      await c.rollback();
      const linked = (error as { code?: string }).code === 'ER_ROW_IS_REFERENCED_2';
      res.status(linked ? 409 : 503).json({ message: linked ? 'This account still has linked records and was not deleted.' : 'Unable to delete the farmer account.' });
    } finally { c.release(); }
  });
  router.post('/owner/password', async (req, res) => {
    const auth = verifyAuthToken(req);
    if (!auth || auth.role !== 'farmer') return res.status(401).json({ message: 'Owner login required.' });
    if (!validOwnerPassword(req.body?.newPassword)) return res.status(400).json({ message: 'Use at least 12 characters, up to 72 UTF-8 bytes.' });
    if (!await allowAttempt(db!, 'password-change:account', String(auth.sub), 10)) return res.status(429).set('Retry-After', '300').json({ message: 'Too many attempts. Try again in five minutes.' });
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
