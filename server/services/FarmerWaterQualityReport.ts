import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { FarmerWaterRecord, FarmerWaterReport, WaterAssessment } from '../../src/lib/farmerWaterQuality';
import { measuredStatus } from '../../src/lib/measurementStatus';
import { chartValue } from '../../src/lib/waterGuidelines';

const pageSize = 1000;
const utcFormat = "'%Y-%m-%dT%H:%i:%sZ'";
const registeredFarmer = "u.role = 'farmer' AND COALESCE(u.phone, '') <> '+639000000000'";
type StoredReading = RowDataPacket & {
  id: number;
  farmerId: number;
  source: WaterAssessment['source'];
  assessedAt: string | null;
  sampledAt: string | null;
  receivedAt: string;
  previousAssignment: number;
  ph: string | number | null;
  temperature: string | number | null;
  dissolvedOxygen: string | number | null;
  turbidity: string | number | null;
  ammonia: string | number | null;
};

const savedReadings = `SELECT r.id, r.user_id AS farmerId, r.input_mode AS source,
  DATE_FORMAT(r.recorded_at, ${utcFormat}) AS assessedAt, NULL AS sampledAt,
  DATE_FORMAT(r.recorded_at, ${utcFormat}) AS receivedAt, 0 AS previousAssignment,
  r.ph, r.temperature, r.dissolved_oxygen AS dissolvedOxygen, r.turbidity, r.ammonia
  FROM water_readings r JOIN users u ON u.id = r.user_id
  WHERE r.id > ? AND r.input_mode IN ('manual', 'sensor') AND ${registeredFarmer}
  ORDER BY r.id LIMIT ${pageSize}`;

const sensorReadings = `SELECT t.id, t.owner_user_id AS farmerId, 'sensor' AS source,
  DATE_FORMAT(COALESCE(t.sampled_at, t.recorded_at), ${utcFormat}) AS assessedAt,
  DATE_FORMAT(t.sampled_at, ${utcFormat}) AS sampledAt,
  DATE_FORMAT(t.recorded_at, ${utcFormat}) AS receivedAt, (a.ended_at IS NOT NULL) AS previousAssignment,
  t.ph, t.temperature_c AS temperature, t.dissolved_oxygen AS dissolvedOxygen, t.turbidity_ntu AS turbidity, NULL AS ammonia
  FROM sensor_telemetry t JOIN users u ON u.id = t.owner_user_id
  LEFT JOIN hardware_assignments a ON a.id = t.assignment_id AND a.owner_user_id = t.owner_user_id
  WHERE t.id > ? AND t.water_contact_confirmed = TRUE AND ${registeredFarmer}
  ORDER BY t.id LIMIT ${pageSize}`;

const numberOrNull = (value: string | number | null) => value === null ? null : Number(value);

export async function farmerWaterQualityReport(db: Pool, now = Date.now()): Promise<FarmerWaterReport> {
  const conn = await db.getConnection();
  try {
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [accounts] = await conn.query<RowDataPacket[]>(`SELECT u.id, u.full_name AS name, p.name AS fishpenName
      FROM users u LEFT JOIN owner_fishpen_assignments f ON f.owner_user_id = u.id
      LEFT JOIN sms_fishpens p ON p.id = f.fishpen_id AND p.owner_user_id = u.id
      WHERE ${registeredFarmer} ORDER BY u.full_name, u.id`);
    const farmers = new Map<number, FarmerWaterRecord>(accounts.map(row => [row.id, {
      id: row.id, name: row.name, fishpenName: row.fishpenName, latest: null, counts: { safe: 0, warning: 0, critical: 0 }
    }]));

    // Count all assessable history with the dashboard's classifier, without retaining raw readings in memory.
    for (const query of [savedReadings, sensorReadings]) {
      let cursor = 0;
      for (;;) {
        const [readings] = await conn.execute<StoredReading[]>(query, [cursor]);
        for (const reading of readings) {
          const farmer = farmers.get(reading.farmerId);
          const time = Date.parse(reading.assessedAt ?? '');
          const received = Date.parse(reading.receivedAt);
          if (!farmer || !reading.assessedAt || !Number.isFinite(time) || !Number.isFinite(received) || time > now || received > now) continue;
          const status = measuredStatus({
            ph: chartValue('ph', numberOrNull(reading.ph)),
            temperature: chartValue('temperature', numberOrNull(reading.temperature)),
            dissolvedOxygen: chartValue('dissolvedOxygen', numberOrNull(reading.dissolvedOxygen)),
            turbidity: chartValue('turbidity', numberOrNull(reading.turbidity)),
            ammonia: numberOrNull(reading.ammonia)
          });
          if (status === 'partial') continue;
          farmer.counts[status]++;
          if (!farmer.latest || time >= Date.parse(farmer.latest.assessedAt)) farmer.latest = {
            source: reading.source, status, assessedAt: reading.assessedAt, sampledAt: reading.sampledAt,
            receivedAt: reading.receivedAt, previousAssignment: Boolean(reading.previousAssignment)
          };
        }
        if (readings.length < pageSize) break;
        cursor = readings[readings.length - 1].id;
      }
    }
    const totals = { safe: 0, warning: 0, critical: 0, noData: 0 };
    const rows = [...farmers.values()];
    for (const row of rows) totals[row.latest?.status ?? 'noData']++;
    await conn.commit();
    return { farmers: rows, totals, updatedAt: new Date(now).toISOString() };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
