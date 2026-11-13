import type { FishSpecies } from "../types";

export type PartialReading = { ph: number | null; temperature: number | null; turbidity: number | null };

export function rankPartialFish(profiles: FishSpecies[], readings: PartialReading) {
  const keys = (["ph", "temperature", "turbidity"] as const).filter(key =>
    readings[key] !== null && Number.isFinite(readings[key])
  );
  return profiles.map(fish => {
    const matches = keys.filter(key => {
      const [min, max] = fish.ranges[key];
      return Number.isFinite(min) && Number.isFinite(max) && readings[key]! >= min && readings[key]! <= max;
    });
    const distance = keys.reduce((total, key) => {
      const [min, max] = fish.ranges[key];
      const value = readings[key]!;
      if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return total + 1;
      return total + Math.max(min - value, 0, value - max) / (max - min);
    }, 0);
    return { fish, matches, distance };
  }).sort((a, b) => b.matches.length - a.matches.length || a.distance - b.distance || a.fish.name.localeCompare(b.fish.name));
}
