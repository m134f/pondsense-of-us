import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SessionRecord, WaterParams } from '../../src/types';
import { historyTimestamp } from '../../src/lib/historyDates';

export function parseManualSaveTime(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)) return null;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value ? time : null;
}

export async function saveManualReading(db: Pool, owner: number, reading: Partial<WaterParams>, saveTime?: Date): Promise<SessionRecord | null> {
  const values = [reading.ph ?? null, reading.temperature ?? null, reading.dissolvedOxygen ?? null, reading.turbidity ?? null];
  const selection = 'SELECT id, recorded_at, ph, temperature, dissolved_oxygen, turbidity FROM water_readings';
  const toSession = (row: RowDataPacket): SessionRecord => ({
    id: String(row.id), inputMode: 'manual', turbidityEstimated: false,
    timestamp: historyTimestamp(new Date(row.recorded_at)),
    recordedAt: new Date(row.recorded_at).toISOString(),
    ph: row.ph === null ? null : Number(row.ph), temperature: row.temperature === null ? null : Number(row.temperature),
    dissolvedOxygen: row.dissolved_oxygen === null ? null : Number(row.dissolved_oxygen),
    turbidity: row.turbidity === null ? null : Number(row.turbidity),
    ammonia: null, bestFish: '', score: null
  });
  const insert = async (conn: Pool | PoolConnection) => {
    const [result] = await conn.execute<ResultSetHeader>(
      `INSERT INTO water_readings (user_id, input_mode, ph, temperature, dissolved_oxygen, turbidity, ammonia, best_fish, best_score, confidence, status
        ${saveTime ? ', recorded_at' : ''})
        VALUES (?, 'manual', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL${saveTime ? ', ?' : ''})`,
      [owner, ...values, ...(saveTime ? [saveTime] : [])]);
    const [rows] = await conn.execute<RowDataPacket[]>(`${selection} WHERE id = ? AND user_id = ?`, [result.insertId, owner]);
    return toSession(rows[0]);
  };
  if (!saveTime) return insert(db);

  // Serialize an owner's saves so retries with the same confirmation second
  // and values can reuse the committed record without a schema change.
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [owner]);
    const [matches] = await conn.execute<RowDataPacket[]>(`${selection}
      WHERE user_id = ? AND recorded_at = ? AND input_mode = 'manual' AND ammonia IS NULL AND status IS NULL
        AND ph <=> CAST(? AS DECIMAL(4,2)) AND temperature <=> CAST(? AS DECIMAL(5,2))
        AND dissolved_oxygen <=> CAST(? AS DECIMAL(5,2)) AND turbidity <=> CAST(? AS DECIMAL(8,2))
      ORDER BY id LIMIT 1`, [owner, saveTime, ...values]);
    const age = Date.now() - saveTime.getTime();
    const record = matches[0] ? toSession(matches[0]) : age < -60_000 || age > 15 * 60_000 ? null : await insert(conn);
    await conn.commit();
    return record;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
