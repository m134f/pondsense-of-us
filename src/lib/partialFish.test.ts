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
