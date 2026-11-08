import type { Pool } from 'mysql2/promise';

export async function migratePlanning(db: Pool) {
  // Additive, restart-safe changes; existing batches and readings retain their identities.
  for (const statement of [
    'ALTER TABLE harvest_batches ADD COLUMN notes VARCHAR(1000) NULL',
    'ALTER TABLE harvest_batches ADD COLUMN sensor_device_id INT NULL',
    'ALTER TABLE harvest_samples ADD COLUMN notes VARCHAR(1000) NULL',
    'ALTER TABLE harvest_events ADD COLUMN notes VARCHAR(1000) NULL'
  ]) {
    try { await db.query(statement); } catch (error) {
      if ((error as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw error;
    }
  }
  await db.query(`CREATE TABLE IF NOT EXISTS harvest_observations (
    id INT AUTO_INCREMENT PRIMARY KEY, batch_id INT NOT NULL, observed_at DATE NOT NULL,
    category VARCHAR(40) NOT NULL, notes VARCHAR(1000) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (batch_id) REFERENCES harvest_batches(id) ON DELETE CASCADE)`);
  await db.query(`CREATE TABLE IF NOT EXISTS batch_water_measurements (
    id INT AUTO_INCREMENT PRIMARY KEY, batch_id INT NOT NULL, parameter_name VARCHAR(30) NOT NULL,
    measurement_value DOUBLE NOT NULL, recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (batch_id) REFERENCES harvest_batches(id) ON DELETE CASCADE,
    INDEX batch_measurement_time (batch_id, recorded_at))`);
  await db.query(`CREATE TABLE IF NOT EXISTS recommendation_history (
    id INT AUTO_INCREMENT PRIMARY KEY, owner_user_id INT NOT NULL, batch_id INT NOT NULL DEFAULT 0,
    source_kind VARCHAR(20) NOT NULL, source_id INT NOT NULL, parameter_name VARCHAR(30) NOT NULL,
    fishpen_name VARCHAR(100) NULL, device_id INT NULL, severity VARCHAR(20) NOT NULL,
    payload JSON NOT NULL, recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, acknowledged_at TIMESTAMP NULL,
    UNIQUE KEY recommendation_source (owner_user_id, batch_id, source_kind, source_id, parameter_name),
    INDEX recommendation_owner_time (owner_user_id, recorded_at),
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE)`);
  await db.query(`CREATE TABLE IF NOT EXISTS planning_sms_log (
    id INT AUTO_INCREMENT PRIMARY KEY, owner_user_id INT NOT NULL, send_day DATE NOT NULL,
    kind VARCHAR(30) NOT NULL, status VARCHAR(20) NOT NULL, error_message VARCHAR(500) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY daily_planning_sms (owner_user_id, send_day))`);
}
