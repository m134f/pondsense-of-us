import type { Pool } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { recommend, referenceThresholds, waterSummary, type Measurements, type Thresholds } from '../../src/lib/recommendations';

export async function planningContext(db: Pool, owner: number, batchId = 0, now = Date.now(), snapshot?: Measurements) {
  let batch: RowDataPacket | undefined;
  if (batchId) {
    const [rows] = await db.query<RowDataPacket[]>('SELECT * FROM harvest_batches WHERE id = ? AND owner_user_id = ?', [batchId, owner]);
    batch = rows[0];
    if (!batch) return null;
  }
  let ranges: Thresholds = referenceThresholds;
  let reference = 'Application reference ranges';
  if (batch) {
    const [fish] = await db.query<RowDataPacket[]>('SELECT * FROM fish_species WHERE name = ?', [batch.species]);
    if (fish[0]) {
      const f = fish[0];
      const fields = ['optimal_ph_min', 'optimal_ph_max', 'optimal_temp_min', 'optimal_temp_max', 'optimal_do_min', 'optimal_do_max', 'optimal_turb_min', 'optimal_turb_max', 'max_ammonia'];
      const configured: Thresholds = { ph: [Number(f.optimal_ph_min), Number(f.optimal_ph_max)], temperature: [Number(f.optimal_temp_min), Number(f.optimal_temp_max)],
        dissolvedOxygen: [Number(f.optimal_do_min), Number(f.optimal_do_max)], turbidity: [Number(f.optimal_turb_min), Number(f.optimal_turb_max)], ammonia: [0, Number(f.max_ammonia)] };
      if (fields.every(field => f[field] != null && String(f[field]).trim() !== '' && Number.isFinite(Number(f[field]))) && Object.values(configured).every(([min, max]) => min < max)) {
        ranges = configured;
        reference = String(batch.species);
      } else reference = 'Application reference ranges (species configuration incomplete)';
    }
  }
  const measurements: Measurements = {};
  const [sensor] = await db.query<RowDataPacket[]>(
    `SELECT t.* FROM sensor_telemetry t JOIN sensor_devices d ON d.id = t.device_id
     WHERE t.owner_user_id = ? AND d.owner_user_id = ? AND d.is_active = 1 ${batch ? 'AND t.device_id = ?' : ''}
     ORDER BY t.id DESC LIMIT 1`, batch ? [owner, owner, batch.sensor_device_id || 0] : [owner, owner]);
  const telemetry = sensor[0];
  if (telemetry) {
    for (const [key, col] of [['ph', 'ph'], ['temperature', 'temperature_c'], ['turbidity', 'turbidity_ntu']] as const) {
      measurements[key] = { value: telemetry[col] === null ? null : Number(telemetry[col]), source: 'sensor', recordedAt: new Date(telemetry.recorded_at).toISOString() };
    }
  }
  if (batch) {
    const [manual] = await db.query<RowDataPacket[]>('SELECT * FROM batch_water_measurements WHERE batch_id = ? ORDER BY id DESC', [batchId]);
    const seen = new Set<string>();
    for (const row of manual) {
      const key = row.parameter_name as keyof Measurements;
      if (seen.has(key)) continue;
      seen.add(key);
      const recordedAt = new Date(row.recorded_at).toISOString();
      if (!measurements[key]?.recordedAt || Date.parse(recordedAt) > Date.parse(measurements[key]!.recordedAt!)) {
        measurements[key] = { value: Number(row.measurement_value), source: 'manual', recordedAt };
      }
    }
  } else {
    const [manual] = await db.query<RowDataPacket[]>("SELECT * FROM water_readings WHERE user_id = ? AND input_mode = 'manual' ORDER BY id DESC LIMIT 1", [owner]);
    if (manual[0]) for (const [key, col] of [['ph', 'ph'], ['temperature', 'temperature'], ['dissolvedOxygen', 'dissolved_oxygen'], ['turbidity', 'turbidity'], ['ammonia', 'ammonia']] as const) {
      const row = manual[0];
      const recordedAt = new Date(row.recorded_at).toISOString();
      if (!measurements[key]?.recordedAt || Date.parse(recordedAt) > Date.parse(measurements[key]!.recordedAt!)) measurements[key] = { value: row[col] === null ? null : Number(row[col]), source: 'manual', recordedAt };
    }
  }
  const recommendations = recommend(snapshot ?? measurements, ranges, now);
  return { batchId, fishpenName: batch?.fishpen_name ?? null, deviceId: telemetry?.device_id ?? null,
    reference, recommendations, status: waterSummary(recommendations), deviceAssigned: Boolean(batch?.sensor_device_id) };
}

export async function archiveRecommendations(db: Pool, owner: number, kind: 'sensor' | 'manual' | 'batch-manual', sourceId: number, batchId = 0) {
  // Archive the accepted event, never whichever upload happens to be latest now.
  const table = kind === 'sensor' ? 'sensor_telemetry' : kind === 'manual' ? 'water_readings' : 'batch_water_measurements';
  const [sources] = await db.query<RowDataPacket[]>(`SELECT * FROM ${table} WHERE id = ?`, [sourceId]);
  const source = sources[0];
  if (!source || (kind === 'sensor' && Number(source.owner_user_id) !== owner) || (kind === 'manual' && Number(source.user_id) !== owner) || (kind === 'batch-manual' && Number(source.batch_id) !== batchId)) return null;
  const snapshot: Measurements = {};
  const recordedAt = new Date(source.recorded_at).toISOString();
  const columns = kind === 'sensor' ? { ph: 'ph', temperature: 'temperature_c', turbidity: 'turbidity_ntu' } :
    kind === 'manual' ? { ph: 'ph', temperature: 'temperature', turbidity: 'turbidity', dissolvedOxygen: 'dissolved_oxygen', ammonia: 'ammonia' } : { [source.parameter_name]: 'measurement_value' };
  for (const [key, col] of Object.entries(columns)) snapshot[key as keyof Measurements] = {
    value: source[col] == null ? null : Number(source[col]), source: kind === 'sensor' ? 'sensor' : 'manual', recordedAt
  };
  const contexts = [batchId];
  if (kind === 'sensor') {
    const [batches] = await db.query<RowDataPacket[]>(`SELECT b.id FROM harvest_batches b JOIN sensor_telemetry t ON t.device_id = b.sensor_device_id
      WHERE t.id = ? AND b.owner_user_id = ? AND b.actual_harvest_date IS NULL`, [sourceId, owner]);
    contexts.push(...batches.map(b => Number(b.id)));
  }
  let firstContext = null;
  for (const id of contexts) {
    const context = await planningContext(db, owner, id, Date.now(), snapshot);
    if (!context) continue;
    context.deviceId = kind === 'sensor' ? source.device_id : null;
    if (id === batchId) firstContext = context;
    for (const rec of context.recommendations) await db.execute(
      `INSERT IGNORE INTO recommendation_history (owner_user_id, batch_id, source_kind, source_id, parameter_name, fishpen_name, device_id, severity, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [owner, id, kind, sourceId, rec.parameter, context.fishpenName, context.deviceId, rec.state, JSON.stringify({ ...rec, reference: context.reference })]);
  }
  return firstContext;
}
