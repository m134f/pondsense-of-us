import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTurbidity } from './turbidityEstimate';

test('evaluates the reference formula and keeps validity separate', () => {
  for (const [voltage, ntu, validity] of [
    [2.90, 5.00, 'uncalibrated'], [2.50, 22.50, 'uncalibrated'], [2.10, 40.00, 'uncalibrated'],
    [2.09, 40.44, 'extrapolated'], [2.00, 44.38, 'extrapolated'], [1.57, 63.19, 'extrapolated'],
    [1.00, 88.13, 'extrapolated'], [0.50, 110.00, 'extrapolated'], [1.757, 55.01, 'extrapolated'],
    [0, 131.88, 'extrapolated'], [3.014, 0.01, 'extrapolated'], [3.015, null, 'invalid'], [3.30, null, 'invalid']
  ] as const) assert.deepEqual(estimateTurbidity(voltage), { voltage, ntu, validity });
});

test('rejects negative, out-of-bounds, and missing input without manufacturing a value', () => {
  for (const input of [-0.01, 3.31, NaN, Infinity]) {
    assert.deepEqual(estimateTurbidity(input), { voltage: null, ntu: null, validity: 'invalid' });
  }
  assert.deepEqual(estimateTurbidity(null), { voltage: null, ntu: null, validity: 'missing' });
});
