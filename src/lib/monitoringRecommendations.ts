import { recommend, referenceThresholds, type Recommendation } from './recommendations';
import { sensorConnectionState } from './sensorDisplay';

export const monitoringParameters = ['ph', 'temperature', 'dissolvedOxygen', 'turbidity'] as const;
export type MonitoringParameter = typeof monitoringParameters[number];
export type MonitoringSnapshot = NonNullable<Parameters<typeof sensorConnectionState>[0]> & {
  ph: number | null;
  temperatureC: number | null;
  turbidityNtu: number | null;
  dissolvedOxygen?: number | null;
};

// The assigned-device endpoint supplies only confirmed water-contact snapshots.
export function monitoringAssessment(snapshot: MonitoringSnapshot | null, now: number) {
  if (!snapshot?.sampledAt || sensorConnectionState(snapshot, now) !== 'live') return [];
  const recordedAt = snapshot.sampledAt;
  const measurement = (value: number | null) => ({ value, source: 'sensor' as const, recordedAt });
  return recommend({
    ph: measurement(snapshot.ph),
    temperature: measurement(snapshot.temperatureC),
    dissolvedOxygen: measurement(snapshot.dissolvedOxygen ?? null),
    turbidity: measurement(snapshot.turbidityNtu)
  }, referenceThresholds, now).filter((item): item is Recommendation & { parameter: MonitoringParameter } => item.parameter !== 'ammonia');
}

export function partitionMonitoringRecommendations(items: Recommendation[], liveSampleTime: string | null) {
  const sampleTime = liveSampleTime === null ? NaN : Date.parse(liveSampleTime);
  const manual: Recommendation[] = [];
  const other: Recommendation[] = [];
  for (const item of items) {
    if (item.parameter === 'ammonia') continue;
    if (item.source === 'manual') manual.push(item);
    else if (liveSampleTime === null ||
      (item.source === 'sensor' && Date.parse(item.recordedAt ?? '') !== sampleTime)) other.push(item);
  }
  return { manual, other };
}
