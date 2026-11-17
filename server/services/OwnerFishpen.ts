import type { Pool, PoolConnection } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';

export async function assignedFishpen(db: Pool | PoolConnection, owner: number, lock = false) {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT p.id, p.name, p.device_id AS deviceId
    FROM owner_fishpen_assignments a JOIN sms_fishpens p ON p.id = a.fishpen_id
    WHERE a.owner_user_id = ? AND p.owner_user_id = a.owner_user_id${lock ? ' FOR UPDATE' : ''}`, [owner]);
  if (!rows[0]) return null;
  if (rows[0].deviceId !== null) {
    const [devices] = await db.query<RowDataPacket[]>('SELECT id FROM sensor_devices WHERE id = ? AND owner_user_id = ? AND is_active = 1', [rows[0].deviceId, owner]);
    if (!devices.length) return null;
  }
  return { id: Number(rows[0].id), name: String(rows[0].name), deviceId: rows[0].deviceId === null ? null : Number(rows[0].deviceId) };
}
