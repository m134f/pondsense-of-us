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
  is_active TINYINT(1) DEFAULT 1,
  last_seen_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
);

DELETE FROM fish_species
WHERE name = 'Rainbow Trout' OR scientific_name = 'Oncorhynchus mykiss';

INSERT INTO fish_species
  (name, scientific_name, optimal_ph_min, optimal_ph_max,
   optimal_temp_min, optimal_temp_max,
   optimal_do_min, optimal_do_max,
   optimal_turb_min, optimal_turb_max,
   max_ammonia, market_value, harvest_months, category, description)
VALUES
  ('Tilapia','Oreochromis niloticus',6.5,8.5,25,32,5,8,25,100,0.05,'High','6-8 months','Freshwater','Hardy, fast-growing freshwater fish ideal for warm climates.'),
  ('Catfish','Clarias batrachus',6.0,8.0,25,32,4,8,20,150,0.08,'Medium','5-7 months','Freshwater','Tolerant of low oxygen; good for lake-cage farming.'),
  ('Common Carp','Cyprinus carpio',6.5,8.5,20,28,5,8,25,100,0.05,'Medium','8-12 months','Freshwater','Adaptable species; popular in Laguna de Bay farming.'),
  ('Milkfish (Bangus)','Chanos chanos',7.0,8.5,26,32,4,8,20,100,0.06,'High','6-8 months','Brackish','National fish of the Philippines; thrives near Laguna Lake.'),
  ('Grass Carp','Ctenopharyngodon idella',6.5,8.5,20,30,5,8,20,100,0.05,'High','10-14 months','Freshwater','Feeds on aquatic vegetation; good for lake conditions.'),
  ('Mamali','Hypophthalmichthys nobilis',6.5,8.5,22,30,4,8,20,120,0.05,'Medium','8-12 months','Freshwater','Bighead carp suited to warm freshwater ponds and natural plankton feeding.'),
  ('Snakehead','Channa striata',6.0,8.0,24,32,3,8,20,150,0.10,'High','8-12 months','Freshwater','Highly tolerant; popular in local markets.'),
  ('Red Tilapia','Oreochromis sp. hybrid',6.5,8.5,25,32,5,8,25,100,0.05,'High','5-7 months','Freshwater','Premium market variant of Tilapia; high demand.')
ON DUPLICATE KEY UPDATE name = VALUES(name);

INSERT INTO admin_settings (setting_key, setting_val)
VALUES ('admin_pin', 'admin2024')
ON DUPLICATE KEY UPDATE setting_val = setting_val;

INSERT INTO users (full_name, phone, email, password_hash, role)
VALUES ('Guest Mode', '+639000000000', NULL, 'guest-demo-account', 'farmer')
ON DUPLICATE KEY UPDATE full_name = VALUES(full_name);
