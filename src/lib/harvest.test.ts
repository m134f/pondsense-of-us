import assert from "node:assert/strict";
import test from "node:test";
import { daysUntilHarvest, estimatedRemainingStock, harvestReminderDue } from "./harvest";

test("partial harvests and mortality reduce estimated remaining stock", () => {
  assert.equal(estimatedRemainingStock(100, [{ deadCount: 3 }, { deadCount: 2 }], [{ fishCount: 10 }, { fishCount: 5 }]), 80);
});

test("unknown harvested fish count is not invented", () => {
  assert.equal(estimatedRemainingStock(100, [], [{ fishCount: null }]), 100);
});

test("reminders appear at seven, one, and zero days, with overdue distinct", () => {
  assert.equal(daysUntilHarvest("2026-11-05", "2026-11-06"), -1);
  assert.equal(harvestReminderDue("2026-11-12", "2026-11-05"), true);
  assert.equal(harvestReminderDue("2026-11-06", "2026-11-05"), true);
  assert.equal(harvestReminderDue("2026-11-05", "2026-11-05"), true);
  assert.equal(harvestReminderDue("2026-11-07", "2026-11-05"), false);
});
