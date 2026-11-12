import type { Pool } from 'mysql2/promise';

export async function migrateFishpenSms(db: Pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS sms_fishpens (
    id INT AUTO_INCREMENT PRIMARY KEY, owner_user_id INT NOT NULL,
    name VARCHAR(100) NOT NULL, device_id INT NULL UNIQUE,
    owner_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    caretaker_phone VARCHAR(20) NULL, caretaker_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX (owner_user_id)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS sms_water_state (
    fishpen_id INT NOT NULL, parameter_name VARCHAR(30) NOT NULL,
    signature VARCHAR(40) NOT NULL, generation INT NOT NULL DEFAULT 1,
    measured_at DATETIME(3) NOT NULL,
    PRIMARY KEY (fishpen_id, parameter_name)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS sms_water_attempts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, fishpen_id INT NOT NULL,
    owner_user_id INT NOT NULL, fishpen_name VARCHAR(100) NOT NULL,
    device_id INT NULL, source_id BIGINT NOT NULL, source_kind VARCHAR(20) NOT NULL,
    recipient_type VARCHAR(15) NOT NULL, recipient_phone VARCHAR(20) NOT NULL,
    parameter_name VARCHAR(30) NOT NULL, severity VARCHAR(15) NOT NULL,
    generation INT NOT NULL, reading_value DOUBLE NOT NULL,
    measured_at DATETIME(3) NOT NULL, message VARCHAR(480) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', provider_response VARCHAR(500) NULL,
    provider_message_id VARCHAR(150) NULL, provider VARCHAR(30) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, attempted_at DATETIME NULL,
    UNIQUE KEY one_recipient_episode (fishpen_id, parameter_name, generation, recipient_phone),
    INDEX queue_status (status, created_at), INDEX owner_history (owner_user_id, id)
  )`);
  await db.query(`INSERT IGNORE INTO sms_fishpens (owner_user_id, name, device_id)
    SELECT d.owner_user_id, LEFT(d.device_name, 100), d.id FROM sensor_devices d
    JOIN users u ON u.id = d.owner_user_id WHERE d.is_active = 1 AND u.role = 'farmer' AND u.phone <> '+639000000000'`);
}
