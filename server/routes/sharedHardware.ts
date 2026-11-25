import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router, type Request } from 'express';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { requireRole, type AuthRequest } from '../auth';
import { isTrustedJsonRequest } from '../trustedOrigin';
import { adminFreshnessSeconds } from './adminReporting';

type Parsed = { rawValue: number; voltage: number; ntu: number | null; temperatureC: number | null; ph: number | null };
type Snapshot = Parsed & { dissolvedOxygen: number | null };
type Saved = { assignmentId: string; owner: number; fishpenId: number; deviceId: number; telemetryId: number; snapshot: Snapshot; body: Record<string, unknown> };

const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const chipId = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{1,12}$/i.test(value) ? value.toUpperCase().padStart(12, '0') : null;
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 23).replace('T', ' ');
const registerKey = () => `ps_${crypto.randomBytes(24).toString('base64url')}`;
const duplicate = (error: unknown) => (error as { code?: string })?.code === 'ER_DUP_ENTRY';
export const legacySensorFixture = () => process.env.NODE_ENV === 'test' && process.env.PONDSENSE_LEGACY_TEST === '1';

class HardwareError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
async function transaction<T>(db: Pool, run: (c: PoolConnection) => Promise<T>) {
  const c = await db.getConnection();
  try { await c.beginTransaction(); const result = await run(c); await c.commit(); return result; }
  catch (error) { await c.rollback(); throw error; }
  finally { c.release(); }
}
async function audit(c: PoolConnection, req: AuthRequest, action: string, details: object) {
  await c.execute('INSERT INTO admin_audit_logs (admin_id, action, details) VALUES (?, ?, ?)', [req.auth!.sub, action, JSON.stringify(details)]);
}
async function lockBoard(c: PoolConnection, id: number) {
  const [[board]] = await c.execute<RowDataPacket[]>(`SELECT h.id, h.credential_device_id, d.api_key_hash, d.is_active, d.owner_user_id
    FROM registered_hardware h JOIN sensor_devices d ON d.id = h.credential_device_id WHERE h.id = ? FOR UPDATE`, [id]);
  if (!board) throw new HardwareError(404, 'Hardware not found.');
  return board;
}
async function currentAssignment(db: Pool | PoolConnection, hardwareId: number, lock = false) {
  const [[row]] = await db.execute<RowDataPacket[]>(`SELECT a.id, a.owner_user_id, a.fishpen_id,
    DATE_FORMAT(a.started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS started_at
    FROM hardware_assignments a JOIN users u ON u.id = a.owner_user_id
    JOIN owner_fishpen_assignments p ON p.owner_user_id = a.owner_user_id AND p.fishpen_id = a.fishpen_id
    JOIN sms_fishpens f ON f.id = p.fishpen_id AND f.owner_user_id = a.owner_user_id
    WHERE a.active_hardware_id = ? AND u.role = 'farmer' AND u.account_status = 'ACTIVE'${lock ? ' FOR UPDATE' : ''}`, [hardwareId]);
  return row;
}

export function sharedHardwareRouter(db: Pool | null, sharedMode: boolean, parse: (body: Record<string, unknown>) => { error: string | null; values: Parsed | null }, saved: (event: Saved) => void) {
  const router = Router();
  const uploadsEnabled = sharedMode && process.env.PONDSENSE_PAUSE_HARDWARE_UPLOADS !== 'true';
  const admin = requireRole('admin', db);
  const checkedKeys = new Map<number, { fingerprint: string; hash: string }>();
  const reportError = (res: import('express').Response, error: unknown) => {
    if (error instanceof HardwareError) return res.status(error.status).json({ message: error.message });
    if (duplicate(error)) return res.status(409).json({ message: 'This hardware or fishpen already has a registration or assignment.' });
    return res.status(503).json({ message: 'Hardware operation unavailable. Check the current status before retrying.' });
  };
  router.use('/admin/hardware', (req, res, next) => {
    if (req.method !== 'GET' && !isTrustedJsonRequest(req)) return res.status(403).json({ message: 'Untrusted request origin.' });
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/admin/hardware', admin, async (_req, res) => {
    if (!db) return res.status(503).json({ message: 'Database unavailable.' });
    try {
      const [boards] = await db.query<RowDataPacket[]>(`SELECT h.id, h.chip_id AS chipId, h.name, h.credential_device_id AS credentialDeviceId,
        d.is_active AS active, a.id AS assignmentId, a.owner_user_id AS ownerId, a.fishpen_id AS fishpenId,
        u.full_name AS farmer, a.fishpen_name AS fishpen,
        (SELECT DATE_FORMAT(MAX(t.recorded_at), '%Y-%m-%dT%H:%i:%sZ') FROM sensor_telemetry t WHERE t.assignment_id = a.id) AS lastUpload,
        EXISTS(SELECT 1 FROM sensor_telemetry t WHERE t.device_id = d.id) AS everConnected,
        EXISTS(SELECT 1 FROM sensor_telemetry t WHERE t.assignment_id = a.id AND t.water_contact_confirmed = TRUE
          AND (t.ph IS NOT NULL OR t.temperature_c IS NOT NULL OR t.turbidity_ntu IS NOT NULL OR t.dissolved_oxygen IS NOT NULL)
          AND t.recorded_at BETWEEN TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3)) AND UTC_TIMESTAMP(3)
          AND t.sampled_at BETWEEN TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3)) AND UTC_TIMESTAMP(3)) AS fresh,
        (u.account_status = 'ACTIVE' AND o.fishpen_id IS NOT NULL AND pen.owner_user_id = a.owner_user_id) AS eligible
        FROM registered_hardware h JOIN sensor_devices d ON d.id = h.credential_device_id
        LEFT JOIN hardware_assignments a ON a.active_hardware_id = h.id LEFT JOIN users u ON u.id = a.owner_user_id
        LEFT JOIN owner_fishpen_assignments o ON o.owner_user_id = a.owner_user_id AND o.fishpen_id = a.fishpen_id
        LEFT JOIN sms_fishpens pen ON pen.id = o.fishpen_id ORDER BY h.id`, [-adminFreshnessSeconds(), -adminFreshnessSeconds()]);
      res.json({ uploadsEnabled, hardware: boards.map(({ fresh, everConnected, eligible, ...row }) => ({ ...row,
        status: !row.assignmentId ? 'Unassigned' : !uploadsEnabled ? 'Paused' : !row.active || !eligible ? 'Offline' : fresh ? 'Online' : everConnected ? 'Offline' : 'Never Connected'
      })) });
    } catch (error) { reportError(res, error); }
  });
  router.get('/admin/hardware/fishpens', admin, async (_req, res) => {
    if (!db) return res.status(503).json({ message: 'Database unavailable.' });
    try {
      const [fishpens] = await db.query<RowDataPacket[]>(`SELECT u.id AS ownerId, u.full_name AS farmer, p.id AS fishpenId, p.name AS fishpen
        FROM owner_fishpen_assignments a JOIN users u ON u.id = a.owner_user_id
        JOIN sms_fishpens p ON p.id = a.fishpen_id AND p.owner_user_id = u.id
        WHERE u.role = 'farmer' AND u.account_status = 'ACTIVE' AND u.phone <> '+639000000000' ORDER BY u.full_name, p.id`);
      res.json({ fishpens });
    } catch (error) { reportError(res, error); }
  });
  router.post('/admin/hardware', admin, async (req: AuthRequest, res) => {
    if (!db) return res.status(503).json({ message: 'Database unavailable.' });
    const chip = chipId(req.body?.chipId);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const legacy = req.body?.legacyDeviceId;
    if (!chip || !name || name.length > 100 || (legacy != null && !integer(legacy))) {
      return res.status(400).json({ message: 'Enter a hardware name and a valid ESP32 chip ID.' });
    }
    if (legacy != null && !sharedMode) return res.status(409).json({ message: 'Adopt an existing monitor after shared uploads are activated. Its legacy monitoring is still in service.' });
    try {
      const result = await transaction(db, async c => {
        let credentialId = legacy as number | undefined;
        let deviceKey: string | undefined;
        if (legacy != null) {
          const [[old]] = await c.execute<RowDataPacket[]>('SELECT id FROM sensor_devices WHERE id = ? AND is_active = 1 FOR UPDATE', [legacy]);
          const [[proof]] = await c.execute<RowDataPacket[]>(`SELECT id FROM sensor_telemetry WHERE device_id = ?
            AND client_reading_id REGEXP '^[0-9A-Fa-f]{1,12}-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}$'
            AND LPAD(UPPER(SUBSTRING_INDEX(client_reading_id, '-', 1)), 12, '0') = ? LIMIT 1`, [legacy, chip]);
          if (!old || !proof || req.body?.verifiedPhysicalBoard !== true) {
            throw new HardwareError(409, 'Adoption requires an active legacy record with a matching saved chip identifier and operator verification.');
          }
        } else {
          deviceKey = registerKey();
          const [entry] = await c.execute<ResultSetHeader>('INSERT INTO sensor_devices (device_name, api_key_hash, owner_user_id) VALUES (?, ?, NULL)', [name, await bcrypt.hash(deviceKey, 10)]);
          credentialId = entry.insertId;
        }
        const [entry] = await c.execute<ResultSetHeader>('INSERT INTO registered_hardware (name, chip_id, credential_device_id) VALUES (?, ?, ?)', [name, chip, credentialId!]);
        await audit(c, req, legacy != null ? 'hardware_adopted' : 'hardware_registered', { hardwareId: entry.insertId, credentialId });
        return { hardwareId: entry.insertId, deviceKey };
      });
      res.status(201).json(result);
    } catch (error) { reportError(res, error); }
  });
  router.post('/admin/hardware/:id/assign', admin, async (req: AuthRequest, res) => {
    const id = Number(req.params.id), { ownerId, fishpenId, confirmedMoved } = req.body ?? {};
    if (!db) return res.status(503).json({ message: 'Database unavailable.' });
    if (!integer(id) || !integer(ownerId) || !integer(fishpenId) || confirmedMoved !== true) {
      return res.status(400).json({ message: 'Select a farmer and fishpen and confirm the prototype is installed there.' });
    }
    try {
      const assignmentId = await transaction(db, async c => {
        const board = await lockBoard(c, id);
        if (!sharedMode && board.owner_user_id != null) throw new HardwareError(409, 'This monitor is still using its legacy assignment.');
        if (Number(board.is_active) !== 1) throw new HardwareError(409, 'Hardware is inactive.');
        const [[active]] = await c.execute<RowDataPacket[]>('SELECT id FROM hardware_assignments WHERE active_hardware_id = ? FOR UPDATE', [id]);
        if (active) throw new HardwareError(409, 'End the current assignment before moving the hardware.');
        const [[pen]] = await c.execute<RowDataPacket[]>(`SELECT p.name FROM owner_fishpen_assignments o
          JOIN sms_fishpens p ON p.id = o.fishpen_id AND p.owner_user_id = o.owner_user_id
          JOIN users u ON u.id = o.owner_user_id
          WHERE o.owner_user_id = ? AND p.id = ? AND u.role = 'farmer' AND u.account_status = 'ACTIVE'
            AND u.phone <> '+639000000000' FOR UPDATE`, [ownerId, fishpenId]);
        if (!pen) throw new HardwareError(409, 'The selected fishpen does not belong to an active farmer.');
        const next = crypto.randomUUID();
        await c.execute('INSERT INTO hardware_assignments (id, hardware_id, owner_user_id, fishpen_id, fishpen_name, started_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))',
          [next, id, ownerId, fishpenId, pen.name]);
        await audit(c, req, 'hardware_assigned', { hardwareId: id, assignmentId: next, ownerId, fishpenId });
        return next;
      });
      res.json({ assignmentId });
    } catch (error) { reportError(res, error); }
  });
  router.post('/admin/hardware/:id/unassign', admin, async (req: AuthRequest, res) => {
    const id = Number(req.params.id), expected = req.body?.assignmentId;
    if (!db) return res.status(503).json({ message: 'Database unavailable.' });
    if (!integer(id) || !uuid(expected)) return res.status(400).json({ message: 'Confirm the active assignment first.' });
    try {
      await transaction(db, async c => {
        const board = await lockBoard(c, id);
        if (!sharedMode && board.owner_user_id != null) throw new HardwareError(409, 'This monitor is still using its legacy assignment.');
        const [changed] = await c.execute<ResultSetHeader>('UPDATE hardware_assignments SET ended_at = UTC_TIMESTAMP(3) WHERE active_hardware_id = ? AND id = ?', [id, expected]);
        if (changed.affectedRows !== 1) throw new HardwareError(409, 'The assignment changed. Refresh the Devices page.');
        await audit(c, req, 'hardware_unassigned', { hardwareId: id, assignmentId: expected });
      });
      res.json({ saved: true });
    } catch (error) { reportError(res, error); }
  });
  router.post('/admin/hardware/:id/key', admin, async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    if (!db) return res.status(503).json({ message: 'Database unavailable.' });
    if (!integer(id)) return res.status(400).json({ message: 'Invalid hardware.' });
    const deviceKey = registerKey(), hash = await bcrypt.hash(deviceKey, 10);
    try {
      await transaction(db, async c => {
        const board = await lockBoard(c, id);
        if (!sharedMode && board.owner_user_id != null) throw new HardwareError(409, 'The legacy monitor key is still in service.');
        await c.execute('UPDATE sensor_devices SET api_key_hash = ? WHERE id = ?', [hash, board.credential_device_id]);
        await audit(c, req, 'hardware_key_replaced', { hardwareId: id });
      });
      checkedKeys.delete(id);
      res.json({ hardwareId: id, deviceKey });
    } catch (error) { reportError(res, error); }
  });

  router.post(['/v2/hardware/assignment', '/v2/hardware/readings'], async (req: Request, res) => {
    res.set('Cache-Control', 'no-store');
    if (!db || !uploadsEnabled) return res.status(503).json({ message: 'Hardware monitoring is paused or unavailable.' });
    const chip = chipId(req.body?.chipId);
    const key = req.get('X-API-Key') ?? '';
    if (!chip || !key || Buffer.byteLength(key, 'utf8') > 72) return res.status(401).json({ message: 'Invalid hardware credentials.' });
    const isReading = req.path.endsWith('/readings');
    const body = req.body as Record<string, unknown>;
    const measured = typeof body.sampledAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(body.sampledAt) ? Date.parse(body.sampledAt) : NaN;
    const readingId = body.clientReadingId;
    const requestAssignment = body.assignmentId;
    const dissolvedOxygen = body.dissolvedOxygen ?? null;
    let snapshot: Snapshot | null = null;
    if (isReading) {
      const parsed = parse(body);
      if (parsed.error || !parsed.values) return res.status(400).json({ message: parsed.error });
      if (!uuid(requestAssignment) || typeof readingId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(readingId) || !Number.isFinite(measured)) {
        return res.status(400).json({ message: 'Assignment, reading ID, and an actual UTC sample timestamp are required.' });
      }
      if (body.waterContactConfirmed !== true) return res.status(422).json({ message: 'Water contact not confirmed.' });
      if (dissolvedOxygen !== null && (typeof dissolvedOxygen !== 'number' || !Number.isFinite(dissolvedOxygen) ||
          dissolvedOxygen < 0 || dissolvedOxygen > 30 || !Array.isArray(body.verifiedParameters) || !body.verifiedParameters.includes('dissolvedOxygen'))) {
        return res.status(400).json({ message: 'Dissolved oxygen must be omitted unless calibrated and verified.' });
      }
      snapshot = { ...parsed.values, dissolvedOxygen };
    }
    try {
      const [[credential]] = await db.execute<RowDataPacket[]>(`SELECT h.id, d.api_key_hash FROM registered_hardware h
        JOIN sensor_devices d ON d.id = h.credential_device_id WHERE h.chip_id = ? AND d.is_active = 1`, [chip]);
      if (!credential) throw new HardwareError(401, 'Invalid hardware credentials.');
      const fingerprint = crypto.createHash('sha256').update(key).digest('hex');
      const id = Number(credential.id), cached = checkedKeys.get(id);
      if (cached?.hash !== credential.api_key_hash || cached?.fingerprint !== fingerprint) {
        if (!await bcrypt.compare(key, credential.api_key_hash)) throw new HardwareError(401, 'Invalid hardware credentials.');
        if (checkedKeys.size >= 128) checkedKeys.clear();
        checkedKeys.set(id, { fingerprint, hash: credential.api_key_hash });
      }
      const result = await transaction(db, async c => {
        const board = await lockBoard(c, id);
        if (board.api_key_hash !== credential.api_key_hash || Number(board.is_active) !== 1) throw new HardwareError(401, 'Invalid hardware credentials.');
        const active = await currentAssignment(c, id, true);
        if (!active) throw new HardwareError(409, 'Hardware is not assigned to an active fishpen.');
        if (!snapshot) return { assignmentId: active.id };
        if (active.id !== requestAssignment || measured <= Date.parse(active.started_at) || measured > Date.now()) {
          throw new HardwareError(409, 'Sample does not belong to the current assignment. Obtain a fresh assignment before sampling.');
        }
        const deviceId = Number(board.credential_device_id);
        const [[prior]] = await c.execute<RowDataPacket[]>('SELECT id, assignment_id FROM sensor_telemetry WHERE device_id = ? AND client_reading_id = ?', [deviceId, readingId as string]);
        if (prior) {
          if (prior.assignment_id !== active.id) throw new HardwareError(409, 'Reading ID belongs to a previous assignment.');
          return { saved: true, assigned: true, deviceId, telemetryId: Number(prior.id), duplicate: true };
        }
        const [entry] = await c.execute<ResultSetHeader>(`INSERT INTO sensor_telemetry (device_id, hardware_id, owner_user_id, fishpen_id, assignment_id,
          turbidity_raw, turbidity_voltage, turbidity_ntu, temperature_c, ph, dissolved_oxygen, client_reading_id, sampled_at,
          water_contact_confirmed, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, UTC_TIMESTAMP())`,
          [deviceId, id, active.owner_user_id, active.fishpen_id, active.id, snapshot.rawValue, snapshot.voltage,
            snapshot.ntu, snapshot.temperatureC, snapshot.ph, snapshot.dissolvedOxygen, readingId as string, sqlTime(measured).slice(0,19)]);
        return { saved: true, assigned: true, deviceId, telemetryId: entry.insertId, duplicate: false,
          event: { assignmentId: String(active.id), owner: Number(active.owner_user_id), fishpenId: Number(active.fishpen_id),
            deviceId, telemetryId: entry.insertId, snapshot, body } };
      });
      if ('event' in result && result.event) {
        const { event, ...payload } = result;
        saved(event);
        return res.status(201).json(payload);
      }
      res.status(isReading ? 201 : 200).json(result);
    } catch (error) { reportError(res, error); }
  });
  return router;
}
