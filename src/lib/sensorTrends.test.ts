import assert from 'node:assert/strict';
import test from 'node:test';
import { compareClassC, filterTrendReadings, makeTrendSeries, type TrendReading } from './sensorTrends';

const now = Date.parse('2026-11-23T03:00:00Z');
const day = 86_400_000;
function row(id: number, age: number, changes: Partial<TrendReading> = {}): TrendReading {
  return { id, sampledAt: new Date(now - age).toISOString(), ph: 7, temperatureC: 29, turbidityNtu: 90, ...changes };
}

test('date windows use sampled time only; legacy receipts, invalid dates and future readings stay excluded', () => {
  const receiptOnly = { ...row(5, 0, { sampledAt: null }), recordedAt: new Date(now).toISOString() };
  const input = [row(1, 28 * day), row(2, 2 * day), row(3, 20_000), row(4, 32 * day),
    receiptOnly, row(6, -1000), row(7, 0, { sampledAt: '2026-11-23T02:30:00' })];
  for (const [days, expected] of [[1, [3]], [7, [2, 3]], [30, [1, 2, 3]]] as const) {
    const filtered = filterTrendReadings(input, days, now);
    assert.deepEqual(filtered.points.map(([, reading]) => reading.id), expected);
    assert.equal(filtered.untimedIds.length, 3);
  }
});

test('explicit gaps, long outages, and individual points are preserved without adding sample timestamps', () => {
  const input = [row(6, 0), row(5, 20_000, { ph: 20 }), row(4, 100_000), row(3, 110_000),
    row(2, 120_000, { ph: null }), row(1, 130_000)];
  const { rows, latest } = makeTrendSeries(filterTrendReadings(input, 1, now).points, 'ph');
  assert.deepEqual(rows.map(point => point.segment), [0, null, 1, 1, null, 2]);
  assert.equal(rows.length, input.length);
  assert.deepEqual(latest, { time: now, value: 7 });
  const outage = makeTrendSeries(filterTrendReadings([row(1, 100_000), row(2, 0)], 1, now).points, 'ph');
  assert.deepEqual(outage.rows.map(point => point.segment), [0, 1]);
  const untimed = filterTrendReadings([row(1, 20_000), row(2, 0, { sampledAt: null }), row(3, 0)], 1, now);
  assert.deepEqual(makeTrendSeries(untimed.points, 'ph', untimed.untimedIds).rows.map(point => point.segment), [0, 1]);
});

test('missing DO and estimated-only turbidity never become measured zero', () => {
  const rawOnly = { ...row(1, 0, { turbidityNtu: null }), rawValue: 0 };
  const { points } = filterTrendReadings([rawOnly], 1, now);
  for (const key of ['dissolvedOxygen', 'turbidity'] as const) {
    const series = makeTrendSeries(points, key);
    assert.equal(series.latest, null);
    assert.equal(series.rows[0].value, null);
  }
  assert.equal(makeTrendSeries(filterTrendReadings([row(1, 0, { turbidityNtu: 0 })], 1, now).points, 'turbidity').latest?.value, 0);
});

test('Class C comparisons include boundaries and do not assign an NTU guideline', () => {
  assert.equal(compareClassC('ph', 9), 'within');
  assert.equal(compareClassC('ph', 6.49), 'below');
  assert.equal(compareClassC('temperature', 32), 'above');
  assert.equal(compareClassC('dissolvedOxygen', 4.99), 'below');
  assert.equal(compareClassC('dissolvedOxygen', 5), 'within');
  assert.equal(compareClassC('turbidity', 250), 'unreferenced');
});
