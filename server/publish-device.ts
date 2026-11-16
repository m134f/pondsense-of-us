import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import type { RowDataPacket } from 'mysql2';
import { pool } from './db';
import { migratePublicMonitoring } from './migrations/publicMonitoring';

// Explicit administrative CLI: publish only the device matching this local firmware key.
if (!pool) throw new Error('Database configuration required.');
try {
  const path = process.argv[2];
  if (!path) throw new Error('Provide the device configuration file path.');
  const content = await readFile(path, 'utf8');
  const key = content.match(/SENSOR_API_KEY\s*(?:=\s*)?"([^"\r\n]+)"/)?.[1];
  if (!key) throw new Error('Device key not found.');
  const [rows] = await pool.query<RowDataPacket[]>('SELECT id, api_key_hash FROM sensor_devices WHERE is_active = 1');
  const matches = [];
  for (const row of rows) if (await bcrypt.compare(key, row.api_key_hash)) matches.push(row.id);
  if (matches.length !== 1) throw new Error('Expected exactly one matching device; no publication changed.');
  await migratePublicMonitoring(pool);
  await pool.execute('INSERT INTO public_monitoring (id, device_id) VALUES (1, ?) ON DUPLICATE KEY UPDATE device_id = VALUES(device_id)', [matches[0]]);
  console.log(`Public monitoring enabled for device ${matches[0]}. Credentials remain private.`);
} finally { await pool.end(); }
