import { Router } from 'express';
import type { Pool } from 'mysql2/promise';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { requireAdmin, type AuthRequest } from '../auth';
import { isTrustedJsonRequest } from '../trustedOrigin';

export function ownerFishpenRouter(db: Pool | null) {
  const router = Router();
  router.get('/admin/fishpen-assignments', requireAdmin, async (_req, res) => {
    if (!db) return res.status(503).json({ message: 'Database unavailable.' });
    const [owners] = await db.query<RowDataPacket[]>(`SELECT u.id, u.full_name AS name, a.fishpen_id AS fishpenId FROM users u
      LEFT JOIN owner_fishpen_assignments a ON a.owner_user_id = u.id WHERE u.role = 'farmer' AND u.phone <> '+639000000000'`);
    const [fishpens] = await db.query<RowDataPacket[]>('SELECT id, name, owner_user_id AS ownerId, device_id AS deviceId FROM sms_fishpens ORDER BY name');
    const [devices] = await db.query<RowDataPacket[]>('SELECT id, device_name AS name, owner_user_id AS ownerId FROM sensor_devices WHERE is_active = 1');
    res.json({ owners, fishpens, devices });
  });
  router.put('/admin/fishpen-assignments/:owner', requireAdmin, async (req: AuthRequest, res) => {
    if (!db) return res.status(503).json({ message: 'Database unavailable.' });
    if (!isTrustedJsonRequest(req)) return res.status(403).json({ message: 'Untrusted request.' });
    const owner = Number(req.params.owner);
    const id = req.body.fishpenId === null ? null : Number(req.body.fishpenId);
    const device = req.body.deviceId == null || req.body.deviceId === '' ? null : Number(req.body.deviceId);
    const name = String(req.body.name || '').trim();
    if (!Number.isSafeInteger(owner) || owner <= 0 || (id !== null && (!Number.isSafeInteger(id) || id <= 0)) || (device !== null && (!Number.isSafeInteger(device) || device <= 0)) || !name || name.length > 100) return res.status(400).json({ message: 'Choose an owner and enter a fishpen name.' });
    const c = await db.getConnection();
    try {
      await c.beginTransaction();
      const [users] = await c.query<RowDataPacket[]>('SELECT id FROM users WHERE id = ? AND role = ? FOR UPDATE', [owner, 'farmer']);
      if (!users.length) throw new Error('Farmer not found.');
      if (device !== null) {
        const [devices] = await c.query<RowDataPacket[]>('SELECT id FROM sensor_devices WHERE id = ? AND owner_user_id = ? AND is_active = 1 FOR UPDATE', [device, owner]);
        if (!devices.length) throw new Error('Choose an active monitoring device assigned to this owner.');
      }
      let pen = id;
      if (pen !== null) {
        const [pens] = await c.query<RowDataPacket[]>('SELECT id FROM sms_fishpens WHERE id = ? AND owner_user_id = ? FOR UPDATE', [pen, owner]);
        if (!pens.length) throw new Error('Fishpen does not belong to this owner.');
        await c.execute('UPDATE sms_fishpens SET name = ?, device_id = ? WHERE id = ?', [name, device, pen]);
      } else {
        const [result] = await c.execute<ResultSetHeader>('INSERT INTO sms_fishpens (owner_user_id, name, device_id) VALUES (?, ?, ?)', [owner, name, device]); pen = result.insertId;
      }
      await c.execute(`INSERT INTO owner_fishpen_assignments (owner_user_id, fishpen_id, updated_by) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE fishpen_id = VALUES(fishpen_id), updated_by = VALUES(updated_by)`, [owner, pen, req.auth!.sub]);
      await c.execute('INSERT INTO admin_audit_logs (admin_id, action, details) VALUES (?, ?, ?)', [req.auth!.sub, 'fishpen_assigned', JSON.stringify({ owner, fishpenId: pen })]);
      await c.commit(); res.json({ saved: true });
    } catch (error) { await c.rollback(); res.status(400).json({ message: (error as {code?: string}).code === 'ER_DUP_ENTRY' ? 'This monitor is already linked to another fishpen configuration.' : (error as Error).message }); }
    finally { c.release(); }
  });
  return router;
}
