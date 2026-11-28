import assert from 'node:assert/strict';
import test from 'node:test';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { loadReadingHistory, readingHistoryBounds } from './ReadingHistory';

test('reading date bounds reject malformed or repeated params and use an exclusive PHT end', () => {
  assert.equal(readingHistoryBounds(undefined, undefined), undefined);
  assert.equal(readingHistoryBounds('2026-11-28', undefined), null);
  assert.equal(readingHistoryBounds(['2026-11-28'], '2026-11-28'), null);
  assert.equal(readingHistoryBounds('2026-11-29', '2026-11-28'), null);
  assert.deepEqual(readingHistoryBounds('2026-11-28', '2026-11-28')?.map(d => d.toISOString()), [
    '2026-11-27T16:00:00.000Z', '2026-11-28T16:00:00.000Z'
  ]);
});

const port = Number(process.env.READING_HISTORY_TEST_PORT);
test('database applies range before row limits and retains farmer and water-contact filters', { skip: !port }, async () => {
  const db = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', timezone: 'Z', connectionLimit: 1 });
  const conn = await db.getConnection();
  try {
    const [[instance]] = await conn.query<RowDataPacket[]>('SELECT @@datadir AS datadir');
    assert.match(String(instance.datadir).replaceAll('\\', '/'), /\/pondsense-reading-history-test-[^/]+\/?$/i);
    await conn.query('USE mysql');
    await conn.query(`CREATE TEMPORARY TABLE water_readings (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, input_mode VARCHAR(10),
      recorded_at DATETIME, ph DECIMAL(4,2), temperature DECIMAL(5,2), dissolved_oxygen DECIMAL(5,2),
      turbidity DECIMAL(8,2), ammonia DECIMAL(7,3), best_fish VARCHAR(100), best_score DECIMAL(6,2))`);
    await conn.query('CREATE TEMPORARY TABLE hardware_assignments (id INT PRIMARY KEY, fishpen_name VARCHAR(100))');
    await conn.query(`CREATE TEMPORARY TABLE sensor_telemetry (id INT PRIMARY KEY, owner_user_id INT, fishpen_id INT, assignment_id INT, sampled_at DATETIME,
      recorded_at DATETIME, ph DECIMAL(4,2), temperature_c DECIMAL(5,2), dissolved_oxygen DECIMAL(5,2), turbidity_ntu DECIMAL(8,2), water_contact_confirmed BOOLEAN)`);
    await conn.query('INSERT INTO water_readings (user_id,input_mode,recorded_at) VALUES ?', [[
      [2, 'manual', '2026-11-27 15:59:59'], [2, 'manual', '2026-11-27 16:00:00'],
      [2, 'manual', '2026-11-28 16:00:00'], [3, 'manual', '2026-11-27 16:00:01'],
      ...Array.from({ length: 50 }, () => [2, 'manual', '2026-11-29 00:00:00'])
    ]]);
    await conn.query(`INSERT INTO sensor_telemetry (id,owner_user_id,sampled_at,recorded_at,water_contact_confirmed) VALUES
      (1,2,'2026-11-28 15:59:59','2026-11-30 00:00:00',TRUE),
      (2,2,'2026-11-28 15:59:59','2026-11-30 00:00:00',FALSE),
      (3,3,'2026-11-28 15:59:59','2026-11-30 00:00:00',TRUE),
      (4,2,NULL,'2026-11-28 12:00:00',TRUE)`);
    assert.ok(!(await loadReadingHistory(conn, 2)).some(row => row.id === '2'));
    const bounds = readingHistoryBounds('2026-11-28', '2026-11-28');
    assert.ok(bounds);
    const result = await loadReadingHistory(conn, 2, bounds);
    assert.deepEqual(result.map(row => row.id), ['sensor-1', 'sensor-4', '2']);
    assert.equal(result[2].recordedAt, '2026-11-27T16:00:00.000Z');
  } finally {
    conn.release();
    await db.end();
  }
});
