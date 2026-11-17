import test from 'node:test';
import assert from 'node:assert/strict';
import { isManualDecimalDraft, validateManual } from './manualValidation';

test('decimal drafts allow editing and decimal keyboards but reject letters and mixed pasted content', () => {
  for (const value of ['', '7', '7.', '7.2', '.5', '28,5']) assert.equal(isManualDecimalDraft(value), true, value);
  for (const value of ['fsvcvd', '7abc', '1e1', '0xA', '-1', '7..2', '7.2 pH', 'Infinity']) assert.equal(isManualDecimalDraft(value), false, value);
});
test('shared validation rejects non-decimals and preserves partial input and unsafe-but-possible pH', () => {
  for (const ph of ['letters', '1e1', '0xA', '.', '7..2', '-1', '15']) assert.ok(validateManual({ ph }).errors.ph, ph);
  assert.equal(validateManual({ ph: '9.2' }).values.ph, 9.2);
  assert.equal(validateManual({ temperature: '28,5' }).values.temperature, 28.5);
  assert.deepEqual(validateManual({ ph: '7.2', temperature: '' }).values, { ph: 7.2 });
  assert.equal(validateManual({}).empty, true);
});
