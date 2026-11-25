import type { AlertLevel, WaterParams } from '../types';
import { classifyTurbidity, proposedTurbidityRule } from './turbidityAlert';

// Existing dashboard rules, shared by manual results and session history.
export function parameterStatus(key: keyof WaterParams, value: number): AlertLevel | null {
  if (key === 'ph') return value < 6 || value > 9 ? 'critical' : value < 6.5 || value > 8.5 ? 'warning' : 'safe';
  if (key === 'temperature') return value < 25 || value > 32 ? 'warning' : 'safe';
  if (key === 'dissolvedOxygen') return value < 3 ? 'critical' : value < 5 ? 'warning' : 'safe';
  if (key === 'turbidity') return classifyTurbidity(value, 'verified', proposedTurbidityRule);
  return value > 0.1 ? 'critical' : value > 0.05 ? 'warning' : 'safe';
}

export function measuredStatus(values: Partial<{ [K in keyof WaterParams]: number | null }>): AlertLevel | 'partial' {
  const keys: (keyof WaterParams)[] = ['ph', 'temperature', 'dissolvedOxygen', 'turbidity', 'ammonia'];
  const statuses = keys.filter(key => typeof values[key] === 'number' && Number.isFinite(values[key]))
    .map(key => parameterStatus(key, values[key]!)).filter(status => status !== null);
  if (!statuses.length) return 'partial';
  return statuses.includes('critical') ? 'critical' : statuses.includes('warning') ? 'warning' : 'safe';
}
