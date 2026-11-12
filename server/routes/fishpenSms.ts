import { Router } from 'express';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { verifyAuthToken } from '../auth';
import { isSmsConfigured } from '../sms';
import { ownedFishpen, validateSmsSettings, waterSmsPolicy } from '../services/FishpenSms';

export function fishpenSmsRouter(db: Pool | null) {
  const router = Router();
  router.use(['/fishpen-sms', '/admin/water-sms'], async (req, res, next) => {
    const auth = verifyAuthToken(req);
    if (!auth) return res.status(401).json({ message: 'Please log in again.' });
    if (!db) return res.status(503).json({ message: 'SMS settings are temporarily unavailable.' });
    try {
      const [users] = await db.query<RowDataPacket[]>('SELECT role, phone FROM users WHERE id = ?', [auth.sub]);
      const expected = req.originalUrl.startsWith('/api/admin/') ? 'admin' : 'farmer';
      if (!users[0] || users[0].role !== expected || users[0].phone === '+639000000000') return res.status(403).json({ message: 'This account cannot access these SMS settings.' });
      res.locals.owner = auth.sub;
      next();
    } catch { res.status(503).json({ message: 'Unable to verify account access.' }); }
  });
  router.get('/fishpen-sms', async (_req, res) => {
    try {
      const owner = res.locals.owner;
      const [fishpens] = await db!.query<RowDataPacket[]>('SELECT * FROM sms_fishpens WHERE owner_user_id = ? ORDER BY id', [owner]);
      const [users] = await db!.query<RowDataPacket[]>('SELECT phone FROM users WHERE id = ?', [owner]);
      const [devices] = await db!.query<RowDataPacket[]>('SELECT id, device_name FROM sensor_devices WHERE owner_user_id = ? AND is_active = 1', [owner]);
      res.json({ fishpens, devices, ownerPhone: users[0]?.phone, configured: isSmsConfigured(), policy: waterSmsPolicy() });
    } catch { res.status(503).json({ message: 'Unable to load SMS settings.' }); }
  });
  router.put('/fishpen-sms/:id', async (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ message: 'JSON request required.' });
    let values;
    try { values = validateSmsSettings(req.body || {}); }
    catch (error) { return res.status(400).json({ message: (error as Error).message }); }
    const id = req.params.id === 'new' ? null : Number(req.params.id);
    if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) return res.status(400).json({ message: 'Invalid fishpen.' });
    let connection: PoolConnection | undefined;
    try {
      connection = await db!.getConnection();
      await connection.beginTransaction();
      if (values.deviceId !== null) {
        const [devices] = await connection.query<RowDataPacket[]>('SELECT id FROM sensor_devices WHERE id = ? AND owner_user_id = ? AND is_active = 1 FOR UPDATE', [values.deviceId, res.locals.owner]);
        if (!devices.length) { await connection.rollback(); return res.status(403).json({ message: 'Select a device assigned to your account.' }); }
      }
      if (id !== null && !await ownedFishpen(connection, id, res.locals.owner, true)) {
        await connection.rollback(); return res.status(404).json({ message: 'Fishpen not found.' });
      }
      const fields = [values.name, values.deviceId, values.ownerEnabled, values.caretakerPhone, values.caretakerEnabled];
      let savedId = id;
      if (id === null) {
        const [result] = await connection.execute<ResultSetHeader>(`INSERT INTO sms_fishpens (name, device_id, owner_enabled, caretaker_phone, caretaker_enabled, owner_user_id) VALUES (?, ?, ?, ?, ?, ?)`, [...fields, res.locals.owner]);
        savedId = result.insertId;
      } else {
        await connection.execute(`UPDATE sms_fishpens SET name = ?, device_id = ?, owner_enabled = ?, caretaker_phone = ?, caretaker_enabled = ? WHERE id = ? AND owner_user_id = ?`, [...fields, id, res.locals.owner]);
      }
      await connection.commit();
      res.json({ saved: true, id: savedId });
    } catch (error) {
      await connection?.rollback();
      res.status((error as { code?: string }).code === 'ER_DUP_ENTRY' ? 409 : 503).json({ message: (error as { code?: string }).code === 'ER_DUP_ENTRY' ? 'This device already belongs to a fishpen SMS configuration.' : 'Unable to save SMS settings.' });
    } finally { connection?.release(); }
  });
  router.get('/admin/water-sms', async (_req, res) => {
    try {
      const [logs] = await db!.query<RowDataPacket[]>(`SELECT id, fishpen_name, recipient_type, recipient_phone, parameter_name, severity,
        reading_value, DATE_FORMAT(measured_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS measured_at, status,
        DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at,
        DATE_FORMAT(attempted_at, '%Y-%m-%dT%H:%i:%sZ') AS attempted_at, provider_response, provider_message_id, provider
        FROM sms_water_attempts ORDER BY id DESC LIMIT 200`);
      res.json({ logs });
    } catch { res.status(503).json({ message: 'Unable to load water SMS logs.' }); }
  });
  return router;
}
