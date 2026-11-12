import type { Pool, PoolConnection } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { recommend, referenceThresholds, units, parameters, type Measurements, type Parameter, type Recommendation } from '../../src/lib/recommendations';
import { isSmsConfigured, sendSms } from '../sms';

const utcSql = (date: Date) => date.toISOString().slice(0, 23).replace('T', ' ');

export function philippinePhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const phone = value.trim().replace(/[\s()-]/g, '');
  if (/^09\d{9}$/.test(phone)) return `+63${phone.slice(1)}`;
  if (/^639\d{9}$/.test(phone)) return `+${phone}`;
  return /^\+639\d{9}$/.test(phone) ? phone : null;
}

export function validateSmsSettings(body: Record<string, unknown>) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const deviceId = body.deviceId === null ? null : Number(body.deviceId);
  const caretakerPhone = body.caretakerPhone === '' || body.caretakerPhone === null ? null : philippinePhone(body.caretakerPhone);
  if (!name || name.length > 100 || /[\r\n\x00-\x1f]/.test(name)) throw new Error('Enter a fishpen name (1-100 characters).');
  if (deviceId !== null && (!Number.isSafeInteger(deviceId) || deviceId <= 0)) throw new Error('Select an assigned sensor device or no device.');
  if (typeof body.ownerEnabled !== 'boolean' || typeof body.caretakerEnabled !== 'boolean') throw new Error('Invalid SMS switch value.');
  if (body.caretakerPhone && !caretakerPhone) throw new Error('Enter a valid Philippine mobile number, e.g. 09XXXXXXXXX.');
  if (body.caretakerEnabled && !caretakerPhone) throw new Error('Add a caretaker number before enabling SMS.');
  return { name, deviceId, caretakerPhone, ownerEnabled: body.ownerEnabled, caretakerEnabled: body.caretakerEnabled };
}

export function recipients(pen: { owner_phone: unknown; owner_enabled: unknown; caretaker_phone: unknown; caretaker_enabled: unknown }) {
  const result: Array<{ type: 'owner' | 'caretaker'; phone: string }> = [];
  const owner = philippinePhone(pen.owner_phone);
  const caretaker = philippinePhone(pen.caretaker_phone);
  if (pen.owner_enabled && owner) result.push({ type: 'owner', phone: owner });
  if (pen.caretaker_enabled && caretaker && !result.some(r => r.phone === caretaker)) result.push({ type: 'caretaker', phone: caretaker });
  return result;
}

// Review is an explicit deployment gate, not a claim that software validates science.
export function waterSmsPolicy() {
  const reference = (process.env.WATER_SMS_RULES_REFERENCE || '').trim();
  return { reviewed: process.env.WATER_SMS_THRESHOLDS_REVIEWED === 'true' && reference.length >= 10, reference };
}

export function sensorSmsMeasurements(values: Partial<Record<Parameter, number | null>>, body: Record<string, unknown>): Measurements {
  const sampledAt = typeof body.sampledAt === 'string' ? body.sampledAt : null;
  const verified = Array.isArray(body.verifiedParameters) ? body.verifiedParameters : [];
  return Object.fromEntries(parameters.map(parameter => [parameter, {
    value: values[parameter] ?? null, source: 'sensor', recordedAt: sampledAt,
    estimated: !verified.includes(parameter) || (parameter === 'turbidity' && body.probeSubmerged !== true)
  }]));
}

export function alertSignature(item: Recommendation): string | null {
  if (!['safe', 'warning', 'critical'].includes(item.state)) return null;
  if (item.state === 'safe') return 'safe';
  return `${item.state}:${item.value! < item.range[0] ? 'low' : 'high'}`;
}

export function formatWaterSms(name: string, item: Recommendation) {
  const stamp = new Date(item.recordedAt!).toLocaleString('en-PH', { timeZone: 'Asia/Manila', hour12: false });
  return `PONDSENSE ALERT!\nStatus: ${item.state === 'critical' ? 'DANGER' : 'WARNING'}\nFishpen: ${name}\nParameter: ${item.parameter}\nReading: ${item.value} ${units[item.parameter]}\nTime: ${stamp} PHT\nAction: Please check water conditions and fish behavior.`;
}

export async function ownedFishpen(connection: Pool | PoolConnection, id: number, owner: number, lock = false) {
  const [rows] = await connection.query<RowDataPacket[]>(`SELECT * FROM sms_fishpens WHERE id = ? AND owner_user_id = ?${lock ? ' FOR UPDATE' : ''}`, [id, owner]);
  return rows[0] || null;
}

export async function queueWaterSms(db: Pool, input: {
  owner: number; deviceId?: number; fishpenId?: number; sourceId: number; sourceKind: string; measurements: Measurements;
}, now = Date.now()) {
  if (!waterSmsPolicy().reviewed) return;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    // Lock ownership as well as the fishpen so reassignment cannot leak new readings.
    if (input.deviceId) {
      const [devices] = await connection.query<RowDataPacket[]>('SELECT device_name FROM sensor_devices WHERE id = ? AND owner_user_id = ? AND is_active = 1 FOR UPDATE', [input.deviceId, input.owner]);
      if (!devices.length) { await connection.rollback(); return; }
      await connection.execute('UPDATE sms_fishpens SET device_id = NULL WHERE device_id = ? AND owner_user_id <> ?', [input.deviceId, input.owner]);
      // Existing devices retain an owner-only destination; farmers can rename this fishpen.
      await connection.execute(`INSERT IGNORE INTO sms_fishpens (owner_user_id, name, device_id) VALUES (?, ?, ?)`, [input.owner, String(devices[0].device_name).slice(0, 100), input.deviceId]);
    }
    const [pens] = await connection.query<RowDataPacket[]>(`SELECT p.*, u.phone AS owner_phone FROM sms_fishpens p
      JOIN users u ON u.id = p.owner_user_id WHERE p.${input.deviceId ? 'device_id' : 'id'} = ? AND p.owner_user_id = ?
      AND u.role = 'farmer' AND u.phone <> '+639000000000' FOR UPDATE`, [input.deviceId || input.fishpenId || 0, input.owner]);
    const pen = pens[0];
    if (!pen) { await connection.rollback(); return; }
    for (const item of recommend(input.measurements, referenceThresholds, now)) {
      const signature = alertSignature(item);
      if (!signature) continue;
      const measured = new Date(item.recordedAt!);
      if (now - measured.getTime() > 30_000) continue;
      const [states] = await connection.query<RowDataPacket[]>("SELECT signature, generation, DATE_FORMAT(measured_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS measured_at FROM sms_water_state WHERE fishpen_id = ? AND parameter_name = ?", [pen.id, item.parameter]);
      const previous = states[0];
      if (previous && measured.getTime() <= new Date(previous.measured_at).getTime()) continue;
      const generation = previous ? Number(previous.generation) + Number(previous.signature !== signature) : 1;
      await connection.execute(`INSERT INTO sms_water_state (fishpen_id, parameter_name, signature, generation, measured_at) VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE signature = VALUES(signature), generation = VALUES(generation), measured_at = VALUES(measured_at)`, [pen.id, item.parameter, signature, generation, utcSql(measured)]);
      if (item.state === 'safe') continue;
      for (const recipient of recipients(pen as Parameters<typeof recipients>[0])) {
        // Recovery chatter is rate-limited; escalation to danger can bypass a warning cooldown.
        const [recent] = await connection.query<RowDataPacket[]>(`SELECT id FROM sms_water_attempts WHERE fishpen_id = ? AND recipient_phone = ?
          AND parameter_name = ? AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 15 MINUTE)
          AND (? <> 'critical' OR severity = 'critical') LIMIT 1`, [pen.id, recipient.phone, item.parameter, item.state]);
        if (recent.length) continue;
        await connection.execute(`INSERT IGNORE INTO sms_water_attempts
          (fishpen_id, owner_user_id, fishpen_name, device_id, source_id, source_kind, recipient_type, recipient_phone,
           parameter_name, severity, generation, reading_value, measured_at, message, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
          [pen.id, input.owner, pen.name, input.deviceId || null, input.sourceId, input.sourceKind, recipient.type, recipient.phone,
            item.parameter, item.state, generation, item.value, utcSql(measured), formatWaterSms(pen.name, item)]);
      }
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function drainWaterSms(db: Pool, sender = sendSms, configured = isSmsConfigured()) {
  await db.execute(`UPDATE sms_water_attempts SET status = 'cancelled', provider_response = 'Reading expired before provider submission.'
    WHERE status = 'pending' AND measured_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 SECOND)`);
  // A crash after handing a request to the provider is ambiguous: never auto-replay it.
  await db.execute(`UPDATE sms_water_attempts SET status = 'unknown', provider_response = 'Worker interrupted; delivery unknown. No automatic retry.'
    WHERE status = 'sending' AND attempted_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 MINUTE)`);
  if (!configured || !waterSmsPolicy().reviewed) return;
  for (let index = 0; index < 10; index++) {
    const connection = await db.getConnection();
    let job: RowDataPacket | undefined;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<RowDataPacket[]>("SELECT a.*, DATE_FORMAT(measured_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS measured_at FROM sms_water_attempts a WHERE status = ? ORDER BY id LIMIT 1 FOR UPDATE", ['pending']);
      job = rows[0];
      if (!job) { await connection.commit(); break; }
      const [pens] = await connection.query<RowDataPacket[]>(`SELECT p.*, u.phone AS owner_phone FROM sms_fishpens p
        JOIN users u ON u.id = p.owner_user_id LEFT JOIN sensor_devices d ON d.id = p.device_id
        WHERE p.id = ? AND p.owner_user_id = ? AND u.role = 'farmer' AND u.phone <> '+639000000000'
        AND (? IS NULL OR (d.id = ? AND d.owner_user_id = p.owner_user_id AND d.is_active = 1))`, [job.fishpen_id, job.owner_user_id, job.device_id, job.device_id]);
      const [states] = await connection.query<RowDataPacket[]>('SELECT generation, signature FROM sms_water_state WHERE fishpen_id = ? AND parameter_name = ?', [job.fishpen_id, job.parameter_name]);
      const permitted = pens[0] && recipients(pens[0] as Parameters<typeof recipients>[0]).some(r => r.phone === job!.recipient_phone && r.type === job!.recipient_type);
      const fresh = Date.now() - new Date(job.measured_at).getTime() <= 30_000;
      const current = states[0]?.generation === job.generation && states[0]?.signature.startsWith(job.severity);
      const status = permitted && fresh && current ? 'sending' : 'cancelled';
      await connection.execute('UPDATE sms_water_attempts SET status = ?, attempted_at = UTC_TIMESTAMP(), provider_response = ? WHERE id = ?',
        [status, status === 'cancelled' ? 'Expired, recovered, reassigned, or recipient disabled before send.' : null, job.id]);
      await connection.commit();
      if (status !== 'sending') job = undefined;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    if (!job) continue;
    let result: Awaited<ReturnType<typeof sendSms>>;
    try { result = await sender(job.recipient_phone, job.message, { singleAttempt: true }); }
    catch { result = { configured: true, ok: false, uncertain: true, message: 'Provider request interrupted.' }; }
    await db.execute(`UPDATE sms_water_attempts SET status = ?, provider_response = ?, provider_message_id = ?, provider = ? WHERE id = ?`,
      [result.ok ? 'accepted' : result.uncertain ? 'unknown' : 'failed', result.message.slice(0, 500), result.messageId || null, result.provider || null, job.id]);
  }
}
