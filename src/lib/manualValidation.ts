import type { FishSpecies, WaterParams } from '../types';

export const manualParameters = ['ph', 'temperature', 'dissolvedOxygen', 'turbidity'] as const;

export function isManualDecimalDraft(value: string) {
  return /^\d*(?:[.,]\d*)?$/.test(value);
}

// Existing backend measurement limits, not recommended fish-safety ranges.
export const manualLimits: Record<keyof WaterParams, [number, number]> = {
  ph: [0, 14], temperature: [0, 60], dissolvedOxygen: [0, 30],
  turbidity: [0, 1000], ammonia: [0, 10]
};

export function validateManual(input: Record<string, unknown>) {
  const values: Partial<WaterParams> = {};
  const errors: Partial<Record<keyof WaterParams, string>> = {};
  for (const key of Object.keys(manualLimits) as (keyof WaterParams)[]) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const [min, max] = manualLimits[key];
    const text = typeof raw === 'string' ? raw.trim().replace(',', '.') : '';
    const value = typeof raw === 'number' ? raw : /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) ? Number(text) : NaN;
    if (!Number.isFinite(value) || value < min || value > max) errors[key] = `${min} - ${max}`;
    else values[key] = value;
  }
  return { values, errors, empty: Object.keys(values).length === 0 };
}

export function manualWarnings(values: Partial<WaterParams>, fish: FishSpecies[]) {
  return (Object.keys(values) as (keyof WaterParams)[]).filter(key => fish.some(profile => {
    const range = profile.ranges[key];
    return range && range.every(Number.isFinite) && (values[key]! < range[0] || values[key]! > range[1]);
  }));
}
