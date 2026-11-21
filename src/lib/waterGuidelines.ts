import type { WaterParams } from '../types';

export const classCSource = 'DENR-EMB DAO 2016-08, Table 3, freshwater Class C';
export const classCUrl = 'https://pab.emb.gov.ph/wp-content/uploads/2017/07/DAO-2016-08-WQG-and-GES.pdf';
export const classCGuidelines: Partial<Record<keyof WaterParams, { min?: number; max?: number; unit: string }>> = {
  ph: { min: 6.5, max: 9, unit: 'pH' },
  temperature: { min: 25, max: 31, unit: '°C' },
  dissolvedOxygen: { min: 5, unit: 'mg/L' }
};

export function chartValue(key: keyof WaterParams, value: number | null | undefined, estimated = false) {
  const limits: Partial<Record<keyof WaterParams, [number, number]>> = {
    ph: [0, 14], temperature: [-10, 60], dissolvedOxygen: [0, 30], turbidity: [0, 1000]
  };
  const range = limits[key];
  return !estimated && typeof value === 'number' && Number.isFinite(value) && range && value >= range[0] && value <= range[1] ? value : null;
}
