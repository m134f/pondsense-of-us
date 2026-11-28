import assert from 'node:assert/strict';
import test from 'node:test';
import { fishDatabase } from '../data/fish';
import { analyzeSensorSuitability, monitoringValues } from './sensorSuitability';

const [tilapia, bangus, mamali] = fishDatabase;
const readings = { ph: 7.5, temperatureC: 28, dissolvedOxygen: 6, turbidityNtu: 30 };

test('in-range percentage uses measured values and preserves ties without inventing suitability', () => {
  const values = monitoringValues({ ...readings, dissolvedOxygen: null, turbidityNtu: 29, turbidityEstimated: true });
  const result = analyzeSensorSuitability([tilapia, bangus, mamali], values, null);
  assert.deepEqual(result.missing, ['dissolvedOxygen', 'turbidity']);
  assert.deepEqual(result.matches.map(row => [row.fish.id, row.rank, row.percentage]), [['bangus', 1, 100], ['tilapia', 1, 100]]);
  assert.deepEqual(result.unscored.map(row => row.fish.id), ['mamali']);
});

test('a 3 of 4 match is 75%, not a full match even when it ranks first', () => {
  const result = analyzeSensorSuitability([tilapia], monitoringValues({ ...readings, temperatureC: 34 }), null);
  assert.equal(result.measured, 4);
  assert.equal(result.matches[0].percentage, 75);
  assert.equal(result.matches[0].matches.length, 3);
});

test('critical measured DO blocks ranking; out-of-domain and provisional values cannot block', () => {
  const blocked = analyzeSensorSuitability([tilapia], monitoringValues({ ...readings, dissolvedOxygen: 2 }), null);
  assert.deepEqual(blocked.critical, ['dissolvedOxygen']);
  assert.deepEqual(blocked.matches, []);
  const pending = { warningFrom: 25, criticalAbove: 100, approval: 'pending' } as const;
  const values = monitoringValues({ ...readings, ph: 15, turbidityNtu: 200 });
  assert.deepEqual(analyzeSensorSuitability([tilapia], values, pending).critical, []);
  assert.deepEqual(analyzeSensorSuitability([tilapia], values, { ...pending, approval: 'approved' }).critical, ['turbidity']);
});
