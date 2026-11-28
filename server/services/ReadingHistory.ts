import type { Pool, RowDataPacket } from 'mysql2/promise';
import { historyTimestamp, isHistoryDay, shiftHistoryDay } from '../../src/lib/historyDates';
import type { SessionRecord } from '../../src/types';

export function readingHistoryBounds(from: unknown, to: unknown) {
  if (from === undefined && to === undefined) return undefined;
  if (!isHistoryDay(from) || !isHistoryDay(to) || from > to || to === '9999-12-31') return null;
  // Application readings use Philippine calendar days; the upper bound is exclusive.
  return [new Date(`${from}T00:00:00+08:00`), new Date(`${shiftHistoryDay(to, 1)}T00:00:00+08:00`)] as const;
}

export async function loadReadingHistory(db: Pick<Pool, 'execute'>, owner: number, bounds?: NonNullable<ReturnType<typeof readingHistoryBounds>>) {
  const range = (column: string) => bounds ? ` AND ${column} >= ? AND ${column} < ?` : '';
  const dates = bounds ?? [];
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT * FROM (
       (SELECT CAST(id AS CHAR) AS id, input_mode, recorded_at, ph, temperature,
        dissolved_oxygen, turbidity, ammonia, best_fish, best_score, 0 AS turbidity_estimated, NULL AS fishpen_id, NULL AS fishpen_name
        FROM water_readings WHERE user_id = ?${range('recorded_at')} ORDER BY recorded_at DESC, id DESC LIMIT 50)
       UNION ALL
       (SELECT CONCAT('sensor-', t.id) AS id, 'sensor' AS input_mode, COALESCE(sampled_at, recorded_at) AS recorded_at, ph,
        temperature_c AS temperature, dissolved_oxygen, turbidity_ntu AS turbidity,
        NULL AS ammonia, NULL AS best_fish, NULL AS best_score, 0 AS turbidity_estimated, t.fishpen_id, a.fishpen_name
        FROM sensor_telemetry t LEFT JOIN hardware_assignments a ON a.id = t.assignment_id
        WHERE t.owner_user_id = ? AND t.water_contact_confirmed = TRUE${range('COALESCE(t.sampled_at, t.recorded_at)')}
        ORDER BY COALESCE(sampled_at, recorded_at) DESC, t.id DESC LIMIT 50)
     ) AS history ORDER BY recorded_at DESC, id DESC LIMIT 100`,
    [owner, ...dates, owner, ...dates]
  );
  return rows.map((row): SessionRecord => {
    const recorded = row.recorded_at ? new Date(row.recorded_at) : null;
    const validTime = recorded && Number.isFinite(recorded.getTime()) ? recorded : null;
    return {
      id: String(row.id),
      timestamp: validTime ? historyTimestamp(validTime) : '',
      recordedAt: validTime?.toISOString(),
      inputMode: row.input_mode,
      turbidityEstimated: Boolean(row.turbidity_estimated),
      ph: row.ph === null ? null : Number(row.ph),
      ...(row.fishpen_id == null ? {} : { fishpenId: Number(row.fishpen_id), fishpenName: row.fishpen_name }),
      temperature: row.temperature === null ? null : Number(row.temperature),
      dissolvedOxygen: row.dissolved_oxygen === null ? null : Number(row.dissolved_oxygen),
      turbidity: row.turbidity === null ? null : Number(row.turbidity),
      ammonia: row.ammonia === null ? null : Number(row.ammonia),
      bestFish: String(row.best_fish || ''),
      score: row.best_score === null ? null : Number(row.best_score)
    };
  });
}
