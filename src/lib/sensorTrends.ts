import { chartValue, classCGuidelines } from './waterGuidelines';

export const trendParameters = ['ph', 'dissolvedOxygen', 'temperature', 'turbidity'] as const;
export type TrendParameter = typeof trendParameters[number];
export const trendRanges = [1, 7, 30] as const;
export type TrendRange = typeof trendRanges[number];
export type TrendReading = {
  id: number;
  sampledAt?: string | null;
  ph: number | null;
  dissolvedOxygen?: number | null;
  temperatureC: number | null;
  turbidityNtu: number | null;
  rawValue?: number | null;
  turbidityEstimated?: boolean;
};

// Informational pond-aquaculture bands from Table 2, not operational or DENR limits.
export const turbidityResearchReference = {
  moderate: 25,
  severeAbove: 100,
  url: 'https://www.scielo.cl/pdf/lajar/v51n2/0718-560X-lajar-51-02-0160.pdf'
};

export function compareTurbidityResearch(value: number) {
  if (value < turbidityResearchReference.moderate) return 'favorable';
  return value <= turbidityResearchReference.severeAbove ? 'moderate' : 'severe';
}

const dayMs = 86_400_000;
// Do not draw a continuous trace across the existing device offline timeout.
const trendGapMs = 60_000;

export function filterTrendReadings(readings: TrendReading[], days: TrendRange, now: number) {
  const timed = new Map<number, TrendReading>();
  const untimedIds: number[] = [];
  for (const reading of readings) {
    const text = reading.sampledAt ?? '';
    const time = /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(text) ? Date.parse(text) : NaN;
    if (!Number.isFinite(time) || time > now) {
      untimedIds.push(reading.id);
    } else if (time >= now - days * dayMs) {
      const existing = timed.get(time);
      if (!existing || existing.id < reading.id) timed.set(time, reading);
    }
  }
  return { points: [...timed.entries()].sort(([a], [b]) => a - b), untimedIds };
}

export function makeTrendSeries(points: ReturnType<typeof filterTrendReadings>['points'], parameter: TrendParameter, untimedIds: number[] = []) {
  const segments: number[] = [];
  let previousValid: { time: number; id: number } | null = null;
  const rows = points.map(([time, reading]) => {
    const raw = parameter === 'temperature' ? reading.temperatureC : parameter === 'turbidity' ? reading.turbidityNtu : reading[parameter];
    // The sensor API supplies null NTU for raw-only uploads; never convert raw counts here.
    const estimated = parameter === 'turbidity' && (reading.turbidityEstimated === true ||
      (raw == null && typeof reading.rawValue === 'number' && Number.isFinite(reading.rawValue)));
    const value = chartValue(parameter, raw, estimated);
    if (value === null) {
      previousValid = null;
      return { time, value, segment: null, uncalibrated: estimated };
    }
    // An untimed upload cannot be plotted. Conservatively break the trace if it
    // arrived between these two records rather than assigning it a sample time.
    if (previousValid === null || time - previousValid.time >= trendGapMs || untimedIds.some(id =>
      previousValid !== null && id > Math.min(previousValid.id, reading.id) && id < Math.max(previousValid.id, reading.id))) segments.push(segments.length);
    previousValid = { time, id: reading.id };
    return { time, value, segment: segments.length - 1, uncalibrated: false };
  });
  const last = [...rows].reverse().find(row => row.value !== null);
  return { rows, segments, latest: last?.value != null ? { time: last.time, value: last.value } : null };
}

export function compareClassC(parameter: TrendParameter, value: number) {
  const limits = classCGuidelines[parameter];
  if (!limits) return 'unreferenced';
  if (limits.min !== undefined && value < limits.min) return 'below';
  if (limits.max !== undefined && value > limits.max) return 'above';
  return 'within';
}
