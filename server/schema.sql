CREATE DATABASE IF NOT EXISTS pondsense;
USE pondsense;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  username VARCHAR(100) UNIQUE,
  phone VARCHAR(20) NOT NULL UNIQUE,
  email VARCHAR(150),
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('farmer','admin') DEFAULT 'farmer',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS water_readings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  input_mode ENUM('manual','sensor') DEFAULT 'manual',
  ph DECIMAL(4,2) NOT NULL,
  temperature DECIMAL(5,2) NOT NULL,
  turbidity DECIMAL(8,2) NOT NULL,
  ammonia DECIMAL(6,4) NOT NULL,
  dissolved_oxygen DECIMAL(5,2) NOT NULL,
  best_fish VARCHAR(100),
  best_score INT,
  confidence ENUM('High','Medium','Low'),
  status ENUM('Safe','Warning','Critical') DEFAULT 'Safe',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alerts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reading_id INT NOT NULL,
  user_id INT NOT NULL,
  alert_type VARCHAR(100),
  message TEXT,
  severity ENUM('warning','critical'),
  sms_sent TINYINT(1) DEFAULT 0,
  sms_status ENUM('sent','failed','skipped') DEFAULT 'skipped',
  sms_error TEXT,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reading_id) REFERENCES water_readings(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admin_id INT,
  action VARCHAR(100) NOT NULL,
  details TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS corrective_action_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reading_id INT NOT NULL,
  user_id INT NOT NULL,
  action_taken TEXT NOT NULL,
  result_notes TEXT,
  logged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reading_id) REFERENCES water_readings(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fish_species (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  scientific_name VARCHAR(150),
  optimal_ph_min DECIMAL(4,2),
  optimal_ph_max DECIMAL(4,2),
  optimal_temp_min DECIMAL(5,2),
  optimal_temp_max DECIMAL(5,2),
  optimal_do_min DECIMAL(5,2),
  optimal_do_max DECIMAL(5,2),
  optimal_turb_min DECIMAL(8,2),
  optimal_turb_max DECIMAL(8,2),
  max_ammonia DECIMAL(6,4),
  market_value ENUM('Low','Medium','High','Very High'),
  harvest_months VARCHAR(50),
  category ENUM('Freshwater','Brackish','Saltwater'),
  description TEXT
);

CREATE TABLE IF NOT EXISTS admin_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(100) NOT NULL UNIQUE,
  setting_val VARCHAR(255),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sensor_devices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  device_name VARCHAR(100) NOT NULL,
  api_key_hash VARCHAR(255) NOT NULL,
  owner_user_id INT,
  pairing_code_hash VARCHAR(255),
  pairing_expires_at DATETIME,
  is_active TINYINT(1) DEFAULT 1,
  last_seen_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sensor_telemetry (
  id INT AUTO_INCREMENT PRIMARY KEY,
  device_id INT NOT NULL,
  owner_user_id INT NULL,
  turbidity_raw INT NOT NULL,
  turbidity_voltage DECIMAL(5,3) NOT NULL,
  turbidity_ntu DECIMAL(8,2) NULL,
  temperature_c DECIMAL(5,2) NULL,
  ph DECIMAL(4,2) NULL,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX sensor_telemetry_device_recorded_index (device_id, recorded_at),
  INDEX sensor_owner_recorded_index (owner_user_id, recorded_at),
  FOREIGN KEY (device_id) REFERENCES sensor_devices(id) ON DELETE CASCADE
);

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
  fishpen_name VARCHAR(100) NULL,
  target_weight_g DECIMAL(10,2) NULL,
  reminder_sms TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX harvest_owner_date_index (owner_user_id, target_harvest_date)
);

CREATE TABLE IF NOT EXISTS harvest_samples (
  id INT AUTO_INCREMENT PRIMARY KEY, batch_id INT NOT NULL,
  sampled_at DATE NOT NULL, sample_size INT NOT NULL,
  average_weight_g DECIMAL(10,2) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES harvest_batches(id) ON DELETE CASCADE,
  INDEX (batch_id, sampled_at)
);

CREATE TABLE IF NOT EXISTS harvest_mortalities (
  id INT AUTO_INCREMENT PRIMARY KEY, batch_id INT NOT NULL,
  mortality_date DATE NOT NULL, dead_count INT NOT NULL,
  notes VARCHAR(500) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES harvest_batches(id) ON DELETE CASCADE,
  INDEX (batch_id, mortality_date)
);

CREATE TABLE IF NOT EXISTS harvest_events (
  id INT AUTO_INCREMENT PRIMARY KEY, batch_id INT NOT NULL,
  harvest_type ENUM('partial','complete') NOT NULL,
  harvest_date DATE NOT NULL, fish_count INT NULL,
  weight_kg DECIMAL(10,2) NOT NULL, price_per_kg DECIMAL(10,2) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES harvest_batches(id) ON DELETE CASCADE,
  INDEX (batch_id, harvest_date)
);

CREATE TABLE IF NOT EXISTS harvest_reminder_log (
  id INT AUTO_INCREMENT PRIMARY KEY, batch_id INT NOT NULL,
  reminder_day INT NOT NULL, target_date DATE NOT NULL,
  sms_status ENUM('sent','failed') NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY harvest_reminder_unique (batch_id, reminder_day, target_date),
  FOREIGN KEY (batch_id) REFERENCES harvest_batches(id) ON DELETE CASCADE
);


INSERT INTO fish_species
  (name, scientific_name, optimal_ph_min, optimal_ph_max,
   optimal_temp_min, optimal_temp_max,
   optimal_do_min, optimal_do_max,
   optimal_turb_min, optimal_turb_max,
   max_ammonia, market_value, harvest_months, category, description)
VALUES
  ('Tilapia','Oreochromis niloticus',6.5,8.5,25,32,5,8,25,100,0.05,'High','6-8 months','Freshwater','Hardy, fast-growing freshwater fish ideal for warm climates.'),
  ('Milkfish (Bangus)','Chanos chanos',7.0,8.5,26,32,4,8,20,100,0.06,'High','6-8 months','Brackish','National fish of the Philippines; thrives near Laguna Lake.')
ON DUPLICATE KEY UPDATE name = VALUES(name);

INSERT IGNORE INTO fish_species (name) VALUES ('Mamali');

INSERT INTO admin_settings (setting_key, setting_val)
VALUES ('admin_pin', 'admin2024')
ON DUPLICATE KEY UPDATE setting_val = setting_val;

INSERT INTO users (full_name, phone, email, password_hash, role)
VALUES ('Guest Mode', '+639000000000', NULL, 'guest-demo-account', 'farmer')
ON DUPLICATE KEY UPDATE full_name = VALUES(full_name);
