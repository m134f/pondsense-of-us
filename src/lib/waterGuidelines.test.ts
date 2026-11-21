import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartValue, classCGuidelines } from './waterGuidelines';
import { lowOxygenGuidance, recommend, referenceThresholds } from './recommendations';

test('official Class C chart values are separate from operational alert rules; no official turbidity NTU line', () => {
  assert.deepEqual(classCGuidelines.ph, { min: 6.5, max: 9, unit: 'pH' });
  assert.deepEqual(classCGuidelines.temperature, { min: 25, max: 31, unit: '°C' });
  assert.deepEqual(classCGuidelines.dissolvedOxygen, { min: 5, unit: 'mg/L' });
  assert.equal(classCGuidelines.turbidity, undefined);
  assert.equal(chartValue('turbidity', 40, true), null);
  assert.equal(chartValue('ph', 15), null);
  assert.equal(chartValue('temperature', null), null);
  assert.equal(chartValue('ph', 7), 7);
});

test('LLDA behavior guidance is shown only for valid low DO, never from missing or stale values', () => {
  const now = Date.parse('2026-11-21T05:00:00Z');
  const measured = (value: number, recordedAt = new Date(now).toISOString()) => ({ value, source: 'sensor' as const, recordedAt });
  const low = recommend({ dissolvedOxygen: measured(2) }, referenceThresholds, now).find(item => item.parameter === 'dissolvedOxygen')!;
  assert.match(lowOxygenGuidance(low, false)!.emergency, /Only if severe distress persists/);
  for (const item of [
    recommend({}, referenceThresholds, now).find(row => row.parameter === 'dissolvedOxygen')!,
    recommend({ dissolvedOxygen: measured(2, new Date(now - 31_000).toISOString()) }, referenceThresholds, now).find(row => row.parameter === 'dissolvedOxygen')!,
    recommend({ dissolvedOxygen: measured(6) }, referenceThresholds, now).find(row => row.parameter === 'dissolvedOxygen')!
  ]) assert.equal(lowOxygenGuidance(item, false), null);
});
