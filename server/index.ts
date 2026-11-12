import { loadFishCatalog } from "./services/FishCatalog";
import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { hasDbConfig, pool } from "./db";
import { isSmsConfigured, sendSms } from "./sms";
import { clearAuthSession, createAuthSession, requireAdmin, verifyAuthToken, type AuthRequest } from "./auth";
import { DecisionSupportService, type AlertResult } from "./services/DecisionSupportService";
import { migratePlanning } from './migrations/planning';
import { planningRouter } from './routes/planning';
import { archiveRecommendations, planningContext } from './services/PlanningService';
import { sendDailySms } from './services/PlanningSms';
import { migrateFishpenSms } from './migrations/fishpenSms';
import { fishpenSmsRouter } from './routes/fishpenSms';
import { drainWaterSms, queueWaterSms, sensorSmsMeasurements } from './services/FishpenSms';
import { parameters, type Measurements } from '../src/lib/recommendations';

const app = express();
const port = Number(process.env.PORT || 5000);
const guestPhone = "+639000000000";
const decisionSupport = new DecisionSupportService();

type AlertPayload = {
  level?: "safe" | "warning" | "critical";
  title?: string;
  message?: string;
};

type SmsRecipient = {
  phone?: string;
  fullName?: string;
};

type FishThresholdUpdate = {
  optimal_ph_min?: number;
  optimal_ph_max?: number;
  optimal_temp_min?: number;
  optimal_temp_max?: number;
  optimal_do_min?: number;
  optimal_do_max?: number;
  optimal_turb_min?: number;
  optimal_turb_max?: number;
  max_ammonia?: number;
};

const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  process.env.FRONTEND_URL
].filter(Boolean) as string[];

app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || process.env.NODE_ENV !== "production" || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin not allowed by CORS: ${origin}`));
  }
}));
app.use(express.json());
app.use('/api', planningRouter(pool));
app.use('/api', fishpenSmsRouter(pool));

let waterSmsBusy = false;
async function flushWaterSms() {
  if (!pool || waterSmsBusy) return;
  waterSmsBusy = true;
  try { await drainWaterSms(pool); }
  catch { console.error('Water SMS queue temporarily unavailable.'); }
  finally { waterSmsBusy = false; }
}

app.get("/api/health", async (_req, res) => {
  if (!pool) {
    return res.json({
      ok: true,
      name: "PondSense API",
      database: "local-demo-mode"
    });
  }

  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      name: "PondSense API",
      database: hasDbConfig() ? "mysql-connected" : "local-demo-mode"
    });
  } catch (error) {
    console.error("Health database error:", error);
    res.status(503).json({
      ok: false,
      name: "PondSense API",
      database: "mysql-not-reachable"
    });
  }
});

async function getGuestUserId() {
  if (!pool) return null;

  await pool.execute(
    `INSERT INTO users (full_name, phone, email, password_hash, role)
     VALUES ('Guest Mode', ?, NULL, 'guest-demo-account', 'farmer')
     ON DUPLICATE KEY UPDATE full_name = VALUES(full_name)`,
    [guestPhone]
  );

  const [rows] = await pool.execute<RowDataPacket[]>("SELECT id FROM users WHERE phone = ? LIMIT 1", [guestPhone]);
  return Number(rows[0]?.id);
}

function normalizeStatus(status: unknown) {
  if (status === "critical" || status === "Critical") return "Critical";
  if (status === "warning" || status === "Warning") return "Warning";
  return "Safe";
}

function normalizeRole(role: unknown) {
  return role === "admin" ? "admin" : "farmer";
}

function numberFromBody(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function validateReadingPayload(reading: Record<string, unknown>) {
  const ph = numberFromBody(reading.ph);
  const temperature = numberFromBody(reading.temperature);
  const turbidity = numberFromBody(reading.turbidity);
  const ammonia = numberFromBody(reading.ammonia);
  const dissolvedOxygen = numberFromBody(reading.dissolvedOxygen ?? reading.dissolved_oxygen);

  if (ph === null || ph < 0 || ph > 14) return { error: "Invalid pH value.", values: null };
  if (temperature === null || temperature < 0 || temperature > 60) return { error: "Invalid temperature value.", values: null };
  if (turbidity === null || turbidity < 0 || turbidity > 1000) return { error: "Invalid turbidity value.", values: null };
  if (ammonia === null || ammonia < 0 || ammonia > 10) return { error: "Invalid ammonia value.", values: null };
  if (dissolvedOxygen === null || dissolvedOxygen < 0 || dissolvedOxygen > 30) {
    return { error: "Invalid dissolved oxygen value.", values: null };
  }

  return { values: { ph, temperature, turbidity, ammonia, dissolvedOxygen }, error: null };
}

function validateTurbidityTelemetry(payload: Record<string, unknown>) {
  const rawValue = numberFromBody(payload.rawValue ?? payload.raw_value);
  const voltage = numberFromBody(payload.voltage);
  const turbidityNtu = payload.turbidityNtu ?? payload.turbidity_ntu ?? payload.ntu;
  const ntu = turbidityNtu === undefined || turbidityNtu === null || turbidityNtu === ""
    ? null
    : numberFromBody(turbidityNtu);
  const suppliedTemperature = payload.temperatureC ?? payload.temperature_c ?? payload.temperature;
  const temperatureC = suppliedTemperature === undefined || suppliedTemperature === null || suppliedTemperature === ""
    ? null : numberFromBody(suppliedTemperature);
  const suppliedPh = payload.ph ?? payload.phValue ?? payload.ph_value;
  const ph = suppliedPh === undefined || suppliedPh === null || suppliedPh === "" ? null : numberFromBody(suppliedPh);

  if (rawValue === null || rawValue < 0 || rawValue > 4095) {
    return { error: "Raw turbidity value must be between 0 and 4095.", values: null };
  }
  if (voltage === null || voltage < 0 || voltage > 3.3) {
    return { error: "Turbidity signal voltage must be between 0 and 3.3V.", values: null };
  }
  if (ntu === null && turbidityNtu !== undefined && turbidityNtu !== null && turbidityNtu !== "") {
    return { error: "Invalid turbidity NTU value.", values: null };
  }
  if (ntu !== null && (ntu < 0 || ntu > 1000)) {
    return { error: "Turbidity NTU value must be between 0 and 1000.", values: null };
  }
  if (suppliedTemperature !== undefined && suppliedTemperature !== null && temperatureC === null) {
    return { error: "Invalid temperature value.", values: null };
  }
  if (temperatureC !== null && (temperatureC < -10 || temperatureC > 60)) {
    return { error: "Temperature must be between -10 and 60 C.", values: null };
  }
  if (suppliedPh !== undefined && suppliedPh !== null && ph === null) return { error: "Invalid pH value.", values: null };
  if (ph !== null && (ph < 0 || ph > 14)) return { error: "pH must be between 0 and 14.", values: null };

  return { values: { rawValue: Math.round(rawValue), voltage, ntu, temperatureC, ph }, error: null };
}

function adminPublicUser(row: RowDataPacket) {
  return {
    id: row.id,
    fullName: row.full_name,
    username: row.username,
    email: row.email,
    phone: row.phone,
    role: normalizeRole(row.role),
    createdAt: row.created_at
  };
}

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
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX sensor_telemetry_device_recorded_index (device_id, recorded_at),
      FOREIGN KEY (device_id) REFERENCES sensor_devices(id) ON DELETE CASCADE
    )
  `);
  await safeExecute("ALTER TABLE sensor_telemetry ADD COLUMN temperature_c DECIMAL(5,2) NULL");
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
    [process.env.ADMIN_PIN || "admin2024"]
  );

  const [admins] = await pool.execute<RowDataPacket[]>("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (!admins.length) {
    const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || "admin2024", 10);
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

function formatAlertSms(reading: Record<string, unknown>, alerts: AlertPayload[]) {
  const critical = alerts.find((alert) => alert.level === "critical") || alerts[0];
  const title = critical?.title || "Water Quality Alert";
  return [
    `PondSense ALERT: ${title}`,
    `Status: ${normalizeStatus(reading.status)}`,
    `pH ${reading.ph}, Temp ${reading.temperature}C, Turb ${reading.turbidity} NTU, NH3 ${reading.ammonia}, DO ${reading.dissolvedOxygen}`,
    critical?.message || "Please check the pond immediately."
  ].join("\n");
}

async function hasSentWaterAlertToday(userId: number) {
  if (!pool) return false;
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id
     FROM alerts
     WHERE user_id = ?
       AND sms_sent = 1
       AND DATE(sent_at) = CURDATE()
     LIMIT 1`,
    [userId]
  );
  return rows.length > 0;
}

async function logAdminAction(req: AuthRequest, action: string, details: string) {
  if (!pool) return;
  await pool.execute(
    "INSERT INTO admin_audit_logs (admin_id, action, details) VALUES (?, ?, ?)",
    [req.auth?.sub ?? null, action, details]
  );
}

async function authenticateSensorDevice(apiKey: string) {
  if (!pool || !apiKey) return null;

  const [devices] = await pool.execute<RowDataPacket[]>(
    "SELECT id, device_name, api_key_hash, owner_user_id FROM sensor_devices WHERE is_active = 1"
  );

  for (const device of devices) {
    const valid = await bcrypt.compare(apiKey, String(device.api_key_hash));
    if (valid) {
      await pool.execute("UPDATE sensor_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?", [device.id]);
      return {
        id: Number(device.id),
        deviceName: String(device.device_name),
        ownerUserId: device.owner_user_id ? Number(device.owner_user_id) : null
      };
    }
  }

  return null;
}

async function logReadingAlerts(readingId: number, userId: number, alerts: Array<AlertPayload | AlertResult>, smsResult: { ok: boolean; message: string }, shouldSendSms: boolean) {
  if (!pool) return;

  for (const alert of alerts) {
    if (alert.level !== "warning" && alert.level !== "critical") continue;
    const smsStatus = smsResult.ok ? "sent" : shouldSendSms ? "failed" : "skipped";
    await pool.execute(
      `INSERT INTO alerts (reading_id, user_id, alert_type, message, severity, sms_sent, sms_status, sms_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        readingId,
        userId,
        alert.title ?? "Water Quality Alert",
        alert.message ?? "",
        alert.level,
        smsResult.ok ? 1 : 0,
        smsStatus,
        smsResult.ok ? null : smsResult.message
      ]
    );
  }
}

async function sendAccountSms(user: SmsRecipient, action: "register" | "login") {
  if (!user.phone) return { ok: false, configured: isSmsConfigured(), message: "No phone number." };
  const greeting = user.fullName ? `Hi ${user.fullName}` : "Hi farmer";
  const message =
    action === "register"
      ? `${greeting}, your PondSense of Us account has been created. You will receive alerts for critical pond conditions.`
      : `${greeting}, login detected on PondSense of Us.`;
  return sendSms(user.phone, message);
}

app.post("/api/register", async (req, res) => {
  const { fullName, phone, email, password } = req.body ?? {};
  if (!fullName || !/^(\+639)\d{9}$/.test(phone) || !password) {
    return res.status(400).json({ message: "Full name, +639 phone number, and password are required." });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  if (!pool) {
    return res.json({ id: Date.now(), fullName, phone, email: email ?? null, role: "farmer", demo: true });
  }

  try {
    const [result] = await pool.execute<ResultSetHeader>(
      "INSERT INTO users (full_name, phone, email, password_hash, role) VALUES (?, ?, ?, ?, 'farmer')",
      [fullName, phone, email ?? null, passwordHash]
    );
    res.json({ id: result.insertId, fullName, phone, email: email ?? null, role: "farmer" });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Phone number is already registered." });
    }
    console.error("Register database error:", error);
    res.status(503).json({ message: "Database is not ready. Check XAMPP MySQL and schema import." });
  }
});

app.post("/api/login", async (req, res) => {
  const { phone, password } = req.body ?? {};
  if (!/^(\+639)\d{9}$/.test(phone) || !password) {
    return res.status(400).json({ message: "Use Philippine phone format +639XXXXXXXXX and enter your password." });
  }

  if (!pool) {
    return res.status(503).json({ message: "Database login is unavailable. Register/login works locally only in demo mode." });
  }

  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      "SELECT id, full_name, phone, password_hash, role, created_at FROM users WHERE phone = ? AND role = 'farmer' LIMIT 1",
      [phone]
    );
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ message: "No account found for this phone number. Please register first." });
    }

    const valid = await bcrypt.compare(password, String(user.password_hash));
    if (!valid) {
      return res.status(401).json({ message: "Incorrect password. Please try again." });
    }

    createAuthSession(res, Number(user.id), normalizeRole(user.role));
    res.json({
      id: user.id,
      fullName: user.full_name,
      phone: user.phone,
      role: normalizeRole(user.role),
      createdAt: user.created_at
    });
  } catch (error) {
    console.error("Login database error:", error);
    res.status(503).json({ message: "Database is not ready. Check XAMPP MySQL and schema import." });
  }
});

app.get("/api/session", async (req, res) => {
  const auth = verifyAuthToken(req);
  if (!auth || !pool) return res.status(401).json({ message: "Login required." });
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT id, full_name, username, email, phone, role, created_at FROM users WHERE id = ? LIMIT 1",
    [auth.sub]
  );
  if (!rows.length) return res.status(401).json({ message: "Login required." });
  res.json({ user: adminPublicUser(rows[0]) });
});

app.get("/api/readings", async (req, res) => {
  const auth = verifyAuthToken(req);
  if (!auth || !pool) return res.status(401).json({ message: "Login required." });

  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id, recorded_at, ph, temperature, dissolved_oxygen, turbidity, ammonia, best_fish, best_score
     FROM water_readings
     WHERE user_id = ?
     ORDER BY recorded_at DESC
     LIMIT 10`,
    [auth.sub]
  );

  res.json({
    sessions: rows.map((row) => ({
      id: String(row.id),
      timestamp: row.recorded_at ? new Date(row.recorded_at).toLocaleString("en-PH") : "",
      ph: Number(row.ph),
      temperature: Number(row.temperature),
      dissolvedOxygen: Number(row.dissolved_oxygen),
      turbidity: Number(row.turbidity),
      ammonia: Number(row.ammonia),
      bestFish: String(row.best_fish || ""),
      score: Number(row.best_score || 0)
    }))
  });
});

app.post("/api/logout", (_req, res) => {
  clearAuthSession(res);
  res.json({ ok: true });
});

app.post("/api/readings", async (req, res) => {
  const reading = req.body ?? {};
  const validation = validateReadingPayload(reading);
  if (validation.error || !validation.values) return res.status(400).json({ message: validation.error });
  if (!pool) {
    return res.json({ saved: true, demo: true, reading });
  }

  try {
    const fallbackGuestId = await getGuestUserId();
    const auth = verifyAuthToken(req);
    const numericUserId = auth?.sub;
    const isRegisteredUser = Boolean(auth);
    const userId = auth ? auth.sub : fallbackGuestId;
    if (!userId) return res.status(500).json({ message: "Unable to resolve user for reading." });

    const analysis = decisionSupport.analyze(validation.values, (await loadFishCatalog(pool)).profiles);
    const status = analysis.status;
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO water_readings
        (user_id, input_mode, ph, temperature, turbidity, ammonia, dissolved_oxygen,
         best_fish, best_score, confidence, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        reading.inputMode ?? "manual",
        validation.values.ph,
        validation.values.temperature,
        validation.values.turbidity,
        validation.values.ammonia,
        validation.values.dissolvedOxygen,
        analysis.bestFish,
        analysis.bestScore,
        analysis.confidence,
        status
      ]
    );

    const readingId = result.insertId;
    const alerts = analysis.alerts;
    let smsResult = { configured: isSmsConfigured(), ok: false, message: "SMS alerts require a registered account." };
    const shouldSendSms = isRegisteredUser && reading.measurementsConfirmed === true && Number.isSafeInteger(reading.fishpenId);
    if (shouldSendSms) {
      const measurements: Measurements = Object.fromEntries(parameters.map(parameter => [parameter, {
        value: validation.values![parameter], source: 'manual', recordedAt: typeof reading.sampledAt === 'string' ? reading.sampledAt : null
      }]));
      await queueWaterSms(pool, { owner: userId, fishpenId: reading.fishpenId, sourceId: readingId, sourceKind: 'manual', measurements })
        .catch(() => console.error('Manual water alert could not be queued. Reading was saved.'));
      void flushWaterSms();
      smsResult.message = 'Water reading saved. Eligible alerts are processed using your fishpen SMS settings; delivery is not yet confirmed.';
    } else if (isRegisteredUser) {
      smsResult.message = 'Water reading saved. Select a fishpen in SMS Alert Settings and confirm actual measurements to enable water alerts.';
    }

    await logReadingAlerts(readingId, userId, alerts, smsResult, shouldSendSms);
    if (isRegisteredUser) await archiveRecommendations(pool, userId, 'manual', readingId).catch(error => console.error('Recommendation archive:', error));

    res.json({ saved: true, readingId, userId, sms: smsResult });
  } catch (error) {
    console.error("Reading database error:", error);
    res.status(503).json({ message: "Database is not ready. Check XAMPP MySQL and schema import." });
  }
});

app.get("/api/admin/devices", requireAdmin, async (_req, res) => {
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT d.id, d.device_name, d.owner_user_id, d.is_active, d.last_seen_at,
            u.full_name AS owner_name,
            (SELECT MAX(t.recorded_at) FROM sensor_telemetry t WHERE t.device_id = d.id) AS last_reading_at
     FROM sensor_devices d LEFT JOIN users u ON u.id = d.owner_user_id ORDER BY d.id DESC`
  );
  res.json({ devices: rows });
});

app.post("/api/admin/devices", requireAdmin, async (req: AuthRequest, res) => {
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const ownerUserId = req.body?.ownerUserId ? Number(req.body.ownerUserId) : null;
  const deviceName = String(req.body?.deviceName || "PondSense ESP32").trim().slice(0, 100);
  if (!deviceName || (ownerUserId !== null && (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1))) return res.status(400).json({ message: "Enter a device name and valid farmer." });
  if (ownerUserId !== null) {
    const [owners] = await pool.execute<RowDataPacket[]>("SELECT id FROM users WHERE id = ? AND role = 'farmer' LIMIT 1", [ownerUserId]);
    if (!owners.length) return res.status(404).json({ message: "Farmer account not found." });
  }
  const apiKey = `ps_${crypto.randomBytes(24).toString("base64url")}`;
  const [result] = await pool.execute<ResultSetHeader>(
    "INSERT INTO sensor_devices (device_name, api_key_hash, owner_user_id) VALUES (?, ?, ?)",
    [deviceName, await bcrypt.hash(apiKey, 10), ownerUserId]
  );
  await logAdminAction(req, "device_created", `Device ${result.insertId} assigned to user ${ownerUserId}`);
  res.status(201).json({ deviceId: result.insertId, apiKey });
});

app.post("/api/admin/devices/:id/pairing-code", requireAdmin, async (req: AuthRequest, res) => {
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const deviceId = Number(req.params.id);
  if (!Number.isSafeInteger(deviceId) || deviceId < 1) return res.status(400).json({ message: "Invalid device." });
  const code = crypto.randomBytes(9).toString("base64url").toUpperCase();
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE sensor_devices SET pairing_code_hash = ?, pairing_expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE)
     WHERE id = ? AND owner_user_id IS NULL AND is_active = 1`,
    [await bcrypt.hash(code, 10), deviceId]);
  if (!result.affectedRows) return res.status(409).json({ message: "Only active, unassigned devices can be paired." });
  await logAdminAction(req, "device_pairing_code_created", `Pairing code issued for device ${deviceId}`);
  res.json({ code, expiresInMinutes: 15 });
});

app.get("/api/sensors/devices", async (req, res) => {
  const auth = verifyAuthToken(req);
  if (!auth) return res.status(401).json({ message: "Login required." });
  if (auth.role !== "farmer") return res.status(403).json({ message: "Farmer account required." });
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT d.id, d.device_name AS deviceName, d.last_seen_at AS lastSeenAt,
            (SELECT MAX(t.recorded_at) FROM sensor_telemetry t WHERE t.device_id = d.id) AS lastReadingAt
     FROM sensor_devices d WHERE d.owner_user_id = ? AND d.is_active = 1 ORDER BY d.id DESC`, [auth.sub]);
  res.json({ devices: rows });
});

const pairingAttempts = new Map<number, { count: number; startedAt: number }>();
app.post("/api/sensors/connect", async (req, res) => {
  const auth = verifyAuthToken(req);
  if (!auth) return res.status(401).json({ message: "Login required." });
  if (auth.role !== "farmer") return res.status(403).json({ message: "Farmer account required." });
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const code = String(req.body?.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{12}$/.test(code)) return res.status(400).json({ message: "Enter the 12-character pairing code from your administrator." });
  const attempt = pairingAttempts.get(auth.sub);
  if (attempt && Date.now() - attempt.startedAt < 15 * 60_000 && attempt.count >= 5) return res.status(429).json({ message: "Too many attempts. Try again later." });
  pairingAttempts.set(auth.sub, attempt && Date.now() - attempt.startedAt < 15 * 60_000
    ? { ...attempt, count: attempt.count + 1 } : { count: 1, startedAt: Date.now() });
  const [devices] = await pool.execute<RowDataPacket[]>(
    `SELECT id, pairing_code_hash FROM sensor_devices
     WHERE owner_user_id IS NULL AND is_active = 1 AND pairing_expires_at > UTC_TIMESTAMP() AND pairing_code_hash IS NOT NULL`);
  for (const device of devices) {
    if (!await bcrypt.compare(code, String(device.pairing_code_hash))) continue;
    const [result] = await pool.execute<ResultSetHeader>(
      `UPDATE sensor_devices SET owner_user_id = ?, pairing_code_hash = NULL, pairing_expires_at = NULL
       WHERE id = ? AND owner_user_id IS NULL AND pairing_expires_at > UTC_TIMESTAMP()`, [auth.sub, device.id]);
    if (!result.affectedRows) break;
    pairingAttempts.delete(auth.sub);
    return res.json({ connected: true, deviceId: device.id });
  }
  res.status(400).json({ message: "Pairing code is invalid or expired. Ask your administrator for a new code." });
});

app.patch("/api/admin/devices/:id", requireAdmin, async (req: AuthRequest, res) => {
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const deviceId = Number(req.params.id);
  const ownerUserId = Number(req.body?.ownerUserId);
  if (!Number.isSafeInteger(deviceId) || !Number.isSafeInteger(ownerUserId) || ownerUserId < 1) return res.status(400).json({ message: "Invalid device or farmer." });
  const [owners] = await pool.execute<RowDataPacket[]>("SELECT id FROM users WHERE id = ? AND role = 'farmer' LIMIT 1", [ownerUserId]);
  if (!owners.length) return res.status(404).json({ message: "Farmer account not found." });
  const [updated] = await pool.execute<ResultSetHeader>("UPDATE sensor_devices SET owner_user_id = ? WHERE id = ?", [ownerUserId, deviceId]);
  if (!updated.affectedRows) return res.status(404).json({ message: "Device not found." });
  await logAdminAction(req, "device_assigned", `Device ${deviceId} assigned to user ${ownerUserId}`);
  res.json({ assigned: true });
});

app.get("/api/sensors/latest", async (req, res) => {
  const auth = verifyAuthToken(req);
  if (!auth || !pool) return res.status(401).json({ message: "Login required." });

  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT telemetry.id, telemetry.device_id, telemetry.turbidity_raw, telemetry.turbidity_voltage, telemetry.turbidity_ntu,
              telemetry.temperature_c, telemetry.ph, telemetry.recorded_at, device.device_name
       FROM sensor_telemetry AS telemetry
       INNER JOIN sensor_devices AS device ON device.id = telemetry.device_id
       WHERE telemetry.owner_user_id = ?
       ORDER BY telemetry.id DESC
       LIMIT 1`,
      [auth.sub]
    );

    const latest = rows[0];
    if (!latest) return res.json({ telemetry: null });

    res.json({
      telemetry: {
        deviceName: String(latest.device_name),
        id: Number(latest.id),
        deviceId: Number(latest.device_id),
        rawValue: Number(latest.turbidity_raw),
        voltage: Number(latest.turbidity_voltage),
        turbidityNtu: latest.turbidity_ntu === null ? null : Number(latest.turbidity_ntu),
        temperatureC: latest.temperature_c === null ? null : Number(latest.temperature_c),
        ph: latest.ph === null ? null : Number(latest.ph),
        recordedAt: latest.recorded_at
      }
    });
  } catch (error) {
    console.error("Latest sensor telemetry error:", error);
    res.status(503).json({ message: "Unable to load the latest sensor reading." });
  }
});

app.get("/api/sensors/trend", async (req, res) => {
  const auth = verifyAuthToken(req);
  if (!auth || !pool) return res.status(401).json({ message: "Login required." });
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT telemetry.id, telemetry.device_id, telemetry.turbidity_raw, telemetry.turbidity_voltage, telemetry.turbidity_ntu,
              telemetry.temperature_c, telemetry.ph, telemetry.recorded_at, device.device_name
       FROM sensor_telemetry AS telemetry
       INNER JOIN sensor_devices AS device ON device.id = telemetry.device_id
       WHERE telemetry.owner_user_id = ?
       ORDER BY telemetry.id DESC LIMIT 60`,
      [auth.sub]
    );
    res.json({ readings: rows.reverse().map((row) => ({
      deviceName: String(row.device_name),
      id: Number(row.id),
      deviceId: Number(row.device_id),
      rawValue: Number(row.turbidity_raw),
      voltage: Number(row.turbidity_voltage),
      turbidityNtu: row.turbidity_ntu === null ? null : Number(row.turbidity_ntu),
      temperatureC: row.temperature_c === null ? null : Number(row.temperature_c),
      ph: row.ph === null ? null : Number(row.ph),
      recordedAt: row.recorded_at
    })) });
  } catch (error) {
    console.error("Sensor trend error:", error);
    res.status(503).json({ message: "Unable to load sensor trend." });
  }
});

app.post(["/api/v1/sensors/turbidity", "/api/v1/sensors/measurements"], async (req, res) => {
  const providedKey = String(req.headers["x-api-key"] || req.headers["x-sensor-key"] || "");
  if (!providedKey) return res.status(401).json({ message: "Sensor API key is required." });
  if (!pool) return res.status(503).json({ message: "Database is required for sensor readings." });

  const telemetry = validateTurbidityTelemetry(req.body ?? {});
  if (telemetry.error || !telemetry.values) return res.status(400).json({ message: telemetry.error });

  try {
    const device = await authenticateSensorDevice(providedKey);
    if (!device) return res.status(401).json({ message: "Invalid or inactive sensor device." });
    if (!device.ownerUserId) return res.status(409).json({ message: "Device has no assigned farmer. Contact the administrator." });

    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO sensor_telemetry (device_id, owner_user_id, turbidity_raw, turbidity_voltage, turbidity_ntu, temperature_c, ph)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [device.id, device.ownerUserId, telemetry.values.rawValue, telemetry.values.voltage, telemetry.values.ntu, telemetry.values.temperatureC, telemetry.values.ph]
    );
    await archiveRecommendations(pool, device.ownerUserId, 'sensor', result.insertId).catch(error => { console.error('Recommendation archive:', error); });
    await queueWaterSms(pool, { owner: device.ownerUserId, deviceId: device.id, sourceId: result.insertId, sourceKind: 'telemetry',
      measurements: sensorSmsMeasurements({ temperature: telemetry.values.temperatureC, ph: telemetry.values.ph, turbidity: telemetry.values.ntu }, req.body)
    }).catch(() => console.error('Water alert could not be queued. Reading was saved.'));
    void flushWaterSms();

    res.status(201).json({
      saved: true,
      telemetryId: result.insertId,
      deviceId: device.id,
      assigned: true,
      recordedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("Turbidity telemetry database error:", error);
    res.status(503).json({ message: "Unable to save the turbidity sensor reading." });
  }
});

function validateHarvest(body: Record<string, unknown>) {
  const species = String(body.species || "").trim().slice(0, 100);
  const fishpenName = String(body.fishpenName || "").trim().slice(0, 100);
  const targetWeightG = body.targetWeightG === null || body.targetWeightG === undefined || body.targetWeightG === "" ? null : Number(body.targetWeightG);
  const reminderSms = body.reminderSms === true;
  const stockingDate = String(body.stockingDate || "");
  const targetHarvestDate = String(body.targetHarvestDate || "");
  const actualHarvestDate = body.actualHarvestDate ? String(body.actualHarvestDate) : null;
  const stockedCount = Number(body.stockedCount);
  const harvestedKg = body.harvestedKg === null || body.harvestedKg === undefined || body.harvestedKg === "" ? null : Number(body.harvestedKg);
  const sellingPrice = body.sellingPrice === null || body.sellingPrice === undefined || body.sellingPrice === "" ? null : Number(body.sellingPrice);
  const dateValid = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (!species || !dateValid(stockingDate) || !dateValid(targetHarvestDate) || targetHarvestDate < stockingDate) return null;
  if (targetWeightG !== null && (!Number.isFinite(targetWeightG) || targetWeightG <= 0 || targetWeightG > 100_000)) return null;
  if (actualHarvestDate && (!dateValid(actualHarvestDate) || actualHarvestDate < stockingDate)) return null;
  if (!Number.isSafeInteger(stockedCount) || stockedCount < 1 || stockedCount > 1_000_000_000) return null;
  if (harvestedKg !== null && (!Number.isFinite(harvestedKg) || harvestedKg < 0 || harvestedKg > 1_000_000_000)) return null;
  if (sellingPrice !== null && (!Number.isFinite(sellingPrice) || sellingPrice < 0 || sellingPrice > 1_000_000_000)) return null;
  if (!actualHarvestDate && (harvestedKg !== null || sellingPrice !== null)) return null;
  if (actualHarvestDate && harvestedKg === null) return null;
  return { species, fishpenName, targetWeightG, reminderSms, stockingDate, stockedCount, targetHarvestDate, actualHarvestDate, harvestedKg, sellingPrice };
}

function validHarvestDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validPositiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= 1_000_000_000;
}

function validNonnegativeMoney(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1_000_000_000;
}

app.get("/api/harvests", async (req, res) => {
  const auth = verifyAuthToken(req);
  if (!auth) return res.status(401).json({ message: "Login required." });
  if (!pool) return res.status(503).json({ message: "Database is required." });
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, species, fishpen_name AS fishpenName, target_weight_g AS targetWeightG,
              reminder_sms AS reminderSms, DATE_FORMAT(stocking_date, '%Y-%m-%d') AS stockingDate, stocked_count AS stockedCount,
              DATE_FORMAT(target_harvest_date, '%Y-%m-%d') AS targetHarvestDate,
              DATE_FORMAT(actual_harvest_date, '%Y-%m-%d') AS actualHarvestDate,
              harvested_kg AS harvestedKg, selling_price AS sellingPrice, notes, sensor_device_id AS sensorDeviceId
       FROM harvest_batches WHERE owner_user_id = ? ORDER BY target_harvest_date ASC, id DESC`, [auth.sub]
    );
    const ids = rows.map((row) => Number(row.id));
    const [samples] = ids.length ? await pool.query<RowDataPacket[]>(
      `SELECT s.id, s.batch_id AS batchId, DATE_FORMAT(s.sampled_at, '%Y-%m-%d') AS sampledAt,
              s.sample_size AS sampleSize, s.average_weight_g AS averageWeightG, s.notes
       FROM harvest_samples s INNER JOIN harvest_batches b ON b.id = s.batch_id
       WHERE b.owner_user_id = ? ORDER BY s.sampled_at DESC, s.id DESC`, [auth.sub]) : [[] as RowDataPacket[]];
    const [mortalities] = ids.length ? await pool.query<RowDataPacket[]>(
      `SELECT m.id, m.batch_id AS batchId, DATE_FORMAT(m.mortality_date, '%Y-%m-%d') AS mortalityDate,
              m.dead_count AS deadCount, m.notes
       FROM harvest_mortalities m INNER JOIN harvest_batches b ON b.id = m.batch_id
       WHERE b.owner_user_id = ? ORDER BY m.mortality_date DESC, m.id DESC`, [auth.sub]) : [[] as RowDataPacket[]];
    const [events] = ids.length ? await pool.query<RowDataPacket[]>(
      `SELECT e.id, e.batch_id AS batchId, e.harvest_type AS harvestType,
              DATE_FORMAT(e.harvest_date, '%Y-%m-%d') AS harvestDate, e.fish_count AS fishCount,
              e.weight_kg AS weightKg, e.price_per_kg AS pricePerKg, e.notes
       FROM harvest_events e INNER JOIN harvest_batches b ON b.id = e.batch_id
       WHERE b.owner_user_id = ? ORDER BY e.harvest_date DESC, e.id DESC`, [auth.sub]) : [[] as RowDataPacket[]];
    const waterContexts = new Map<number, Awaited<ReturnType<typeof planningContext>>>();
    for (const row of rows) waterContexts.set(Number(row.id), await planningContext(pool, auth.sub, Number(row.id)));
    res.json({ harvests: rows.map((row) => ({
      ...row,
      waterContext: waterContexts.get(Number(row.id)),
      stockingDate: String(row.stockingDate).slice(0, 10),
      targetHarvestDate: String(row.targetHarvestDate).slice(0, 10),
      actualHarvestDate: row.actualHarvestDate ? String(row.actualHarvestDate).slice(0, 10) : null,
      samples: samples.filter((item) => Number(item.batchId) === Number(row.id)),
      mortalities: mortalities.filter((item) => Number(item.batchId) === Number(row.id)),
      harvestEvents: events.filter((item) => Number(item.batchId) === Number(row.id))
    })), waterStatus: null });
  } catch (error) {
    console.error("Harvest list error:", error);
    res.status(503).json({ message: "Unable to load harvest records." });
  }
});

app.post("/api/harvests", async (req, res) => {
  const auth = verifyAuthToken(req);
  if (!auth) return res.status(401).json({ message: "Login required." });
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const harvest = validateHarvest(req.body || {});
  if (!harvest) return res.status(400).json({ message: "Check species, dates, stocking count, and harvest values." });
  if (harvest.actualHarvestDate) return res.status(400).json({ message: 'Create the batch first, then confirm its completion using Record Harvest.' });
  const sensorDeviceId = Number(req.body.sensorDeviceId) || null;
  if (sensorDeviceId) {
    const [devices] = await pool.query<RowDataPacket[]>('SELECT id FROM sensor_devices WHERE id = ? AND owner_user_id = ? AND is_active = 1', [sensorDeviceId, auth.sub]);
    if (!devices.length) return res.status(400).json({ message: 'Choose a device assigned to your account.' });
  }
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO harvest_batches (owner_user_id, species, fishpen_name, target_weight_g, reminder_sms, stocking_date, stocked_count, target_harvest_date, actual_harvest_date, harvested_kg, selling_price, notes, sensor_device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [auth.sub, harvest.species, harvest.fishpenName || null, harvest.targetWeightG, harvest.reminderSms, harvest.stockingDate, harvest.stockedCount, harvest.targetHarvestDate, harvest.actualHarvestDate, harvest.harvestedKg, harvest.sellingPrice, String(req.body.notes || '').trim().slice(0, 1000), sensorDeviceId]
  );
  res.status(201).json({ id: result.insertId });
});

app.put("/api/harvests/:id", async (req, res) => {
  const auth = verifyAuthToken(req);
  if (!auth) return res.status(401).json({ message: "Login required." });
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const id = Number(req.params.id);
  const harvest = validateHarvest(req.body || {});
  if (!Number.isSafeInteger(id) || !harvest) return res.status(400).json({ message: "Check the harvest record values." });
  const connection = await pool.getConnection();
  try {
  await connection.beginTransaction();
  const [existing] = await connection.query<RowDataPacket[]>('SELECT actual_harvest_date FROM harvest_batches WHERE id = ? AND owner_user_id = ? FOR UPDATE', [id, auth.sub]);
  if (!existing[0]) { await connection.rollback(); return res.status(404).json({ message: 'Batch not found.' }); }
  const [totals] = await connection.query<RowDataPacket[]>(`SELECT
    (SELECT COALESCE(SUM(dead_count), 0) FROM harvest_mortalities WHERE batch_id = ?) +
    (SELECT COALESCE(SUM(fish_count), 0) FROM harvest_events WHERE batch_id = ?) AS removed,
    (SELECT MAX(event_date) FROM (
      SELECT mortality_date AS event_date FROM harvest_mortalities WHERE batch_id = ?
      UNION ALL SELECT harvest_date FROM harvest_events WHERE batch_id = ?
      UNION ALL SELECT sampled_at FROM harvest_samples WHERE batch_id = ?
    ) dates) AS last_record`, [id, id, id, id, id]);
  if (harvest.stockedCount < Number(totals[0].removed)) { await connection.rollback(); return res.status(400).json({ message: 'Stock count cannot be less than recorded mortality and harvested fish.' }); }
  const [dates] = await connection.query<RowDataPacket[]>(`SELECT MIN(event_date) AS first_record FROM (
    SELECT mortality_date AS event_date FROM harvest_mortalities WHERE batch_id = ? UNION ALL SELECT harvest_date FROM harvest_events WHERE batch_id = ?
    UNION ALL SELECT sampled_at FROM harvest_samples WHERE batch_id = ? UNION ALL SELECT observed_at FROM harvest_observations WHERE batch_id = ?
  ) dates`, [id, id, id, id]);
  if (dates[0].first_record && harvest.stockingDate > new Date(dates[0].first_record).toLocaleDateString('en-CA')) { await connection.rollback(); return res.status(400).json({ message: 'Stocking date cannot follow existing batch records.' }); }
  if (Boolean(existing[0].actual_harvest_date) !== Boolean(harvest.actualHarvestDate)) { await connection.rollback(); return res.status(400).json({ message: 'Use Record Harvest to close a batch. Completed batches cannot be reopened here.' }); }
  const sensorDeviceId = Number(req.body.sensorDeviceId) || null;
  if (sensorDeviceId) {
    const [devices] = await connection.query<RowDataPacket[]>('SELECT id FROM sensor_devices WHERE id = ? AND owner_user_id = ? AND is_active = 1', [sensorDeviceId, auth.sub]);
    if (!devices.length) { await connection.rollback(); return res.status(400).json({ message: 'Choose a device assigned to your account.' }); }
  }
  const [result] = await connection.execute<ResultSetHeader>(
    `UPDATE harvest_batches SET species = ?, fishpen_name = ?, target_weight_g = ?, reminder_sms = ?, stocking_date = ?, stocked_count = ?, target_harvest_date = ?,
       actual_harvest_date = ?, harvested_kg = ?, selling_price = ?, notes = ?, sensor_device_id = ? WHERE id = ? AND owner_user_id = ?`,
    [harvest.species, harvest.fishpenName || null, harvest.targetWeightG, harvest.reminderSms, harvest.stockingDate, harvest.stockedCount, harvest.targetHarvestDate, harvest.actualHarvestDate, harvest.harvestedKg, harvest.sellingPrice, String(req.body.notes || '').trim().slice(0, 1000), sensorDeviceId, id, auth.sub]
  );
  await connection.commit();
  if (!result.affectedRows) return res.status(404).json({ message: "Harvest record not found." });
  res.json({ saved: true });
  } catch (error) { await connection.rollback(); console.error('Batch edit:', error); res.status(503).json({ message: 'Unable to update batch.' }); }
  finally { connection.release(); }
});

app.delete("/api/harvests/:id", async (req, res) => {
  const auth = verifyAuthToken(req);
  if (!auth) return res.status(401).json({ message: "Login required." });
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return res.status(400).json({ message: "Invalid harvest record." });
  const [result] = await pool.execute<ResultSetHeader>("DELETE FROM harvest_batches WHERE id = ? AND owner_user_id = ?", [id, auth.sub]);
  if (!result.affectedRows) return res.status(404).json({ message: "Harvest record not found." });
  res.json({ deleted: true });
});

app.post("/api/harvests/:id/samples", async (req, res) => {
  const auth = verifyAuthToken(req);
  if (!auth) return res.status(401).json({ message: "Login required." });
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const batchId = Number(req.params.id);
  const { sampledAt, sampleSize, averageWeightG } = req.body || {};
  if (sampledAt > new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })) return res.status(400).json({ message: 'Samples cannot be recorded in the future.' });
  if (!Number.isSafeInteger(batchId) || !validHarvestDate(sampledAt) || !validPositiveInteger(sampleSize) ||
      !Number.isFinite(Number(averageWeightG)) || Number(averageWeightG) <= 0 || Number(averageWeightG) > 100_000) {
    return res.status(400).json({ message: "Check the sample date, number sampled, and average weight." });
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT stocked_count, DATE_FORMAT(stocking_date, '%Y-%m-%d') AS stocking_date, actual_harvest_date FROM harvest_batches WHERE id = ? AND owner_user_id = ? FOR UPDATE",
      [batchId, auth.sub]);
    const batch = rows[0];
    if (!batch || batch.actual_harvest_date) { await connection.rollback(); return res.status(404).json({ message: "Active batch not found." }); }
    if (sampledAt < String(batch.stocking_date).slice(0, 10)) { await connection.rollback(); return res.status(400).json({ message: "Sample date cannot precede stocking." }); }
    const [totals] = await connection.execute<RowDataPacket[]>(
      `SELECT (SELECT COALESCE(SUM(dead_count),0) FROM harvest_mortalities WHERE batch_id = ?) AS dead,
              (SELECT COALESCE(SUM(fish_count),0) FROM harvest_events WHERE batch_id = ?) AS harvested`, [batchId, batchId]);
    const remaining = Number(batch.stocked_count) - Number(totals[0].dead) - Number(totals[0].harvested);
    if (Number(sampleSize) > remaining) { await connection.rollback(); return res.status(400).json({ message: "Sample size exceeds estimated remaining stock." }); }
    const [result] = await connection.execute<ResultSetHeader>(
      "INSERT INTO harvest_samples (batch_id, sampled_at, sample_size, average_weight_g, notes) VALUES (?, ?, ?, ?, ?)",
      [batchId, sampledAt, Number(sampleSize), Number(averageWeightG), String(req.body.notes || '').trim().slice(0, 1000)]);
    await connection.commit();
    res.status(201).json({ id: result.insertId });
  } catch (error) {
    await connection.rollback();
    console.error("Sampling record error:", error);
    res.status(503).json({ message: "Unable to save sampling record." });
  } finally { connection.release(); }
});

app.post("/api/harvests/:id/mortalities", async (req, res) => {
  const auth = verifyAuthToken(req);
  if (!auth) return res.status(401).json({ message: "Login required." });
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const batchId = Number(req.params.id);
  const { mortalityDate, deadCount } = req.body || {};
  if (mortalityDate > new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })) return res.status(400).json({ message: 'Mortality cannot be recorded in the future.' });
  const notes = String(req.body?.notes || "").trim().slice(0, 500);
  if (!Number.isSafeInteger(batchId) || !validHarvestDate(mortalityDate) || !validPositiveInteger(deadCount)) {
    return res.status(400).json({ message: "Check mortality date and number of fish." });
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT stocked_count, DATE_FORMAT(stocking_date, '%Y-%m-%d') AS stocking_date, actual_harvest_date FROM harvest_batches WHERE id = ? AND owner_user_id = ? FOR UPDATE", [batchId, auth.sub]);
    const batch = rows[0];
    if (!batch || batch.actual_harvest_date) { await connection.rollback(); return res.status(404).json({ message: "Active batch not found." }); }
    if (mortalityDate < String(batch.stocking_date).slice(0, 10)) { await connection.rollback(); return res.status(400).json({ message: "Date cannot precede stocking." }); }
    const [totals] = await connection.execute<RowDataPacket[]>(
      `SELECT (SELECT COALESCE(SUM(dead_count),0) FROM harvest_mortalities WHERE batch_id = ?) AS dead,
              (SELECT COALESCE(SUM(fish_count),0) FROM harvest_events WHERE batch_id = ?) AS harvested`, [batchId, batchId]);
    const remaining = Number(batch.stocked_count) - Number(totals[0].dead) - Number(totals[0].harvested);
    if (Number(deadCount) > remaining) { await connection.rollback(); return res.status(400).json({ message: "Dead fish count exceeds estimated remaining stock." }); }
    const [result] = await connection.execute<ResultSetHeader>(
      "INSERT INTO harvest_mortalities (batch_id, mortality_date, dead_count, notes) VALUES (?, ?, ?, ?)",
      [batchId, mortalityDate, Number(deadCount), notes || null]);
    await connection.commit();
    res.status(201).json({ id: result.insertId });
  } catch (error) {
    await connection.rollback();
    console.error("Mortality record error:", error);
    res.status(503).json({ message: "Unable to save mortality record." });
  } finally { connection.release(); }
});

app.post("/api/harvests/:id/events", async (req, res) => {
  const auth = verifyAuthToken(req);
  if (!auth) return res.status(401).json({ message: "Login required." });
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const batchId = Number(req.params.id);
  const { harvestType, harvestDate, fishCount, weightKg, pricePerKg } = req.body || {};
  if (harvestType === 'complete' && req.body.confirmComplete !== true) return res.status(400).json({ message: 'Confirm complete harvest before closing this batch.' });
  if (harvestDate > new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })) return res.status(400).json({ message: 'Actual harvest cannot be in the future.' });
  const count = fishCount === "" || fishCount === null || fishCount === undefined ? null : Number(fishCount);
  const price = pricePerKg === "" || pricePerKg === null || pricePerKg === undefined ? null : Number(pricePerKg);
  if (!Number.isSafeInteger(batchId) || !["partial", "complete"].includes(harvestType) || !validHarvestDate(harvestDate) ||
      (count !== null && !validPositiveInteger(count)) || !Number.isFinite(Number(weightKg)) || Number(weightKg) <= 0 ||
      Number(weightKg) > 1_000_000_000 || (price !== null && !validNonnegativeMoney(price))) {
    return res.status(400).json({ message: "Check harvest type, date, fish count, weight, and price." });
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT stocked_count, DATE_FORMAT(stocking_date, '%Y-%m-%d') AS stocking_date, actual_harvest_date FROM harvest_batches WHERE id = ? AND owner_user_id = ? FOR UPDATE", [batchId, auth.sub]);
    const batch = rows[0];
    if (!batch || batch.actual_harvest_date) { await connection.rollback(); return res.status(404).json({ message: "Active batch not found." }); }
    if (harvestDate < String(batch.stocking_date).slice(0, 10)) { await connection.rollback(); return res.status(400).json({ message: "Date cannot precede stocking." }); }
    if (harvestType === 'complete') {
      const [later] = await connection.query<RowDataPacket[]>(`SELECT MAX(event_date) AS lastDate FROM (
        SELECT mortality_date AS event_date FROM harvest_mortalities WHERE batch_id = ?
        UNION ALL SELECT harvest_date FROM harvest_events WHERE batch_id = ?
        UNION ALL SELECT sampled_at FROM harvest_samples WHERE batch_id = ?
        UNION ALL SELECT observed_at FROM harvest_observations WHERE batch_id = ?
      ) records`, [batchId, batchId, batchId, batchId]);
      if (later[0].lastDate && harvestDate < new Date(later[0].lastDate).toLocaleDateString('en-CA')) {
        await connection.rollback(); return res.status(400).json({ message: 'Completion cannot precede existing batch records.' });
      }
    }
    const [totals] = await connection.execute<RowDataPacket[]>(
      `SELECT (SELECT COALESCE(SUM(dead_count),0) FROM harvest_mortalities WHERE batch_id = ?) AS dead,
              (SELECT COALESCE(SUM(fish_count),0) FROM harvest_events WHERE batch_id = ?) AS harvested`, [batchId, batchId]);
    const remaining = Number(batch.stocked_count) - Number(totals[0].dead) - Number(totals[0].harvested);
    if (count !== null && count > remaining) { await connection.rollback(); return res.status(400).json({ message: "Harvested fish count exceeds estimated remaining stock." }); }
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO harvest_events (batch_id, harvest_type, harvest_date, fish_count, weight_kg, price_per_kg, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [batchId, harvestType, harvestDate, count, Number(weightKg), price, String(req.body.notes || '').trim().slice(0, 1000)]);
    if (harvestType === "complete") await connection.execute(
      "UPDATE harvest_batches SET actual_harvest_date = ? WHERE id = ?", [harvestDate, batchId]);
    await connection.commit();
    res.status(201).json({ id: result.insertId });
  } catch (error) {
    await connection.rollback();
    console.error("Harvest event error:", error);
    res.status(503).json({ message: "Unable to save harvest event." });
  } finally { connection.release(); }
});

app.post(["/api/sensor/readings", "/api/v1/sensors/data"], async (req, res) => {
  const providedKey = String(req.headers["x-api-key"] || req.headers["x-sensor-key"] || req.body?.deviceKey || "");
  if (!providedKey) return res.status(401).json({ message: "Sensor API key is required." });
  if (!pool) return res.status(503).json({ message: "Database is required for sensor readings." });

  const reading = req.body ?? {};
  const validation = validateReadingPayload(reading);
  if (validation.error || !validation.values) return res.status(400).json({ message: validation.error });

  try {
    const device = await authenticateSensorDevice(providedKey);
    if (!device) return res.status(401).json({ message: "Invalid or inactive sensor device." });

    if (!device.ownerUserId) return res.status(409).json({ message: "Device has no assigned farmer. Contact the administrator." });
    const userId = device.ownerUserId;

    const analysis = decisionSupport.analyze(validation.values, (await loadFishCatalog(pool)).profiles);

    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO water_readings
        (user_id, input_mode, ph, temperature, turbidity, ammonia, dissolved_oxygen,
         best_fish, best_score, confidence, status)
       VALUES (?, 'sensor', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        validation.values.ph,
        validation.values.temperature,
        validation.values.turbidity,
        validation.values.ammonia,
        validation.values.dissolvedOxygen,
        analysis.bestFish,
        analysis.bestScore,
        analysis.confidence,
        analysis.status
      ]
    );

    const smsResult = { configured: isSmsConfigured(), ok: false, message: 'Reading saved. Eligible fishpen SMS alerts are processed separately; delivery is not confirmed.' };
    const shouldSendSms = analysis.alerts.some(alert => alert.level === 'warning' || alert.level === 'critical');
    await queueWaterSms(pool, { owner: userId, deviceId: device.id, sourceId: result.insertId, sourceKind: 'sensor-full',
      measurements: sensorSmsMeasurements(validation.values, reading)
    }).catch(() => console.error('Water alert could not be queued. Reading was saved.'));
    void flushWaterSms();

    await logReadingAlerts(result.insertId, userId, analysis.alerts, smsResult, shouldSendSms);

    res.json({
      saved: true,
      readingId: result.insertId,
      inputMode: "sensor",
      device: { id: device.id, name: device.deviceName },
      analysis: {
        status: analysis.status,
        bestFish: analysis.bestFish,
        score: analysis.bestScore,
        confidence: analysis.confidence,
        alerts: analysis.alerts
      },
      sms: smsResult
    });
  } catch (error) {
    console.error("Sensor reading database error:", error);
    res.status(503).json({ message: "Unable to save sensor reading." });
  }
});

app.post("/api/sms/test", async (req, res) => {
  const { phone } = req.body ?? {};
  if (!phone || !/^(\+?639|09)\d{9}$/.test(String(phone).trim())) {
    return res.status(400).json({ message: "Use a Philippine phone number like +639XXXXXXXXX or 09XXXXXXXXX." });
  }

  const result = await sendSms(
    phone,
    "PondSense of Us test alert: iProgSMS connection is working. This is a system test only."
  );
  const status = result.ok ? 200 : result.configured ? 502 : 503;
  res.status(status).json(result);
});

app.post("/api/admin/login", async (req, res) => {
  const { identifier, password, pin } = req.body ?? {};
  if (!identifier || !password || !pin) {
    return res.status(400).json({ message: "Username/email, password, and admin PIN are required." });
  }
  if (!pool) return res.status(503).json({ message: "Database is required for admin login." });

  try {
    const [settings] = await pool.execute<RowDataPacket[]>(
      "SELECT setting_val FROM admin_settings WHERE setting_key = 'admin_pin' LIMIT 1"
    );
    const savedPin = String(settings[0]?.setting_val || process.env.ADMIN_PIN || "admin2024");
    if (String(pin) !== savedPin) return res.status(401).json({ message: "Incorrect admin PIN." });

    const loginId = String(identifier).trim();
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, full_name, username, email, phone, password_hash, role, created_at
       FROM users
       WHERE role = 'admin'
         AND (username = ? OR email = ? OR phone = ?)
       LIMIT 1`,
      [loginId, loginId, loginId]
    );
    const admin = rows[0];
    if (!admin) return res.status(401).json({ message: "No admin account found." });

    const valid = await bcrypt.compare(String(password), String(admin.password_hash));
    if (!valid) return res.status(401).json({ message: "Incorrect admin password." });

    createAuthSession(res, Number(admin.id), "admin");
    res.json({ admin: adminPublicUser(admin) });
  } catch (error) {
    console.error("Admin login error:", error);
    res.status(503).json({ message: "Admin login failed. Check MySQL and admin schema." });
  }
});

app.post("/api/admin/logout", requireAdmin, (_req, res) => {
  clearAuthSession(res);
  res.json({ ok: true });
});

app.get("/api/admin/session", requireAdmin, async (req: AuthRequest, res) => {
  if (!pool || !req.auth) return res.status(503).json({ message: "Database is required for admin session." });
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT id, full_name, username, email, phone, role, created_at FROM users WHERE id = ? LIMIT 1",
    [req.auth.sub]
  );
  res.json({ admin: rows[0] ? adminPublicUser(rows[0]) : null });
});

app.get("/api/admin/users", requireAdmin, async (_req, res) => {
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT id, full_name, username, email, phone, role, created_at FROM users ORDER BY created_at DESC"
  );
  res.json({ users: rows.map(adminPublicUser) });
});

app.get("/api/admin/logs", requireAdmin, async (_req, res) => {
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT wr.*, u.full_name, u.phone
     FROM water_readings wr
     LEFT JOIN users u ON u.id = wr.user_id
     ORDER BY wr.recorded_at DESC
     LIMIT 250`
  );
  res.json({ logs: rows });
});

app.get("/api/admin/alerts", requireAdmin, async (_req, res) => {
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT a.*, u.full_name, u.phone
     FROM alerts a
     LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.sent_at DESC
     LIMIT 250`
  );
  res.json({ alerts: rows });
});

app.get('/api/admin/planning-sms', requireAdmin, async (_req, res) => {
  if (!pool) return res.status(503).json({ message: 'Database is required.' });
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT s.id, s.kind, s.status, s.error_message,
    s.created_at, u.full_name, u.phone FROM planning_sms_log s
    LEFT JOIN users u ON u.id = s.owner_user_id ORDER BY s.id DESC LIMIT 250`);
  res.json({ logs: rows });
});

app.get("/api/admin/audit-logs", requireAdmin, async (_req, res) => {
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT aal.*, u.full_name, u.username
     FROM admin_audit_logs aal
     LEFT JOIN users u ON u.id = aal.admin_id
     ORDER BY aal.created_at DESC
     LIMIT 250`
  );
  res.json({ auditLogs: rows });
});

app.get("/api/admin/thresholds", requireAdmin, async (_req, res) => {
  if (!pool) return res.status(503).json({ message: "Database is required." });
  res.json(await loadFishCatalog(pool));
});

app.patch("/api/admin/thresholds/:id", requireAdmin, async (req: AuthRequest, res) => {
  if (!pool) return res.status(503).json({ message: "Database is required." });
  const update = req.body as FishThresholdUpdate;
  const allowed = [
    "optimal_ph_min",
    "optimal_ph_max",
    "optimal_temp_min",
    "optimal_temp_max",
    "optimal_do_min",
    "optimal_do_max",
    "optimal_turb_min",
    "optimal_turb_max",
    "max_ammonia"
  ] as const;
  const fields = allowed.filter((key) => update[key] !== undefined);
  if (!fields.length) return res.status(400).json({ message: "No threshold values provided." });
  const values: SqlValue[] = [...fields.map((field) => Number(update[field])), Number(req.params.id)];
  await pool.execute(
    `UPDATE fish_species SET ${fields.map((field) => `${field} = ?`).join(", ")} WHERE id = ?`,
    values
  );
  await logAdminAction(req, "threshold_update", `Updated fish_species id ${req.params.id}: ${fields.join(", ")}`);
  res.json({ saved: true });
});

app.post("/api/admin/settings/pin", requireAdmin, async (req: AuthRequest, res) => {
  const { pin } = req.body ?? {};
  if (!pin || String(pin).length < 4) return res.status(400).json({ message: "PIN must be at least 4 characters." });
  if (!pool) return res.status(503).json({ message: "Database is required." });
  await pool.execute(
    `INSERT INTO admin_settings (setting_key, setting_val)
     VALUES ('admin_pin', ?)
     ON DUPLICATE KEY UPDATE setting_val = VALUES(setting_val)`,
    [String(pin)]
  );
  await logAdminAction(req, "admin_pin_update", "Changed admin PIN");
  res.json({ saved: true });
});

app.delete("/api/admin/logs", requireAdmin, async (req: AuthRequest, res) => {
  const confirm = String(req.query.confirm || "");
  if (confirm !== "CLEAR_LOGS") return res.status(400).json({ message: "Confirmation text CLEAR_LOGS is required." });
  if (!pool) return res.status(503).json({ message: "Database is required." });
  await pool.execute("DELETE FROM corrective_action_log");
  await pool.execute("DELETE FROM alerts");
  await pool.execute("DELETE FROM water_readings");
  await logAdminAction(req, "clear_logs", "Cleared corrective actions, alerts, and water readings");
  res.json({ cleared: true });
});

app.delete("/api/admin/factory-reset", requireAdmin, async (req: AuthRequest, res) => {
  const confirm = String(req.query.confirm || "");
  if (confirm !== "RESET_PONDSENSE") return res.status(400).json({ message: "Confirmation text RESET_PONDSENSE is required." });
  if (!pool) return res.status(503).json({ message: "Database is required." });
  await pool.execute("DELETE FROM corrective_action_log");
  await pool.execute("DELETE FROM alerts");
  await pool.execute("DELETE FROM water_readings");
  await pool.execute("DELETE FROM users WHERE role = 'farmer'");
  await logAdminAction(req, "factory_reset", "Deleted farmer accounts, alerts, readings, and corrective action logs");
  res.json({ reset: true });
});

app.get("/api/fish-species", async (_req, res) => {
  if (!pool) return res.json({ demo: true, fish: [] });
  res.json(await loadFishCatalog(pool));
});

app.get("/api/admin/stats", requireAdmin, async (_req, res) => {
  if (!pool) {
    return res.json({ demo: true, users: 0, readings: 0, alerts: 0, correctiveActions: 0 });
  }

  const [[users], [readings], [alerts], [actions], [criticalToday], [smsToday]] = await Promise.all([
    pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM users"),
    pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM water_readings"),
    pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM alerts"),
    pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM corrective_action_log"),
    pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM water_readings WHERE status = 'Critical' AND DATE(recorded_at) = CURDATE()"),
    pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM alerts WHERE sms_sent = 1 AND DATE(sent_at) = CURDATE()")
  ]);

  res.json({
    users: users[0]?.total ?? 0,
    readings: readings[0]?.total ?? 0,
    alerts: alerts[0]?.total ?? 0,
    correctiveActions: actions[0]?.total ?? 0,
    criticalToday: criticalToday[0]?.total ?? 0,
    smsToday: smsToday[0]?.total ?? 0
  });
});

async function sendDueHarvestReminders() {
  if (!pool || !isSmsConfigured()) return;
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT b.id, b.owner_user_id, b.species, b.fishpen_name, b.target_harvest_date, u.phone,
            DATEDIFF(b.target_harvest_date, DATE(UTC_TIMESTAMP() + INTERVAL 8 HOUR)) AS days_left
     FROM harvest_batches b INNER JOIN users u ON u.id = b.owner_user_id
     WHERE b.reminder_sms = 1 AND b.actual_harvest_date IS NULL
       AND (DATEDIFF(b.target_harvest_date, DATE(UTC_TIMESTAMP() + INTERVAL 8 HOUR)) IN (7, 1, 0)
         OR b.target_harvest_date < DATE(UTC_TIMESTAMP() + INTERVAL 8 HOUR))
     ORDER BY b.target_harvest_date, b.id`
  );
  for (const row of rows) {
    const day = Number(row.days_left) < 0 ? -1 : Number(row.days_left);
    if (await hasSentWaterAlertToday(Number(row.owner_user_id))) continue;
    const [quota] = await pool.query<RowDataPacket[]>('SELECT id FROM planning_sms_log WHERE owner_user_id = ? AND send_day = ?', [row.owner_user_id, new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })]);
    if (quota.length) continue;
    const [claim] = await pool.execute<ResultSetHeader>(
      `INSERT IGNORE INTO harvest_reminder_log (batch_id, reminder_day, target_date, sms_status)
       VALUES (?, ?, ?, 'failed')`, [row.id, day, row.target_harvest_date]);
    if (!claim.affectedRows) continue;
    const timing = day < 0 ? 'overdue' : day === 0 ? "today" : `in ${day} day${day === 1 ? "" : "s"}`;
    const message = `PondSense: Planned harvest for ${row.species}${row.fishpen_name ? ` at ${row.fishpen_name}` : ""} is ${timing}. Inspect fish health and water conditions before deciding to harvest.`;
    const result = await sendDailySms(pool, Number(row.owner_user_id), String(row.phone), message, 'harvest');
    if (result.ok) await pool.execute("UPDATE harvest_reminder_log SET sms_status = 'sent' WHERE batch_id = ? AND reminder_day = ? AND target_date = ?", [row.id, day, row.target_harvest_date]);
    else console.warn(`Harvest SMS failed for batch ${row.id}: ${result.message}`);
  }
}

try {
  await ensureAdminStorage();
  if (pool) await migratePlanning(pool);
  if (pool) await migrateFishpenSms(pool);
  void sendDueHarvestReminders().catch((error) => console.error("Harvest reminder check failed:", error));
} catch (error) {
  console.warn("PondSense API started without MySQL migrations. Start XAMPP MySQL, then restart npm run dev.", error);
}

app.listen(port, () => {
  console.log(`PondSense API running on http://localhost:${port}`);
});
setInterval(() => void sendDueHarvestReminders().catch((error) => console.error("Harvest reminder check failed:", error)), 60 * 60 * 1000);
setInterval(() => void flushWaterSms(), 5000).unref();
