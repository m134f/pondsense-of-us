import type { Pool, RowDataPacket } from 'mysql2/promise';

export async function migrateFishpenSms(db: Pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS sms_fishpens (
    id INT AUTO_INCREMENT PRIMARY KEY, owner_user_id INT NOT NULL,
    name VARCHAR(100) NOT NULL, device_id INT NULL UNIQUE,
    owner_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    caretaker_phone VARCHAR(20) NULL, caretaker_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX (owner_user_id)
  )`);
  const [contacts] = await db.query<RowDataPacket[]>(`SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sms_fishpens' AND COLUMN_NAME = 'owner_alert_phone'`);
  if (!contacts.length) await db.query('ALTER TABLE sms_fishpens ADD COLUMN owner_alert_phone VARCHAR(20) NULL, ALGORITHM=INSTANT');
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
  await db.query(`CREATE TABLE IF NOT EXISTS sms_critical_incidents (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, fishpen_id INT NOT NULL, owner_user_id INT NOT NULL,
    device_id INT NOT NULL, status VARCHAR(12) NOT NULL DEFAULT 'active',
    opened_at DATETIME(3) NOT NULL, resolved_at DATETIME(3) NULL,
    INDEX incident_fishpen_status (fishpen_id, status)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS sms_critical_state (
    fishpen_id INT PRIMARY KEY, owner_user_id INT NOT NULL, device_id INT NOT NULL,
    incident_id BIGINT NULL, last_sampled_at DATETIME(3) NULL,
    counts_json JSON NOT NULL, confirmed_json JSON NOT NULL, ever_critical_json JSON NOT NULL,
    values_json JSON NOT NULL, recovery_started_at DATETIME(3) NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS sms_critical_notifications (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, incident_id BIGINT NOT NULL, fishpen_id INT NOT NULL,
    owner_user_id INT NOT NULL, device_id INT NOT NULL, fishpen_name VARCHAR(100) NOT NULL,
    recipient_type VARCHAR(15) NOT NULL, recipient_phone VARCHAR(20) NOT NULL,
    kind VARCHAR(12) NOT NULL, critical_keys VARCHAR(255) NOT NULL,
    source_kind VARCHAR(20) NOT NULL, source_id BIGINT NOT NULL,
    measured_at DATETIME(3) NOT NULL, message VARCHAR(480) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', provider_response VARCHAR(500) NULL,
    provider_message_id VARCHAR(150) NULL, provider VARCHAR(30) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), attempted_at DATETIME(3) NULL,
    UNIQUE KEY one_incident_snapshot_recipient (incident_id, recipient_phone, kind, source_kind, source_id),
    INDEX notification_queue (status, created_at),
    INDEX recipient_budget (recipient_phone, created_at),
    INDEX incident_recipient (incident_id, recipient_phone, id)
  )`);
  await db.query("UPDATE sms_water_attempts SET status = 'cancelled', provider_response = 'Superseded by incident-based alert policy.' WHERE status = 'pending'");
  await db.query("UPDATE sms_water_attempts SET status = 'unknown', provider_response = 'Legacy provider submission interrupted; delivery unknown. No automatic retry.' WHERE status = 'sending'");
  await db.query(`INSERT IGNORE INTO sms_fishpens (owner_user_id, name, device_id)
    SELECT d.owner_user_id, LEFT(d.device_name, 100), d.id FROM sensor_devices d
    JOIN users u ON u.id = d.owner_user_id WHERE d.is_active = 1 AND u.role = 'farmer' AND u.phone <> '+639000000000'`);
}
