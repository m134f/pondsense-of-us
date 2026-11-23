import assert from 'node:assert/strict';
import test from 'node:test';
import { monitoringAssessment, partitionMonitoringRecommendations } from './monitoringRecommendations';
import type { Recommendation } from './recommendations';

const sample = '2026-11-22T08:00:00Z';
const sensor: Recommendation = { parameter: 'ph', value: 7, source: 'sensor', recordedAt: sample, state: 'safe', priority: 'NORMAL', range: [6.5, 8.5], rule: 'fixture' };
const now = Date.parse(sample) + 5_000;
const snapshot = { sampledAt: sample, recordedAt: sample, receivedAt: sample, ph: 5, temperatureC: 35, turbidityNtu: 210 };

test('manual results and previous sensor records remain separate from the displayed snapshot; ammonia is history only', () => {
  const manual = { ...sensor, source: 'manual' as const, parameter: 'temperature' as const };
  const previous = { ...sensor, recordedAt: '2026-11-22T07:59:59Z' };
  const historicalAmmonia = { ...manual, parameter: 'ammonia' as const };
  assert.deepEqual(partitionMonitoringRecommendations([manual, previous, sensor, historicalAmmonia], sample), { manual: [manual], other: [previous] });
});

test('all simultaneous warnings and critical readings are assessed, with critical first', () => {
  assert.deepEqual(monitoringAssessment(snapshot, now).map(({ parameter, state }) => [parameter, state]), [
    ['ph', 'critical'], ['temperature', 'warning'], ['turbidity', 'warning'], ['dissolvedOxygen', 'missing']
  ]);
});

test('absent, stale, offline, delayed uploads, and unknown timestamps never become live', () => {
  assert.deepEqual(monitoringAssessment(null, now), []);
  assert.deepEqual(monitoringAssessment(snapshot, Date.parse(sample) + 15_000), []);
  assert.deepEqual(monitoringAssessment(snapshot, Date.parse(sample) + 60_000), []);
  assert.deepEqual(monitoringAssessment({ ...snapshot, receivedAt: new Date(now + 16_000).toISOString() }, now + 16_000), []);
  assert.deepEqual(monitoringAssessment({ ...snapshot, sampledAt: null }, now), []);
  assert.deepEqual(monitoringAssessment({ ...snapshot, sampledAt: 'invalid' }, now), []);
});

test('missing, uncalibrated and invalid values cannot trigger guidance; normal remains partial', () => {
  const readings = { ...snapshot, ph: 15, temperatureC: 27, turbidityNtu: null, rawValue: 2500 };
  assert.deepEqual(monitoringAssessment(readings, now).map(({ parameter, state }) => [parameter, state]), [
    ['ph', 'unverified'], ['dissolvedOxygen', 'missing'], ['turbidity', 'missing'], ['temperature', 'safe']
  ]);
  const future = new Date(now + 6_000).toISOString();
  assert.ok(monitoringAssessment({ ...snapshot, sampledAt: future }, now).every(item => item.state === 'stale' || item.state === 'missing'));
});
