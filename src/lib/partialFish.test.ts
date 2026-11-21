import assert from "node:assert/strict";
import { test } from "node:test";
import { fishDatabase } from "../data/fish";
import { rankPartialFish } from "./partialFish";

const profiles = fishDatabase.filter(fish => fish.id !== "mamali");

test("ranks only available measured parameters", () => {
  const ranked = rankPartialFish(profiles, { ph: null, temperature: 30, turbidity: null });
  assert.equal(ranked.length, 2);
  assert.ok(ranked.every(item => item.matches.length === 1));
});

test("does not count absent or out-of-range measurements as matches", () => {
  const ranked = rankPartialFish(profiles, { ph: null, temperature: 33.6, turbidity: null });
  assert.ok(ranked.every(item => item.matches.length === 0));
});

test("a measured pH can change the order without other sensors", () => {
  const ranked = rankPartialFish(profiles, { ph: 6.7, temperature: null, turbidity: null });
  assert.equal(ranked[0].fish.id, "tilapia");
  assert.equal(ranked[0].matches.length, 1);
});

test("reports the configured range and direction for each measured value", () => {
  const ranked = rankPartialFish(profiles, { ph: 6.2, temperature: 28, turbidity: null });
  const tilapia = ranked.find(item => item.fish.id === 'tilapia')!;
  assert.deepEqual(tilapia.checks.map(check => ({ key: check.key, result: check.result, min: check.min, max: check.max })), [
    { key: 'ph', result: 'below', min: 6.5, max: 8.5 },
    { key: 'temperature', result: 'within', min: 25, max: 32 }
  ]);
  assert.equal(tilapia.matches.length, 1);
  assert.equal(tilapia.distance, (6.5 - 6.2) / (8.5 - 6.5));
});

test("equal measured fit remains a tie broken by fish name", () => {
  const ranked = rankPartialFish(profiles, { ph: 7.5, temperature: 28, turbidity: null });
  assert.equal(ranked[0].matches.length, ranked[1].matches.length);
  assert.equal(ranked[0].distance, ranked[1].distance);
  assert.deepEqual(ranked.map(item => item.fish.name), ['Bangus (Milkfish)', 'Tilapia']);
});

test('manual dissolved oxygen and ammonia measurements affect the preliminary ranking', () => {
  const ranked = rankPartialFish(profiles, { dissolvedOxygen: 4, ammonia: 0.04 });
  assert.ok(ranked.every(item => item.checks.length === 2));
  assert.ok(ranked.every(item => item.checks.some(check => check.key === 'dissolvedOxygen')));
  assert.ok(ranked.every(item => item.checks.some(check => check.key === 'ammonia')));
});
