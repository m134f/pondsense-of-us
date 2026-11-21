import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceIncident, chooseNotification, emptyIncidentState, sensorSnapshot, RECOVERY_MS, ROUTINE_INTERVAL_MS, UPDATE_INTERVAL_MS } from './services/IncidentPolicy';
import { sensorSmsMeasurements } from './services/FishpenSms';

const base = Date.parse('2026-11-21T01:00:00.000Z');
function sample(at: number, values: { ph: number; temperature?: number; dissolvedOxygen?: number; ammonia?: number }, verified = ['ph', 'temperature', 'dissolvedOxygen', 'ammonia']) {
  return sensorSnapshot(sensorSmsMeasurements(values, { sampledAt: new Date(at).toISOString(), verifiedParameters: verified }), at);
}

test('two consecutive fresh critical sensor snapshots confirm, warning and manual do not', () => {
  const first = sample(base, { ph: 5.5, temperature: 33 })!;
  assert.deepEqual(first.critical, ['ph']);
  const one = advanceIncident(emptyIncidentState(), first)!;
  assert.deepEqual(one.state.confirmed, []);
  const two = advanceIncident(one.state, sample(base + 10_000, { ph: 5.5, temperature: 33 })!)!;
  assert.deepEqual(two.state.confirmed, ['ph']);
  assert.deepEqual(sample(base, { ph: 6.2, temperature: 33 })!.critical, []);
  assert.equal(sensorSnapshot({ ph: { value: 5, source: 'manual', recordedAt: new Date(base).toISOString() } }, base)?.critical.length, 0);
});

test('invalid, unverified and stale sensor readings cannot trigger; replay and gaps do not confirm', () => {
  assert.equal(sensorSnapshot(sensorSmsMeasurements({ ph: 5 }, { sampledAt: new Date(base).toISOString(), verifiedParameters: ['ph'] }), base + 31_000), null);
  assert.deepEqual(sample(base, { ph: 5 }, [])!.critical, []);
  assert.deepEqual(sample(base, { ph: -1 })!.critical, []);
  const first = advanceIncident(emptyIncidentState(), sample(base, { ph: 5 })!)!;
  assert.equal(advanceIncident(first.state, sample(base, { ph: 5 })!), null);
  assert.deepEqual(advanceIncident(first.state, sample(base + 61_000, { ph: 5 })!)!.state.confirmed, []);
});

test('simultaneous critical parameters combine and new critical condition requires confirmation', () => {
  const first = advanceIncident(emptyIncidentState(), sample(base, { ph: 5, dissolvedOxygen: 2 })!)!;
  const second = advanceIncident(first.state, sample(base + 10_000, { ph: 5, dissolvedOxygen: 2 })!)!;
  assert.deepEqual(new Set(second.state.confirmed), new Set(['ph', 'dissolvedOxygen']));
  const third = advanceIncident(second.state, sample(base + 20_000, { ph: 5, dissolvedOxygen: 2, ammonia: 0.2 })!)!;
  assert.deepEqual(third.newlyConfirmed, []);
  const fourth = advanceIncident(third.state, sample(base + 30_000, { ph: 5, dissolvedOxygen: 2, ammonia: 0.2 })!)!;
  assert.deepEqual(fourth.newlyConfirmed, ['ammonia']);
});

test('recovery needs 30 continuous minutes of valid noncritical readings', () => {
  let state = advanceIncident(emptyIncidentState(), sample(base, { ph: 5 })!)!.state;
  state = advanceIncident(state, sample(base + 10_000, { ph: 5 })!)!.state;
  const recovering = advanceIncident(state, sample(base + 20_000, { ph: 7 })!)!;
  assert.equal(recovering.resolved, false);
  const interrupted = advanceIncident(recovering.state, sample(base + 81_000, { ph: 7 })!)!;
  assert.equal(interrupted.state.recoverySince, base + 81_000);
  let current = interrupted.state;
  for (let t = base + 111_000; t <= base + 81_000 + RECOVERY_MS; t += 30_000) {
    const next = advanceIncident(current, sample(t, { ph: 7 })!)!;
    current = next.state;
    if (t === base + 81_000 + RECOVERY_MS) assert.equal(next.resolved, true);
  }
});

test('routine and update attempts have separate rolling budgets and spacing', () => {
  const prior = (kind: string, at: number, status = 'accepted') => ({ kind, at, status });
  const initial = prior('initial', base);
  assert.equal(chooseNotification('reminder', [initial], base + ROUTINE_INTERVAL_MS - 1), false);
  assert.equal(chooseNotification('reminder', [initial], base + ROUTINE_INTERVAL_MS), true);
  assert.equal(chooseNotification('reminder', [initial, prior('reminder', base + ROUTINE_INTERVAL_MS), prior('reminder', base + 2 * ROUTINE_INTERVAL_MS)], base + 3 * ROUTINE_INTERVAL_MS), false);
  assert.equal(chooseNotification('reminder', [initial, prior('reminder', base + ROUTINE_INTERVAL_MS), prior('reminder', base + 2 * ROUTINE_INTERVAL_MS)], base + 24 * 60 * 60_000), true);
  const update = prior('update', base + 1000);
  assert.equal(chooseNotification('update', [update], base + 1000 + UPDATE_INTERVAL_MS - 1), false);
  assert.equal(chooseNotification('update', [update], base + 1000 + UPDATE_INTERVAL_MS), true);
  assert.equal(chooseNotification('update', [update, prior('update', base + 1000 + UPDATE_INTERVAL_MS)], base + 2 * UPDATE_INTERVAL_MS + 1000), false);
  assert.equal(chooseNotification('update', [update, prior('update', base + 1000 + UPDATE_INTERVAL_MS)], base + 24 * 60 * 60_000 + 1000), true);
});
