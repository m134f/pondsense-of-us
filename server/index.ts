import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { hasDbConfig, pool } from "./db";
import { isSmsConfigured, sendSms } from "./sms";
import { clearAuthSession, createAuthSession, requireAdmin, verifyAuthToken, type AuthRequest } from "./auth";
import { DecisionSupportService, type AlertResult } from "./services/DecisionSupportService";

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

  if (process.env.SENSOR_API_KEY) {
    const sensorOwnerPhone = process.env.SENSOR_OWNER_PHONE || guestPhone;
    const [owners] = await pool.execute<RowDataPacket[]>("SELECT id FROM users WHERE phone = ? LIMIT 1", [sensorOwnerPhone]);
    const ownerUserId = Number(owners[0]?.id) || await getGuestUserId();
    const [devices] = await pool.execute<RowDataPacket[]>("SELECT id FROM sensor_devices WHERE device_name = ? LIMIT 1", [
      process.env.SENSOR_DEVICE_NAME || "ESP32 PondSense Device"
    ]);
    if (!devices.length) {
      const apiKeyHash = await bcrypt.hash(process.env.SENSOR_API_KEY, 10);
      await pool.execute(
        "INSERT INTO sensor_devices (device_name, api_key_hash, owner_user_id) VALUES (?, ?, ?)",
        [process.env.SENSOR_DEVICE_NAME || "ESP32 PondSense Device", apiKeyHash, ownerUserId || null]
      );
    }
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
    const numericUserId = Number(reading.userId);
    const isRegisteredUser = Number.isInteger(numericUserId) && numericUserId > 0;
    const userId = isRegisteredUser ? numericUserId : fallbackGuestId;
    if (!userId) return res.status(500).json({ message: "Unable to resolve user for reading." });

    const status = normalizeStatus(reading.status);
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
        reading.bestFish,
        reading.score,
        reading.confidence,
        status
      ]
    );

    const readingId = result.insertId;
    const alerts = Array.isArray(reading.alerts) ? (reading.alerts as AlertPayload[]) : [];
    let smsResult = { configured: isSmsConfigured(), ok: false, message: "SMS alerts require a registered account." };
    const shouldSendSms = isRegisteredUser && alerts.some((alert) => alert.level === "warning" || alert.level === "critical");
    const alreadySentToday = shouldSendSms ? await hasSentWaterAlertToday(userId) : false;
    if (shouldSendSms && alreadySentToday) {
      smsResult = {
        configured: isSmsConfigured(),
        ok: false,
        message: "Daily SMS limit reached. One water warning text was already sent today."
      };
    } else if (shouldSendSms) {
      const [users] = await pool.execute<RowDataPacket[]>("SELECT phone, full_name FROM users WHERE id = ? LIMIT 1", [userId]);
      const recipient = users[0];
      smsResult = await sendSms(String(recipient?.phone || ""), formatAlertSms(reading, alerts));
    }

    await logReadingAlerts(readingId, userId, alerts, smsResult, shouldSendSms);

    res.json({ saved: true, readingId, userId, sms: smsResult });
  } catch (error) {
    console.error("Reading database error:", error);
    res.status(503).json({ message: "Database is not ready. Check XAMPP MySQL and schema import." });
  }
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

    const fallbackGuestId = await getGuestUserId();
    const userId = device.ownerUserId || fallbackGuestId;
    if (!userId) return res.status(500).json({ message: "Unable to resolve sensor owner." });

    const analysis = decisionSupport.analyze(validation.values);

    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO water_readings
        (user_id, input_mode, ph, temperature, turbidity, ammonia, dissolved_oxygen,
         best_fish, best_score, confidence, status)
       VALUES (?, 'sensor', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fallbackGuestId,
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

    const criticalAlerts = analysis.alerts.filter((alert) => alert.level === "critical");
    let smsResult = { configured: isSmsConfigured(), ok: false, message: "No critical sensor alert was sent." };
    const shouldSendSms = criticalAlerts.length > 0;
    if (shouldSendSms) {
      const alreadySentToday = await hasSentWaterAlertToday(userId);
      if (alreadySentToday) {
        smsResult = {
          configured: isSmsConfigured(),
          ok: false,
          message: "Daily SMS limit reached. One water warning text was already sent today."
        };
      } else {
        const [users] = await pool.execute<RowDataPacket[]>("SELECT phone, full_name FROM users WHERE id = ? LIMIT 1", [userId]);
        const recipient = users[0];
        smsResult = await sendSms(String(recipient?.phone || ""), formatAlertSms({
          ...validation.values,
          status: analysis.status
        }, criticalAlerts));
      }
    }

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
  const [rows] = await pool.execute<RowDataPacket[]>("SELECT * FROM fish_species ORDER BY id ASC");
  res.json({ fish: rows });
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
  const [rows] = await pool.execute("SELECT * FROM fish_species ORDER BY id ASC");
  res.json({ fish: rows });
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

try {
  await ensureAdminStorage();
} catch (error) {
  console.warn("PondSense API started without MySQL migrations. Start XAMPP MySQL, then restart npm run dev.", error);
}

app.listen(port, () => {
  console.log(`PondSense API running on http://localhost:${port}`);
});
