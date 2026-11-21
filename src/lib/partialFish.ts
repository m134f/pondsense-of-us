import type { FishSpecies } from "../types";
import type { WaterParams } from "../types";

export type PartialReading = Partial<Record<keyof WaterParams, number | null>>;
type PartialKey = keyof PartialReading;
export type PartialCheck = { key: PartialKey; value: number; min: number; max: number; result: 'within' | 'below' | 'above' | 'unknown' };

export function rankPartialFish(profiles: FishSpecies[], readings: PartialReading) {
  const keys = (["ph", "temperature", "dissolvedOxygen", "turbidity", "ammonia"] as const).filter(key =>
    readings[key] !== null && Number.isFinite(readings[key])
  );
  return profiles.map(fish => {
    const checks: PartialCheck[] = keys.map(key => {
      const [min, max] = fish.ranges[key];
      const value = readings[key]!;
      const result: PartialCheck['result'] = !Number.isFinite(min) || !Number.isFinite(max) || min >= max ? 'unknown' : value < min ? 'below' : value > max ? 'above' : 'within';
      return { key, value, min, max, result };
    });
    const matches = checks.filter(check => check.result === 'within').map(check => check.key);
    const distance = checks.reduce((total, check) => {
      if (check.result === 'unknown') return total + 1;
      return total + Math.max(check.min - check.value, 0, check.value - check.max) / (check.max - check.min);
    }, 0);
    return { fish, matches, distance, checks };
  }).sort((a, b) => b.matches.length - a.matches.length || a.distance - b.distance || a.fish.name.localeCompare(b.fish.name));
}
