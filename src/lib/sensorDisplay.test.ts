import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSensorSamples, sensorConnectionState, sensorTurbidityValue } from './sensorDisplay';

test('calibrated NTU is never capped by a presentation limit', () => {
  for (const value of [0, 133.25, 500, 750.5, 1000]) assert.equal(sensorTurbidityValue({ turbidityNtu: value, voltage: 2.5 }), value);
});

test('freshness uses sample and receipt times; no timestamp is not a live measurement', () => {
  const now = Date.parse('2026-11-22T08:00:00Z');
  const at = (age: number) => new Date(now - age).toISOString();
  const reading = { recordedAt: at(0), sampledAt: at(0), receivedAt: at(0) };
  assert.equal(sensorConnectionState(null, now), 'offline');
  assert.equal(sensorConnectionState(reading, now), 'live');
  assert.equal(sensorConnectionState({ ...reading, sampledAt: at(15_000) }, now), 'stale');
  assert.equal(sensorConnectionState({ ...reading, sampledAt: at(60_000) }, now), 'offline');
  assert.equal(sensorConnectionState({ ...reading, receivedAt: at(60_000) }, now), 'offline');
  assert.equal(sensorConnectionState({ ...reading, sampledAt: null }, now), 'offline');
  assert.equal(sensorConnectionState({ ...reading, sampledAt: 'invalid' }, now), 'offline');
});

test('live chart sorts by measurement time rather than upload ID', () => {
  const values = [{ id: 3, recordedAt: '2026-11-22T08:00:03Z' }, { id: 4, recordedAt: '2026-11-22T08:00:00Z' }, { id: 2, recordedAt: '2026-11-22T08:00:03Z' }];
  assert.deepEqual(values.sort(compareSensorSamples).map(item => item.id), [4, 2, 3]);
});
test('provisional NTU follows the transmitted GPIO34 voltage', () => {
  assert.equal(sensorTurbidityValue({ turbidityNtu: null, voltage: 1.757 }), 55.01);
  assert.equal(sensorTurbidityValue({ turbidityNtu: null, voltage: 3.3 }), null);
  assert.equal(sensorTurbidityValue({ turbidityNtu: null, voltage: null }), null);
});
