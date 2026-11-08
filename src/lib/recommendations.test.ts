import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommend, referenceThresholds, completeMeasuredValues, waterSummary, recommendationCopy, type Measurements } from './recommendations';
import { daysUntilHarvest, harvestReminderDue, harvestStage, estimatedRemainingStock, recentMortality, csvCell } from './harvest';

const now = Date.parse('2026-11-06T04:00:00Z');
const measurement = (value: number, source: 'manual' | 'sensor' = 'sensor') => ({ value, source, recordedAt: new Date(now).toISOString() });
test('missing parameters cannot become safe or enter a full score', () => {
  const items = recommend({ temperature: measurement(28), turbidity: measurement(50) }, referenceThresholds, now);
  assert.equal(items.filter(i => i.state === 'missing').length, 3);
  assert.equal(waterSummary(items), 'incomplete');
  assert.equal(completeMeasuredValues(items), null);
  assert.ok(items.filter(i => i.state === 'missing').every(i => i.value === null));
});
test('sensor freshness, manual freshness, disconnected and unverified values', () => {
  const values: Measurements = { ph: { ...measurement(7), recordedAt: new Date(now - 31000).toISOString() },
    temperature: { ...measurement(28), unavailable: true }, turbidity: { ...measurement(50), estimated: true },
    dissolvedOxygen: { ...measurement(6, 'manual'), recordedAt: new Date(now - 3600000).toISOString() },
    ammonia: { ...measurement(.02, 'manual'), recordedAt: new Date(now - 86400001).toISOString() } };
  const result = Object.fromEntries(recommend(values, referenceThresholds, now).map(i => [i.parameter, i.state]));
  assert.deepEqual(result, { ph: 'stale', temperature: 'unavailable', turbidity: 'unverified', dissolvedOxygen: 'safe', ammonia: 'stale' });
});
test('configured ranges and critical combination explain priority', () => {
  const items = recommend({ temperature: measurement(31.8), dissolvedOxygen: measurement(4, 'manual'), ammonia: measurement(.08, 'manual') }, { ...referenceThresholds, temperature: [25, 30] }, now);
  assert.equal(items[0].priority, 'URGENT');
  assert.equal(items.filter(i => i.rule === 'combined-low-do-high-ammonia-v1').length, 2);
  assert.equal(items.find(i => i.parameter === 'temperature')?.state, 'warning');
  assert.match(recommendationCopy(items[0], false).why, /together/);
  assert.match(recommendationCopy(items[0], true).why, /Sabay/);
});
test('complete measured values preserve all five parameters without redistribution', () => {
  const values = { ph: 7.5, temperature: 28, dissolvedOxygen: 6, turbidity: 50, ammonia: .02 };
  const items = recommend(Object.fromEntries(Object.entries(values).map(([k,v]) => [k, measurement(v, 'manual')])), referenceThresholds, now);
  assert.equal(waterSummary(items), 'safe');
  assert.deepEqual(completeMeasuredValues(items), values);
});
test('7-day, 1-day, due and overdue reminders; dates never complete a batch', () => {
  for (const target of ['2026-11-13', '2026-11-07', '2026-11-06', '2026-11-05']) assert.equal(harvestReminderDue(target, '2026-11-06'), true);
  assert.equal(harvestReminderDue('2026-11-08', '2026-11-06'), false);
  assert.equal(daysUntilHarvest('2026-11-25', '2026-11-06'), 19);
  assert.equal(harvestStage('2026-11-05', '2026-11-06'), 'overdue');
  assert.equal(harvestStage('2026-11-06', '2026-11-06'), 'due');
  assert.equal(harvestStage('2026-11-13', '2026-11-06'), 'approaching');
  assert.equal(harvestStage('2026-12-01', '2026-11-06'), 'planned');
  assert.equal(harvestStage('2026-11-05', '2026-11-06', true), 'completed');
});
test('remaining stock and recent mortality use recorded events only', () => {
  assert.equal(estimatedRemainingStock(100, [{ deadCount: 5 }], [{ fishCount: 20 }, { fishCount: null }]), 75);
  assert.equal(recentMortality([{ mortalityDate: '2026-11-06', deadCount: 3 }, { mortalityDate: '2026-10-31', deadCount: 4 }, { mortalityDate: '2026-10-30', deadCount: 99 }], '2026-11-06'), 7);
  assert.equal(csvCell('=SUM(A1)'), '"\'=SUM(A1)"');
  assert.equal(csvCell('Pen "A", lake'), '"Pen ""A"", lake"');
});
