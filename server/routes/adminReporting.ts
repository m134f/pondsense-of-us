import { Router } from 'express';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { requireRole } from '../auth';

export function adminFreshnessSeconds(value = process.env.ADMIN_DEVICE_FRESHNESS_SECONDS) {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 10 && seconds <= 3600 ? seconds : 60;
}

type DeviceConnection = 'online' | 'offline' | 'never' | 'inactive';
interface DeviceRow extends RowDataPacket {
  id: number;
  is_active: number;
  monitoring_fishpen_id: number | null;
  current_upload_at: Date | null;
  freshness_age: number | null;
}

export function adminDeviceConnection(active: unknown, uploadedAt: unknown, freshnessAge: unknown, cutoff: number): DeviceConnection {
  if (Number(active) !== 1) return 'inactive';
  if (!uploadedAt) return 'never';
  return typeof freshnessAge === 'number' && freshnessAge >= 0 && freshnessAge < cutoff ? 'online' : 'offline';
}

export function philippineDayBounds(now: number) {
  const day = 86_400_000;
  const offset = 8 * 3_600_000;
  const start = Math.floor((now + offset) / day) * day - offset;
  const utc = (time: number) => new Date(time).toISOString().slice(0, 19).replace('T', ' ');
  return [utc(start), utc(start + day)] as const;
}

async function listDevices(db: Pool, cutoff: number) {
  const [rows] = await db.query<DeviceRow[]>(`SELECT d.id, d.device_name, d.owner_user_id, d.is_active, d.last_seen_at,
    u.full_name AS owner_name, p.id AS monitoring_fishpen_id, p.name AS fishpen_name,
    (SELECT MAX(t.recorded_at) FROM sensor_telemetry t WHERE t.device_id = d.id) AS last_reading_at,
    (SELECT MAX(t.recorded_at) FROM sensor_telemetry t WHERE t.device_id = d.id AND t.owner_user_id = d.owner_user_id) AS current_upload_at,
    (SELECT MIN(GREATEST(TIMESTAMPDIFF(SECOND, t.sampled_at, CURRENT_TIMESTAMP),
        TIMESTAMPDIFF(SECOND, t.recorded_at, CURRENT_TIMESTAMP)))
      FROM sensor_telemetry t WHERE t.device_id = d.id AND t.owner_user_id = d.owner_user_id
        AND t.recorded_at >= TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP) AND t.recorded_at <= CURRENT_TIMESTAMP
        AND t.sampled_at <= CURRENT_TIMESTAMP AND t.water_contact_confirmed = TRUE) AS freshness_age
    FROM sensor_devices d LEFT JOIN users u ON u.id = d.owner_user_id
    LEFT JOIN sms_fishpens p ON p.device_id = d.id AND p.owner_user_id = d.owner_user_id
      AND EXISTS (SELECT 1 FROM owner_fishpen_assignments a WHERE a.owner_user_id = d.owner_user_id AND a.fishpen_id = p.id)
    ORDER BY d.id DESC`, [-cutoff]);
  return rows.map(({ freshness_age, ...device }) => ({ ...device,
    connection: adminDeviceConnection(device.is_active, device.current_upload_at, freshness_age, cutoff) }));
}

export function adminReportingRouter(db: Pool | null, shared = false) {
  const router = Router();
  const admin = requireRole('admin', db);
  router.get('/admin/devices', admin, async (_req, res) => {
    if (!db) return res.status(503).json({ message: 'Database is required.' });
    const freshnessSeconds = adminFreshnessSeconds();
    try { res.set('Cache-Control', 'no-store').json({ devices: await listDevices(db, freshnessSeconds), freshnessSeconds }); }
    catch { res.status(503).json({ message: 'Could not load ESP32 devices.' }); }
  });

  router.get('/admin/overview', admin, async (_req, res) => {
    if (!db) return res.status(503).json({ message: 'Database is required.' });
    const [start, end] = philippineDayBounds(Date.now());
    const freshnessSeconds = adminFreshnessSeconds();
    try {
      const [[[counts]], devices, [activity]] = await Promise.all([
        db.query<RowDataPacket[]>(`SELECT
          (SELECT COUNT(*) FROM users WHERE role = 'farmer' AND COALESCE(phone, '') <> '+639000000000') AS farmers,
          (SELECT COUNT(*) FROM sensor_telemetry) AS sensorReadings,
          (SELECT COUNT(*) FROM sms_critical_incidents WHERE opened_at >= ? AND opened_at < ?) AS criticalToday,
          (SELECT COUNT(*) FROM sms_critical_notifications WHERE status = 'accepted' AND attempted_at >= ? AND attempted_at < ?) +
          (SELECT COUNT(*) FROM sms_water_attempts WHERE status = 'accepted' AND attempted_at >= ? AND attempted_at < ?) +
          (SELECT COUNT(*) FROM planning_sms_log WHERE status = 'sent' AND created_at >= ? AND created_at < ?) +
          (SELECT COUNT(*) FROM alerts WHERE sms_sent = 1 AND sent_at >= ? AND sent_at < ?) AS smsToday`,
        [start, end, start, end, start, end, start, end, start, end]),
        listDevices(db, freshnessSeconds),
        db.query<RowDataPacket[]>(`SELECT * FROM (
          (SELECT t.id, 'upload' AS kind, t.recorded_at AS happened_at, COALESCE(d.device_name, 'ESP32') AS label, t.device_id
            FROM sensor_telemetry t LEFT JOIN sensor_devices d ON d.id = t.device_id ORDER BY t.recorded_at DESC, t.id DESC LIMIT 8)
          UNION ALL
          (SELECT l.id, 'admin' AS kind, l.created_at AS happened_at, l.action AS label, NULL AS device_id
            FROM admin_audit_logs l ORDER BY l.created_at DESC, l.id DESC LIMIT 8)
        ) recent ORDER BY happened_at DESC, kind, id DESC LIMIT 8`)
      ]);
      const deviceCounts = { online: 0, offline: 0, never: 0, inactive: 0, assigned: 0 };
      for (const device of devices) {
        deviceCounts[device.connection]++;
        if (device.monitoring_fishpen_id && device.connection !== 'inactive') deviceCounts.assigned++;
      }
      res.set('Cache-Control', 'no-store').json({ counts, devices: deviceCounts, activity, freshnessSeconds });
    } catch { res.status(503).json({ message: 'Could not load the admin overview.' }); }
  });

  router.get('/admin/telemetry', admin, async (_req, res) => {
    if (!db) return res.status(503).json({ message: 'Database is required.' });
    try {
      const [readings] = await db.query<RowDataPacket[]>(`SELECT t.id, t.device_id, d.device_name, u.full_name AS owner_name,
        t.sampled_at, t.recorded_at, t.ph, t.temperature_c, t.turbidity_ntu, t.water_contact_confirmed
        ${shared ? ', t.dissolved_oxygen, a.fishpen_name AS fishpen_at_upload' : ''}
        FROM sensor_telemetry t LEFT JOIN sensor_devices d ON d.id = t.device_id
        ${shared ? 'LEFT JOIN hardware_assignments a ON a.id = t.assignment_id' : ''}
        LEFT JOIN users u ON u.id = t.owner_user_id ORDER BY t.recorded_at DESC, t.id DESC LIMIT 250`);
      res.set('Cache-Control', 'no-store').json({ readings });
    } catch { res.status(503).json({ message: 'Could not load ESP32 uploads.' }); }
  });
  return router;
}
