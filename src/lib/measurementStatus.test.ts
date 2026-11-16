import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measuredStatus } from './measurementStatus';

test('partial measurements retain safe, warning and critical classifications', () => {
  assert.equal(measuredStatus({ ph: 7.2 }), 'safe');
  assert.equal(measuredStatus({ ph: 8.8 }), 'warning');
  assert.equal(measuredStatus({ ph: 9.2 }), 'critical');
  assert.equal(measuredStatus({ temperature: 35 }), 'warning');
  assert.equal(measuredStatus({ ph: 9.2, temperature: 35 }), 'critical');
});
test('missing values do not become zero or establish safety', () => {
  assert.equal(measuredStatus({ ph: null, temperature: null }), 'partial');
  assert.equal(measuredStatus({ ph: 7.2, dissolvedOxygen: null }), 'safe');
  assert.equal(measuredStatus({ ph: NaN }), 'partial');
  assert.equal(measuredStatus({ dissolvedOxygen: 0 }), 'critical');
});
