import 'dotenv/config';
import bcrypt from 'bcryptjs';
import type { RowDataPacket } from 'mysql2';
import { pool } from './db';
import { verifySharedHardwareBaseline, verifyStartupSchema } from './startupSchema';
import { migrateSharedHardware } from './migrations/sharedHardware';
import { migrateAccountStatus } from './migrations/accountStatus';
import { migrateOwnerFishpen } from './migrations/ownerFishpen';
import { migrateProvisionedOwners } from './migrations/provisionedOwners';
import { migrateAdminWebauthn } from './migrations/adminWebauthn';
import { migratePublicMonitoring } from './migrations/publicMonitoring';
import { migratePartialManual } from './migrations/partialManual';
import { migratePlanning } from './migrations/planning';
import { migrateFishpenSms } from './migrations/fishpenSms';
import { migrateActiveFishSpecies } from './migrations/activeFishSpecies';

// Existing first-time setup and legacy migrations. Never imported by the running API.
type SqlValue = string | number | boolean | null;

async function safeExecute(sql: string, params: SqlValue[] = []) {
  if (!pool) return;
  try {
    await pool.execute(sql, params);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ER_DUP_FIELDNAME" && code !== "ER_DUP_KEYNAME" && code !== "ER_DUP_ENTRY" && code !== "ER_NO_SUCH_TABLE") {
      throw error;
    }
  }
}

async function ensureAdminStorage() {
  if (!pool) return;
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      full_name VARCHAR(100) NOT NULL,
      username VARCHAR(100) UNIQUE,
      phone VARCHAR(20) NOT NULL UNIQUE,
      email VARCHAR(150),
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('farmer','admin') DEFAULT 'farmer',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await safeExecute("ALTER TABLE users ADD COLUMN username VARCHAR(100) NULL");
  await safeExecute("ALTER TABLE users ADD UNIQUE INDEX users_username_unique (username)");
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      setting_key VARCHAR(100) NOT NULL UNIQUE,
      setting_val VARCHAR(255),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sensor_devices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      device_name VARCHAR(100) NOT NULL,
      api_key_hash VARCHAR(255) NOT NULL,
      owner_user_id INT,
      is_active TINYINT(1) DEFAULT 1,
      last_seen_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);
  await safeExecute("ALTER TABLE sensor_devices ADD COLUMN pairing_code_hash VARCHAR(255) NULL");
  await safeExecute("ALTER TABLE sensor_devices ADD COLUMN pairing_expires_at DATETIME NULL");
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sensor_telemetry (
      id INT AUTO_INCREMENT PRIMARY KEY,
      device_id INT NOT NULL,
      owner_user_id INT NULL,
      turbidity_raw INT NOT NULL,
      turbidity_voltage DECIMAL(5,3) NOT NULL,
      turbidity_ntu DECIMAL(8,2) NULL,
      temperature_c DECIMAL(5,2) NULL,
      client_reading_id VARCHAR(80) NULL,
      sampled_at DATETIME NULL,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX sensor_telemetry_device_recorded_index (device_id, recorded_at),
      UNIQUE KEY sensor_device_reading_unique (device_id, client_reading_id),
      FOREIGN KEY (device_id) REFERENCES sensor_devices(id) ON DELETE CASCADE
    )
  `);
  await safeExecute("ALTER TABLE sensor_telemetry ADD COLUMN temperature_c DECIMAL(5,2) NULL");
  await safeExecute("ALTER TABLE sensor_telemetry ADD COLUMN client_reading_id VARCHAR(80) NULL");
  await safeExecute("ALTER TABLE sensor_telemetry ADD COLUMN sampled_at DATETIME NULL");
  await safeExecute("ALTER TABLE sensor_telemetry ADD COLUMN water_contact_confirmed BOOLEAN NOT NULL DEFAULT FALSE");
  await safeExecute("ALTER TABLE sensor_telemetry ADD UNIQUE KEY sensor_device_reading_unique (device_id, client_reading_id)");
  const [ownerColumns] = await pool.execute<RowDataPacket[]>(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensor_telemetry' AND COLUMN_NAME = 'owner_user_id' LIMIT 1"
  );
  if (!ownerColumns.length) {
    await pool.execute("ALTER TABLE sensor_telemetry ADD COLUMN owner_user_id INT NULL");
    await pool.execute(`UPDATE sensor_telemetry t INNER JOIN sensor_devices d ON d.id = t.device_id
      SET t.owner_user_id = d.owner_user_id WHERE t.owner_user_id IS NULL`);
  }
  await safeExecute("ALTER TABLE sensor_telemetry ADD INDEX sensor_owner_recorded_index (owner_user_id, recorded_at)");
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS harvest_batches (
      id INT AUTO_INCREMENT PRIMARY KEY,
      owner_user_id INT NOT NULL,
      species VARCHAR(100) NOT NULL,
      stocking_date DATE NOT NULL,
      stocked_count INT NOT NULL,
      target_harvest_date DATE NOT NULL,
      actual_harvest_date DATE NULL,
      harvested_kg DECIMAL(10,2) NULL,
      selling_price DECIMAL(10,2) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX harvest_owner_date_index (owner_user_id, target_harvest_date)
    )
  `);
  await safeExecute("ALTER TABLE harvest_batches ADD COLUMN fishpen_name VARCHAR(100) NULL");
  await safeExecute("ALTER TABLE harvest_batches ADD COLUMN target_weight_g DECIMAL(10,2) NULL");
  await safeExecute("ALTER TABLE harvest_batches ADD COLUMN reminder_sms TINYINT(1) NOT NULL DEFAULT 0");
  await pool.execute(`CREATE TABLE IF NOT EXISTS harvest_samples (
    id INT AUTO_INCREMENT PRIMARY KEY, batch_id INT NOT NULL, sampled_at DATE NOT NULL,
    sample_size INT NOT NULL, average_weight_g DECIMAL(10,2) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (batch_id) REFERENCES harvest_batches(id) ON DELETE CASCADE,
    INDEX (batch_id, sampled_at)
  )`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS harvest_mortalities (
    id INT AUTO_INCREMENT PRIMARY KEY, batch_id INT NOT NULL, mortality_date DATE NOT NULL,
    dead_count INT NOT NULL, notes VARCHAR(500) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (batch_id) REFERENCES harvest_batches(id) ON DELETE CASCADE,
    INDEX (batch_id, mortality_date)
  )`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS harvest_events (
    id INT AUTO_INCREMENT PRIMARY KEY, batch_id INT NOT NULL,
    harvest_type ENUM('partial','complete') NOT NULL, harvest_date DATE NOT NULL,
    fish_count INT NULL, weight_kg DECIMAL(10,2) NOT NULL,
    price_per_kg DECIMAL(10,2) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (batch_id) REFERENCES harvest_batches(id) ON DELETE CASCADE,
    INDEX (batch_id, harvest_date)
  )`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS harvest_reminder_log (
    id INT AUTO_INCREMENT PRIMARY KEY, batch_id INT NOT NULL,
    reminder_day INT NOT NULL, target_date DATE NOT NULL,
    sms_status ENUM('sent','failed') NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY harvest_reminder_unique (batch_id, reminder_day, target_date),
    FOREIGN KEY (batch_id) REFERENCES harvest_batches(id) ON DELETE CASCADE
  )`);
  await safeExecute("ALTER TABLE sensor_telemetry ADD COLUMN ph DECIMAL(4,2) NULL");
  await safeExecute("ALTER TABLE alerts ADD COLUMN sms_status ENUM('sent','failed','skipped') DEFAULT 'skipped'");
  await safeExecute("ALTER TABLE alerts ADD COLUMN sms_error TEXT");
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT,
      action VARCHAR(100) NOT NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);
  await safeExecute("ALTER TABLE users MODIFY role ENUM('user','farmer','admin') DEFAULT 'farmer'");
  await pool.execute("UPDATE users SET role = 'farmer' WHERE role = 'user'");
  await safeExecute("ALTER TABLE users MODIFY role ENUM('farmer','admin') DEFAULT 'farmer'");
  await pool.execute(
    `INSERT INTO admin_settings (setting_key, setting_val)
     VALUES ('admin_pin', ?)
     ON DUPLICATE KEY UPDATE setting_val = setting_val`,
    [process.env.ADMIN_PIN || ""]
  );

  const [admins] = await pool.execute<RowDataPacket[]>("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (!admins.length) {
    if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_PIN || !process.env.ADMIN_PHONE || !process.env.ADMIN_USERNAME || process.env.ADMIN_PASSWORD === 'admin2024' || process.env.ADMIN_PIN === 'admin2024') {
      throw new Error('No administrator exists. Explicit ADMIN_USERNAME, ADMIN_PHONE, ADMIN_PASSWORD and ADMIN_PIN are required for provisioning.');
    }
    const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
    await pool.execute(
      `INSERT INTO users (full_name, username, phone, email, password_hash, role)
       VALUES (?, ?, ?, ?, ?, 'admin')`,
      [
        process.env.ADMIN_FULL_NAME || "System Administrator",
        process.env.ADMIN_USERNAME || "admin",
        process.env.ADMIN_PHONE || "+639999999999",
        process.env.ADMIN_EMAIL || "admin@pondsense.local",
        passwordHash
      ]
    );
  }

}

if (!pool || process.env.NODE_ENV === 'production' ||
    !['localhost', '127.0.0.1', '::1'].includes(process.env.MYSQL_HOST ?? '')) {
  throw new Error('Database preparation is only available for a configured local development database.');
}

try {
  await ensureAdminStorage();
  await migrateAccountStatus(pool);
  await migrateAdminWebauthn(pool);
  await migratePublicMonitoring(pool);
  await migratePartialManual(pool);
  await migratePlanning(pool);
  await migrateFishpenSms(pool);
  await migrateOwnerFishpen(pool);
  await migrateProvisionedOwners(pool);
  await migrateActiveFishSpecies(pool);
  if (process.argv.includes('--pre-shared-hardware')) {
    await verifySharedHardwareBaseline(pool);
    console.log('Local pre-release baseline prepared. Shared hardware migration was not applied.');
  } else {
    await migrateSharedHardware(pool);
    await verifyStartupSchema(pool);
    console.log('Local database preparation complete.');
  }
} finally {
  await pool.end();
}
