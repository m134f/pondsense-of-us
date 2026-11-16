import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManual, manualWarnings } from './manualValidation';
import type { FishSpecies } from '../types';

test('allows partial data without fabricating missing values', () => {
  assert.deepEqual(validateManual({ ph: '7.2' }).values, { ph: 7.2 });
  assert.equal(validateManual({}).empty, true);
});
test('rejects invalid inputs but accepts physically valid pH extremes', () => {
  for (const ph of ['abc', ' ', true, -1, 15, Infinity]) assert.ok(validateManual({ ph }).errors.ph);
  for (const ph of [0, 4, 9.2, 14]) assert.deepEqual(validateManual({ ph }).errors, {});
  assert.ok(validateManual({ turbidity: -1 }).errors.turbidity);
});
test('uses supplied species ranges, not an invented safe range', () => {
  const fish = [{ ranges: { ph: [6.5, 8.5] } }] as FishSpecies[];
  assert.deepEqual(manualWarnings({ ph: 9.2 }, fish), ['ph']);
  assert.deepEqual(manualWarnings({ ph: 7.2 }, fish), []);
});
