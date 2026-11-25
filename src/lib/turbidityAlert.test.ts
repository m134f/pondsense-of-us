import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTurbidity, parseTurbidityThresholds, proposedTurbidityRule } from './turbidityAlert';
import { measuredStatus, parameterStatus } from './measurementStatus';

test('the provisional cutoff includes 25 and 100 in Warning and respects edited thresholds', () => {
  for (const [value, expected] of [[0, 'safe'], [24.99, 'safe'], [25, 'warning'], [100, 'warning'], [100.01, 'critical']] as const) {
    assert.equal(classifyTurbidity(value, 'uncalibrated', proposedTurbidityRule, 'preview'), expected);
  }
  assert.equal(classifyTurbidity(100, 'extrapolated', { warningFrom: 30, criticalAbove: 90, approval: 'pending' }, 'preview'), 'critical');
});

test('pending or unverified measurements cannot enter operational status or overall severity', () => {
  const approved = { ...proposedTurbidityRule, approval: 'approved' as const };
  assert.equal(classifyTurbidity(105, 'verified', proposedTurbidityRule), null);
  assert.equal(classifyTurbidity(105, 'verified', approved), 'critical');
  for (const basis of ['uncalibrated', 'extrapolated', 'invalid', 'missing'] as const) {
    assert.equal(classifyTurbidity(105, basis, proposedTurbidityRule), null);
    assert.equal(classifyTurbidity(105, basis, approved), null);
  }
  for (const value of [null, -1, NaN, Infinity, 1001]) assert.equal(classifyTurbidity(value, 'uncalibrated', proposedTurbidityRule, 'preview'), null);
  assert.equal(parameterStatus('turbidity', 210), null);
  assert.equal(measuredStatus({ turbidity: 210 }), 'partial');
  assert.equal(measuredStatus({ turbidity: 210, ph: 7 }), 'safe');
});

test('threshold validation rejects inverted, invalid, out-of-range, and unsupported precision', () => {
  assert.deepEqual(parseTurbidityThresholds({ warningFrom: 25.05, criticalAbove: 101 }), { warningFrom: 25.05, criticalAbove: 101 });
  for (const invalid of [null, {}, { warningFrom: 0, criticalAbove: 1 }, { warningFrom: 5, criticalAbove: 5 },
    { warningFrom: 9, criticalAbove: 8 }, { warningFrom: 3.141, criticalAbove: 20 }, { warningFrom: '25', criticalAbove: 100 },
    { warningFrom: 1, criticalAbove: 1001 }]) assert.equal(parseTurbidityThresholds(invalid), null);
});
