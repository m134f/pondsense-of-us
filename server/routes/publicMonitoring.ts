import { Router } from 'express';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { requireAdmin } from '../auth';
export function publicMonitoringRouter(db: Pool | null) {
  const router = Router();
  router.put('/admin/public-monitoring', requireAdmin, async (req, res) => {
    if (!db) return res.status(503).json({ message: 'Database unavailable.' });
    const id = req.body?.deviceId;
    if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) return res.status(400).json({ message: 'Select a device.' });
    try {
      if (id === null) await db.execute('DELETE FROM public_monitoring WHERE id = 1');
      else {
        const [rows] = await db.execute<RowDataPacket[]>('SELECT id FROM sensor_devices WHERE id = ? AND is_active = 1', [id]);
        if (!rows.length) return res.status(404).json({ message: 'Active device not found.' });
        await db.execute('INSERT INTO public_monitoring (id, device_id) VALUES (1, ?) ON DUPLICATE KEY UPDATE device_id = VALUES(device_id)', [id]);
      }
      res.json({ saved: true });
    } catch { res.status(503).json({ message: 'Could not update publication.' }); }
  });
  router.get('/public/monitoring', async (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=2');
    if (!db) return res.status(503).json({ message: 'Monitoring temporarily unavailable.' });
    try {
      const [rows] = await db.query<RowDataPacket[]>(`SELECT t.ph, t.temperature_c, t.turbidity_ntu,
        t.recorded_at, t.sampled_at FROM public_monitoring p
        JOIN sensor_devices d ON d.id = p.device_id AND d.is_active = 1
        JOIN sensor_telemetry t ON t.device_id = d.id
        WHERE p.id = 1 AND t.water_contact_confirmed = TRUE ORDER BY t.id DESC LIMIT 1`);
      const row = rows[0];
      // Only measurement fields are published; never serialize device/account rows.
      res.json({ reading: row ? {
        ph: row.ph === null ? null : Number(row.ph),
        temperature: row.temperature_c === null ? null : Number(row.temperature_c),
        turbidity: row.turbidity_ntu === null ? null : Number(row.turbidity_ntu),
        measuredAt: row.sampled_at ?? row.recorded_at,
        receivedAt: row.recorded_at
      } : null, serverTime: new Date().toISOString() });
    } catch { res.status(503).json({ message: 'Monitoring temporarily unavailable.' }); }
  });
  return router;
}
