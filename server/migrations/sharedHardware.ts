import type { Pool, RowDataPacket } from 'mysql2/promise';
import { verifySharedHardwareBaseline } from '../startupSchema';

// Apply explicitly, with ingestion paused. Historical attribution is never backfilled here.
export async function migrateSharedHardware(db: Pool) {
  await verifySharedHardwareBaseline(db);
  await db.query(`CREATE TABLE IF NOT EXISTS registered_hardware (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    chip_id CHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
    credential_device_id INT NOT NULL UNIQUE,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    FOREIGN KEY (credential_device_id) REFERENCES sensor_devices(id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS hardware_assignments (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    hardware_id INT NOT NULL, owner_user_id INT NOT NULL, fishpen_id INT NOT NULL,
    fishpen_name VARCHAR(100) NOT NULL,
    started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ended_at DATETIME(3) NULL,
    active_hardware_id INT GENERATED ALWAYS AS (IF(ended_at IS NULL, hardware_id, NULL)) STORED,
    active_fishpen_id INT GENERATED ALWAYS AS (IF(ended_at IS NULL, fishpen_id, NULL)) STORED,
    UNIQUE KEY one_active_hardware (active_hardware_id),
    UNIQUE KEY one_active_fishpen (active_fishpen_id),
    INDEX hardware_assignment_history (hardware_id, started_at),
    FOREIGN KEY (hardware_id) REFERENCES registered_hardware(id),
    FOREIGN KEY (owner_user_id) REFERENCES users(id),
    FOREIGN KEY (fishpen_id) REFERENCES sms_fishpens(id))`);
  for (const [table, columns] of [
    ['sensor_telemetry', {
      hardware_id: 'INT NULL REFERENCES registered_hardware(id)',
      fishpen_id: 'INT NULL REFERENCES sms_fishpens(id)',
      assignment_id: 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL REFERENCES hardware_assignments(id)',
      dissolved_oxygen: 'DECIMAL(5,2) NULL'
    }],
    ['sms_critical_state', { assignment_id: 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL' }],
    ['sms_critical_notifications', { assignment_id: 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL' }]
  ] as const) {
    const [present] = await db.query<RowDataPacket[]>(
      'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    const existing = new Set(present.map(row => row.name));
    const missing = Object.entries(columns).filter(([name]) => !existing.has(name));
    if (missing.length) await db.query(`ALTER TABLE ${table} ${missing.map(([name, type]) => `ADD COLUMN ${name} ${type}`).join(', ')}`);
  }
  const [index] = await db.query<RowDataPacket[]>(`SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensor_telemetry' AND INDEX_NAME = 'telemetry_assignment_received'`);
  if (!index.length) await db.query('ALTER TABLE sensor_telemetry ADD INDEX telemetry_assignment_received (assignment_id, recorded_at)');
}
