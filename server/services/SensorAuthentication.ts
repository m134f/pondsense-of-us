import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Pool } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';

export function sensorAuthenticator(db: Pool | null) {
  const verified = new Map<string, { id: number; hash: string; expires: number }>();
  return async (key: string) => {
    if (!db || !key || key.length > 512) return null;
    const fingerprint = crypto.createHash('sha256').update(key).digest('hex');
    const cached = verified.get(fingerprint);
    let device: RowDataPacket | undefined;
    // Re-read active status, ownership and hash on every upload; cache only expensive bcrypt verification.
    if (cached && cached.expires > Date.now()) {
      const [rows] = await db.execute<RowDataPacket[]>('SELECT id, device_name, api_key_hash, owner_user_id FROM sensor_devices WHERE id = ? AND is_active = 1', [cached.id]);
      if (rows[0]?.api_key_hash === cached.hash) device = rows[0];
      else { verified.delete(fingerprint); return null; }
    } else {
      verified.delete(fingerprint);
      const [rows] = await db.execute<RowDataPacket[]>('SELECT id, device_name, api_key_hash, owner_user_id FROM sensor_devices WHERE is_active = 1 ORDER BY last_seen_at DESC, id DESC');
      for (const candidate of rows) {
        if (await bcrypt.compare(key, String(candidate.api_key_hash))) { device = candidate; break; }
      }
      if (device) {
        if (verified.size >= 128) verified.delete(verified.keys().next().value!);
        verified.set(fingerprint, { id: Number(device.id), hash: String(device.api_key_hash), expires: Date.now() + 10 * 60_000 });
      }
    }
    if (!device) return null;
    await db.execute('UPDATE sensor_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', [device.id]);
    return { id: Number(device.id), deviceName: String(device.device_name), ownerUserId: device.owner_user_id ? Number(device.owner_user_id) : null };
  };
}
