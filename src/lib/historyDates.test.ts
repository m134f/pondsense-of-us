import assert from 'node:assert/strict';
import test from 'node:test';
import { historyRecordDay, isHistoryDay, manilaDay, resolveHistoryRange } from './historyDates';

test('calendar-day presets use Philippine time and include today', () => {
  const today = manilaDay(new Date('2026-01-01T16:00:00Z'));
  assert.equal(today, '2026-01-02');
  const empty = { from: '', to: '' };
  assert.deepEqual(resolveHistoryRange('today', today, empty), { from: today, to: today });
  assert.deepEqual(resolveHistoryRange('week', today, empty), { from: '2025-12-27', to: today });
  assert.deepEqual(resolveHistoryRange('month', today, empty), { from: '2025-12-04', to: today });
});

test('custom dates reject impossible days and reversed periods', () => {
  const today = '2026-11-28';
  assert.equal(resolveHistoryRange('custom', today, { from: today, to: '2026-11-27' }), null);
  assert.equal(resolveHistoryRange('custom', today, { from: '', to: today }), null);
  assert.equal(isHistoryDay('2026-02-29'), false);
  assert.equal(isHistoryDay('2024-02-29'), true);
});

test('canonical timestamps take priority and old display-only records still filter', () => {
  assert.equal(historyRecordDay({ recordedAt: '2026-11-27T16:00:00Z', timestamp: '11/27/2026, 4:00:00 PM' }), '2026-11-28');
  assert.equal(historyRecordDay({ timestamp: '11/27/2026, 6:42:00 AM' }), '2026-11-27');
  assert.equal(historyRecordDay({ timestamp: 'unknown' }), null);
});
