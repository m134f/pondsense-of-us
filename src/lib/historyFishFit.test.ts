import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fishDatabase } from '../data/fish';
import type { SessionRecord } from '../types';
import { historyFishFit } from './historyFishFit';

const row = (values: Partial<SessionRecord>): SessionRecord => ({
  id: '1', timestamp: '', bestFish: '', score: null, ph: null, temperature: null,
  dissolvedOxygen: null, turbidity: null, ammonia: null, ...values
});

test('partial history displays measured fit, not a fabricated percentage', () => {
  const result = historyFishFit(row({ ph: 6, temperature: 22 }), fishDatabase);
  assert.equal(result?.fish, 'Tilapia');
  assert.equal(result?.fit, '0/2');
  assert.equal(result?.hasMatch, false);
});

test('estimated turbidity does not count as a verified measurement', () => {
  const result = historyFishFit(row({ ph: 7, turbidity: 30, turbidityEstimated: true }), fishDatabase);
  assert.equal(result?.fit, '1/1');
});

test('no measured values produce no fish fit', () => {
  assert.equal(historyFishFit(row({}), fishDatabase), null);
});
