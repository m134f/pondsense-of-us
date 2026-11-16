import type { Pool } from 'mysql2/promise';
export async function migratePublicMonitoring(db: Pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS public_monitoring (
    id INT PRIMARY KEY, device_id INT NOT NULL,
    FOREIGN KEY (device_id) REFERENCES sensor_devices(id) ON DELETE CASCADE
  )`);
}
