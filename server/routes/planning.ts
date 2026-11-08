import { Router } from 'express';
import type { Pool } from 'mysql2/promise';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { verifyAuthToken } from '../auth';
import { archiveRecommendations, planningContext } from '../services/PlanningService';
import { parameters } from '../../src/lib/recommendations';

export const observationCategories = ['normal', 'reduced_feeding', 'surface_gathering', 'unusual_color', 'unusual_odor', 'mortalities', 'net_damage', 'other'];
export function planningRouter(db: Pool | null) {
  const router = Router();
  router.use((req, res, next) => {
    if (!/^\/(recommendations(?:\/|$)|harvests\/[^/]+\/(review|observations|water)(?:\/|$))/.test(req.path)) return next();
    if (!verifyAuthToken(req)) return res.status(401).json({ message: 'Login required.' });
    if (!db) return res.status(503).json({ message: 'Database unavailable.' });
    next();
  });
  router.get('/recommendations', async (req, res) => {
    const owner = verifyAuthToken(req)!.sub;
    const batchId = Number(req.query.batchId || 0);
    if (!Number.isSafeInteger(batchId) || batchId < 0) return res.status(400).json({ message: 'Invalid batch.' });
    const context = await planningContext(db!, owner, batchId);
    if (!context) return res.status(404).json({ message: 'Batch not found.' });
    res.json(context);
  });
  router.get('/recommendations/history', async (req, res) => {
    const clauses = ['owner_user_id = ?'];
    const args: unknown[] = [verifyAuthToken(req)!.sub];
    for (const [query, column] of [['parameter', 'parameter_name'], ['severity', 'severity'], ['fishpen', 'fishpen_name']] as const) {
      if (typeof req.query[query] === 'string' && req.query[query]) { clauses.push(`${column} = ?`); args.push(req.query[query]); }
    }
    if (typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) {
      clauses.push('DATE(recorded_at) = ?'); args.push(req.query.date);
    }
    const [rows] = await db!.query<RowDataPacket[]>(`SELECT id, batch_id AS batchId, fishpen_name AS fishpenName, device_id AS deviceId,
      payload, recorded_at AS recordedAt, acknowledged_at AS acknowledgedAt FROM recommendation_history
      WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT 100`, args);
    res.json({ history: rows.map(r => ({ ...r, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload })) });
  });
  router.post('/recommendations/:id/acknowledge', async (req, res) => {
    const [r] = await db!.execute<ResultSetHeader>('UPDATE recommendation_history SET acknowledged_at = COALESCE(acknowledged_at, CURRENT_TIMESTAMP) WHERE id = ? AND owner_user_id = ?', [req.params.id, verifyAuthToken(req)!.sub]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Recommendation not found.' });
    res.json({ saved: true });
  });
  router.get('/harvests/:id/review', async (req, res) => {
    const owner = verifyAuthToken(req)!.sub;
    if (!Number.isSafeInteger(Number(req.params.id)) || Number(req.params.id) <= 0) return res.status(400).json({ message: 'Invalid batch.' });
    const context = await planningContext(db!, owner, Number(req.params.id));
    if (!context) return res.status(404).json({ message: 'Batch not found.' });
    const [observations] = await db!.query<RowDataPacket[]>(`SELECT id, DATE_FORMAT(observed_at, '%Y-%m-%d') AS date, category, notes
      FROM harvest_observations WHERE batch_id = ? ORDER BY observed_at DESC, id DESC LIMIT 100`, [req.params.id]);
    const [reminders] = await db!.query<RowDataPacket[]>('SELECT reminder_day AS day, target_date AS targetDate, sms_status AS status FROM harvest_reminder_log WHERE batch_id = ? ORDER BY id DESC LIMIT 20', [req.params.id]);
    res.json({ ...context, observations, reminders });
  });
  router.post('/harvests/:id/observations', async (req, res) => {
    const { date, category } = req.body || {};
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > today || !observationCategories.includes(category)) return res.status(400).json({ message: 'Check observation date and category.' });
    const connection = await db!.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<RowDataPacket[]>("SELECT DATE_FORMAT(stocking_date, '%Y-%m-%d') AS stockingDate FROM harvest_batches WHERE id = ? AND owner_user_id = ? AND actual_harvest_date IS NULL FOR UPDATE", [req.params.id, verifyAuthToken(req)!.sub]);
      if (!rows[0]) return res.status(404).json({ message: 'Active batch not found.' });
      if (date < rows[0].stockingDate) return res.status(400).json({ message: 'Observation cannot precede stocking.' });
      await connection.execute('INSERT INTO harvest_observations (batch_id, observed_at, category, notes) VALUES (?, ?, ?, ?)', [req.params.id, date, category, String(req.body.notes || '').trim().slice(0, 1000)]);
      await connection.commit();
    } finally { await connection.rollback(); connection.release(); }
    res.status(201).json({ saved: true });
  });
  router.post('/harvests/:id/water', async (req, res) => {
    const owner = verifyAuthToken(req)!.sub;
    const batchId = Number(req.params.id);
    const { parameter, value } = req.body || {};
    const limits: Record<string, [number, number]> = { ph: [0, 14], temperature: [-10, 60], dissolvedOxygen: [0, 30], turbidity: [0, 1000], ammonia: [0, 10] };
    if (!parameters.includes(parameter) || !['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < limits[parameter][0] || Number(value) > limits[parameter][1]) return res.status(400).json({ message: 'Enter an actual measured value within the instrument range.' });
    const connection = await db!.getConnection();
    let measurementId = 0;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<RowDataPacket[]>('SELECT id FROM harvest_batches WHERE id = ? AND owner_user_id = ? AND actual_harvest_date IS NULL FOR UPDATE', [batchId, owner]);
      if (!rows[0]) return res.status(404).json({ message: 'Active batch not found.' });
      const [r] = await connection.execute<ResultSetHeader>('INSERT INTO batch_water_measurements (batch_id, parameter_name, measurement_value) VALUES (?, ?, ?)', [batchId, parameter, Number(value)]);
      measurementId = r.insertId;
      await connection.commit();
    } finally { await connection.rollback(); connection.release(); }
    let historySaved = true;
    await archiveRecommendations(db!, owner, 'batch-manual', measurementId, batchId).catch(error => {
      historySaved = false;
      console.error('Manual measurement recommendation archive:', error);
    });
    res.status(201).json({ saved: true, historySaved });
  });
  router.use((error: Error, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
    console.error('Planning request failed:', error.message);
    res.status(503).json({ message: 'Unable to save or load planning records. Please retry.' });
  });
  return router;
}
