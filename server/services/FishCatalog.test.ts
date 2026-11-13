import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCatalog } from "./FishCatalog";

test("configured Mamali thresholds make it available for comparison", () => {
  const result = buildCatalog([{
    id: 9, name: "Mamali", optimal_ph_min: 6.5, optimal_ph_max: 8.5,
    optimal_temp_min: 22, optimal_temp_max: 30, optimal_do_min: 4,
    optimal_do_max: 8, optimal_turb_min: 20, optimal_turb_max: 120,
    max_ammonia: 0.05
  }]);
  assert.equal(result.profiles.find(fish => fish.id === "mamali")?.ranges.temperature[1], 30);
});

test("incomplete Mamali thresholds remain pending", () => {
  const result = buildCatalog([{ id: 9, name: "Mamali" }]);
  assert.equal(result.profiles.some(fish => fish.id === "mamali"), false);
});
