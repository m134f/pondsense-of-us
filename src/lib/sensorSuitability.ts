import type { FishSpecies } from '../types';
import { parameterStatus } from './measurementStatus';
import { rankPartialFish } from './partialFish';
import { classifyTurbidity, type TurbidityAlertRule } from './turbidityAlert';
import { chartValue } from './waterGuidelines';

export const suitabilityParameters = ['ph', 'temperature', 'dissolvedOxygen', 'turbidity'] as const;
type Parameter = typeof suitabilityParameters[number];
type Snapshot = { ph: number | null; temperatureC: number | null; dissolvedOxygen?: number | null; turbidityNtu: number | null; turbidityEstimated?: boolean };

export function monitoringValues(sample?: Snapshot | null) {
  return {
    ph: chartValue('ph', sample?.ph),
    temperature: chartValue('temperature', sample?.temperatureC),
    dissolvedOxygen: chartValue('dissolvedOxygen', sample?.dissolvedOxygen),
    turbidity: chartValue('turbidity', sample?.turbidityNtu, sample?.turbidityEstimated)
  };
}

export function monitoringStatuses(values: ReturnType<typeof monitoringValues>, rule: TurbidityAlertRule | null) {
  const status = (key: Exclude<Parameter, 'turbidity'>) => values[key] === null ? null : parameterStatus(key, values[key]);
  return {
    ph: status('ph'), temperature: status('temperature'), dissolvedOxygen: status('dissolvedOxygen'),
    turbidity: classifyTurbidity(values.turbidity, 'verified', rule)
  };
}

export function analyzeSensorSuitability(profiles: FishSpecies[], values: ReturnType<typeof monitoringValues>, rule: TurbidityAlertRule | null) {
  const statuses = monitoringStatuses(values, rule);
  const critical = suitabilityParameters.filter(key => statuses[key] === 'critical');
  const missing = suitabilityParameters.filter(key => values[key] === null);
  const measured = suitabilityParameters.length - missing.length;
  const ranked = critical.length || !measured ? [] : rankPartialFish(profiles, values);
  const unscored = ranked.filter(row => row.checks.some(check => check.result === 'unknown'));
  const matches = ranked.filter(row => row.checks.every(check => check.result !== 'unknown')).map((row, _index, rows) => ({
    ...row,
    percentage: Math.round(100 * row.matches.length / measured),
    rank: rows.findIndex(other => other.matches.length === row.matches.length && Math.abs(other.distance - row.distance) < 0.000001) + 1
  }));
  return { critical, missing, measured, matches, unscored };
}
