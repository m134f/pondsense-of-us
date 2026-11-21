import type { Pool } from 'mysql2/promise';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { Measurements, Parameter } from '../../src/lib/recommendations';
import { assignedFishpen } from './OwnerFishpen';
import { isSmsConfigured, sendSms } from '../sms';
import { recipients, waterSmsPolicy } from './FishpenSms';
import { advanceIncident, chooseNotification, sensorSnapshot, SNAPSHOT_MAX_AGE_MS, type IncidentState } from './IncidentPolicy';

const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 23).replace('T', ' ');
const parseJson = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === 'string' ? JSON.parse(value) as T : value as T ?? fallback; }
  catch { return fallback; }
};
const asMs = (value: unknown) => value ? Date.parse(String(value)) : null;
const incidentRecipients = (pen: Parameters<typeof recipients>[0]) => recipients({ ...pen, owner_enabled: 1 });

function combinedMessage(name: string, keys: Parameter[], values: Partial<Record<Parameter, number>>, at: number) {
  const readings = keys.map(key => `${key}: ${values[key]}`).join('; ');
  const time = new Date(at).toLocaleString('en-PH', { timeZone: 'Asia/Manila', hour12: false });
  return `PONDSENSE CRITICAL WATER ALERT\nFishpen: ${name}\n${readings}\nMeasured: ${time} PHT\nCheck fish and water now. Confirm with a fresh test; contact BFAR/LGU if distress continues.`.slice(0, 480);
}

export async function queueIncidentSms(db: Pool, input: { owner: number; deviceId: number; sourceId: number; sourceKind: 'telemetry' | 'sensor-full'; measurements: Measurements }, now = Date.now()) {
  if (!waterSmsPolicy().reviewed) return;
  const snapshot = sensorSnapshot(input.measurements, now);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const assignment = await assignedFishpen(connection, input.owner, true);
    if (!assignment || assignment.deviceId !== input.deviceId) { await connection.rollback(); return; }
    const [pens] = await connection.query<RowDataPacket[]>(`SELECT p.*, u.phone AS owner_phone FROM sms_fishpens p JOIN users u ON u.id = p.owner_user_id
      WHERE p.id = ? AND p.owner_user_id = ? AND u.role = 'farmer' AND u.account_status = 'ACTIVE' FOR UPDATE`, [assignment.id, input.owner]);
    const pen = pens[0];
    if (!pen) { await connection.rollback(); return; }
    await connection.execute(`INSERT IGNORE INTO sms_critical_state
      (fishpen_id, owner_user_id, device_id, counts_json, confirmed_json, ever_critical_json, values_json)
      VALUES (?, ?, ?, '{}', '[]', '[]', '{}')`, [pen.id, input.owner, input.deviceId]);
    const [states] = await connection.query<RowDataPacket[]>(`SELECT *, DATE_FORMAT(last_sampled_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS sampled_iso,
      DATE_FORMAT(recovery_started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS recovery_iso FROM sms_critical_state WHERE fishpen_id = ? FOR UPDATE`, [pen.id]);
    const row = states[0];
    if (Number(row.device_id) !== input.deviceId) {
      if (row.incident_id) await connection.execute("UPDATE sms_critical_incidents SET status = 'resolved', resolved_at = UTC_TIMESTAMP(3) WHERE id = ?", [row.incident_id]);
      await connection.execute("UPDATE sms_critical_notifications SET status = 'cancelled', provider_response = 'Monitoring device changed.' WHERE incident_id = ? AND status = 'pending'", [row.incident_id || 0]);
      row.incident_id = null;
      row.sampled_iso = null;
      row.counts_json = '{}'; row.confirmed_json = '[]'; row.ever_critical_json = '[]'; row.recovery_iso = null;
    }
    if (!snapshot) {
      await connection.execute("UPDATE sms_critical_state SET device_id = ?, counts_json = '{}', recovery_started_at = NULL WHERE fishpen_id = ?", [input.deviceId, pen.id]);
      await connection.commit(); return;
    }
    const previous: IncidentState = {
      lastAt: asMs(row.sampled_iso),
      counts: parseJson(row.counts_json, {}),
      confirmed: parseJson(row.confirmed_json, []),
      everCritical: parseJson(row.ever_critical_json, []),
      recoverySince: asMs(row.recovery_iso)
    };
    const result = advanceIncident(previous, snapshot);
    if (!result) { await connection.rollback(); return; }
    let incidentId: number | null = row.incident_id ? Number(row.incident_id) : null;
    if (result.resolved && incidentId) {
      await connection.execute("UPDATE sms_critical_incidents SET status = 'resolved', resolved_at = ? WHERE id = ?", [sqlTime(snapshot.at), incidentId]);
      await connection.execute("UPDATE sms_critical_notifications SET status = 'cancelled', provider_response = 'Incident resolved.' WHERE incident_id = ? AND status = 'pending'", [incidentId]);
      incidentId = null;
      result.state.counts = {}; result.state.confirmed = []; result.state.everCritical = []; result.state.recoverySince = null;
    } else if (!incidentId && result.state.confirmed.length) {
      const [created] = await connection.execute<ResultSetHeader>('INSERT INTO sms_critical_incidents (fishpen_id, owner_user_id, device_id, opened_at) VALUES (?, ?, ?, ?)', [pen.id, input.owner, input.deviceId, sqlTime(snapshot.at)]);
      incidentId = created.insertId;
    }
    await connection.execute(`UPDATE sms_critical_state SET owner_user_id = ?, device_id = ?, incident_id = ?, last_sampled_at = ?,
      counts_json = ?, confirmed_json = ?, ever_critical_json = ?, values_json = ?, recovery_started_at = ? WHERE fishpen_id = ?`,
      [input.owner, input.deviceId, incidentId, sqlTime(snapshot.at), JSON.stringify(result.state.counts), JSON.stringify(result.state.confirmed),
        JSON.stringify(result.state.everCritical), JSON.stringify(snapshot.values), result.state.recoverySince === null ? null : sqlTime(result.state.recoverySince), pen.id]);
    if (!incidentId || !result.state.confirmed.length) { await connection.commit(); return; }
    const keys = result.state.confirmed;
    for (const recipient of incidentRecipients(pen as Parameters<typeof recipients>[0])) {
      const [prior] = await connection.query<RowDataPacket[]>(`SELECT id, kind, critical_keys, status,
        DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_iso FROM sms_critical_notifications
        WHERE incident_id = ? AND recipient_phone = ? ORDER BY id`, [incidentId, recipient.phone]);
      const pending = prior.find(item => item.status === 'pending');
      if (pending) {
        await connection.execute(`UPDATE sms_critical_notifications SET critical_keys = ?, source_kind = ?, source_id = ?, measured_at = ?, message = ?
          WHERE id = ? AND status = 'pending'`, [keys.join(','), input.sourceKind, input.sourceId, sqlTime(snapshot.at),
          combinedMessage(pen.name, keys, snapshot.values, snapshot.at), pending.id]);
        continue;
      }
      const [budgetRows] = await connection.query<RowDataPacket[]>(`SELECT kind, status,
        DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_iso FROM sms_critical_notifications
        WHERE recipient_phone = ? ORDER BY id DESC LIMIT 100`, [recipient.phone]);
      const history = budgetRows.map(item => ({ kind: String(item.kind), at: Date.parse(item.created_iso), status: String(item.status) }))
        .sort((a, b) => a.at - b.at);
      const announced = new Set(prior.filter(item => item.status !== 'cancelled').flatMap(item => String(item.critical_keys).split(',').filter(Boolean)));
      const kind = !prior.some(item => item.kind === 'initial' && item.status !== 'cancelled') ? 'initial'
        : keys.some(key => !announced.has(key)) ? 'update' : 'reminder';
      if (kind !== 'initial' && !chooseNotification(kind, history, now)) continue;
      if (kind === 'initial' && (history.filter(item => item.status !== 'cancelled' && (item.kind === 'initial' || item.kind === 'reminder')).length >= 3 ||
          !chooseNotification('initial', prior.map(item => ({ kind: String(item.kind), at: Date.parse(item.created_iso), status: String(item.status) })), now))) continue;
      await connection.execute(`INSERT IGNORE INTO sms_critical_notifications
        (incident_id, fishpen_id, owner_user_id, device_id, fishpen_name, recipient_type, recipient_phone,
         kind, critical_keys, source_kind, source_id, measured_at, message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [incidentId, pen.id, input.owner, input.deviceId, pen.name, recipient.type, recipient.phone, kind, keys.join(','),
          input.sourceKind, input.sourceId, sqlTime(snapshot.at), combinedMessage(pen.name, keys, snapshot.values, snapshot.at)]);
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function drainIncidentSms(db: Pool, sender = sendSms, configured = isSmsConfigured()) {
  await db.execute(`UPDATE sms_critical_notifications SET status = 'cancelled', provider_response = 'Snapshot expired before submission.'
    WHERE status = 'pending' AND measured_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 SECOND)`);
  await db.execute(`UPDATE sms_critical_notifications SET status = 'unknown', provider_response = 'Worker interrupted; delivery unknown. No automatic retry.'
    WHERE status = 'sending' AND attempted_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 MINUTE)`);
  if (!configured || !waterSmsPolicy().reviewed) return;
  for (let index = 0; index < 10; index++) {
    const connection = await db.getConnection();
    let job: RowDataPacket | undefined;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<RowDataPacket[]>(`SELECT n.*, DATE_FORMAT(n.measured_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS measured_iso
        FROM sms_critical_notifications n WHERE n.status = 'pending' ORDER BY n.id LIMIT 1 FOR UPDATE`);
      job = rows[0];
      if (!job) { await connection.commit(); break; }
      const [pens] = await connection.query<RowDataPacket[]>(`SELECT p.*, u.phone AS owner_phone FROM sms_fishpens p
        JOIN users u ON u.id = p.owner_user_id JOIN owner_fishpen_assignments a ON a.fishpen_id = p.id AND a.owner_user_id = u.id
        JOIN sensor_devices d ON d.id = p.device_id AND d.owner_user_id = u.id AND d.is_active = 1
        WHERE p.id = ? AND p.owner_user_id = ? AND p.device_id = ? AND u.role = 'farmer' AND u.account_status = 'ACTIVE'`, [job.fishpen_id, job.owner_user_id, job.device_id]);
      const [states] = await connection.query<RowDataPacket[]>(`SELECT incident_id, confirmed_json,
        DATE_FORMAT(last_sampled_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS sampled_iso FROM sms_critical_state WHERE fishpen_id = ?`, [job.fishpen_id]);
      const current = parseJson<Parameter[]>(states[0]?.confirmed_json, []);
      const permitted = pens[0] && incidentRecipients(pens[0] as Parameters<typeof recipients>[0]).some(r => r.phone === job!.recipient_phone && r.type === job!.recipient_type);
      const currentKeys = String(job.critical_keys).split(',').filter(Boolean).sort().join(',') === [...current].sort().join(',');
      const fresh = Date.now() - Date.parse(job.measured_iso) <= SNAPSHOT_MAX_AGE_MS &&
        states[0]?.sampled_iso && Date.now() - Date.parse(states[0].sampled_iso) <= SNAPSHOT_MAX_AGE_MS;
      const status = permitted && Number(states[0]?.incident_id) === Number(job.incident_id) && currentKeys && fresh ? 'sending' : 'cancelled';
      await connection.execute('UPDATE sms_critical_notifications SET status = ?, attempted_at = UTC_TIMESTAMP(3), provider_response = ? WHERE id = ?',
        [status, status === 'cancelled' ? 'Stale, changed, resolved, reassigned, or recipient disabled before send.' : null, job.id]);
      await connection.commit();
      if (status !== 'sending') job = undefined;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    if (!job) continue;
    let result: Awaited<ReturnType<typeof sendSms>>;
    try { result = await sender(job.recipient_phone, job.message, { singleAttempt: true }); }
    catch { result = { configured: true, ok: false, uncertain: true, message: 'Provider request interrupted.' }; }
    await db.execute('UPDATE sms_critical_notifications SET status = ?, provider_response = ?, provider_message_id = ?, provider = ? WHERE id = ?',
      [result.ok ? 'accepted' : result.uncertain ? 'unknown' : 'failed', result.message.slice(0, 500), result.messageId || null, result.provider || null, job.id]);
  }
}
