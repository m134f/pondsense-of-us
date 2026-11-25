import type { Pool, PoolConnection } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';

export async function assignedFishpen(db: Pool | PoolConnection, owner: number, lock = false, shared = false) {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT p.id, p.name, p.device_id AS deviceId
    FROM owner_fishpen_assignments a JOIN sms_fishpens p ON p.id = a.fishpen_id
    WHERE a.owner_user_id = ? AND p.owner_user_id = a.owner_user_id${lock ? ' FOR UPDATE' : ''}`, [owner]);
  if (!rows[0]) return null;
  if (shared) {
    const [[monitor]] = await db.query<RowDataPacket[]>(`SELECT a.id AS assignmentId, a.hardware_id AS hardwareId, h.credential_device_id AS deviceId
      FROM hardware_assignments a JOIN registered_hardware h ON h.id = a.hardware_id
      JOIN sensor_devices d ON d.id = h.credential_device_id AND d.is_active = 1
      WHERE a.active_fishpen_id = ? AND a.owner_user_id = ?${lock ? ' FOR UPDATE' : ''}`, [rows[0].id, owner]);
    return { id: Number(rows[0].id), name: String(rows[0].name), deviceId: monitor ? Number(monitor.deviceId) : null,
      hardwareId: monitor ? Number(monitor.hardwareId) : null, assignmentId: monitor ? String(monitor.assignmentId) : null };
  }
  if (rows[0].deviceId !== null) {
    const [devices] = await db.query<RowDataPacket[]>('SELECT id FROM sensor_devices WHERE id = ? AND owner_user_id = ? AND is_active = 1', [rows[0].deviceId, owner]);
    if (!devices.length) return null;
  }
  return { id: Number(rows[0].id), name: String(rows[0].name), deviceId: rows[0].deviceId === null ? null : Number(rows[0].deviceId) };
}
