import { recommend, referenceThresholds, type Measurements, type Parameter } from '../../src/lib/recommendations';

export const SNAPSHOT_MAX_AGE_MS = 30_000;
export const SNAPSHOT_MAX_GAP_MS = 60_000;
export const RECOVERY_MS = 30 * 60_000;
export const ROUTINE_INTERVAL_MS = 6 * 60 * 60_000;
export const UPDATE_INTERVAL_MS = 30 * 60_000;
export const ROLLING_DAY_MS = 24 * 60 * 60_000;

export type IncidentState = {
  lastAt: number | null;
  counts: Partial<Record<Parameter, number>>;
  confirmed: Parameter[];
  everCritical: Parameter[];
  recoverySince: number | null;
};
export const emptyIncidentState = (): IncidentState => ({ lastAt: null, counts: {}, confirmed: [], everCritical: [], recoverySince: null });

export function sensorSnapshot(measurements: Measurements, now = Date.now()) {
  const times = Object.values(measurements).filter(m => m?.value !== null && m?.value !== undefined).map(m => Date.parse(m?.recordedAt || ''));
  if (!times.length || times.some(time => !Number.isFinite(time) || time > now + 5000 || now - time > SNAPSHOT_MAX_AGE_MS) || new Set(times).size !== 1) return null;
  const at = times[0];
  const states = recommend(measurements, referenceThresholds, now);
  const valid = states.filter(item => ['safe', 'warning', 'critical'].includes(item.state) && item.source === 'sensor').map(item => item.parameter);
  const critical = states.filter(item => item.state === 'critical' && item.source === 'sensor').map(item => item.parameter);
  const values = Object.fromEntries(states.filter(item => valid.includes(item.parameter)).map(item => [item.parameter, item.value])) as Partial<Record<Parameter, number>>;
  return { at, valid, critical, values };
}

export function advanceIncident(previous: IncidentState, snapshot: NonNullable<ReturnType<typeof sensorSnapshot>>) {
  if (previous.lastAt !== null && snapshot.at <= previous.lastAt) return null;
  const continuous = previous.lastAt !== null && snapshot.at - previous.lastAt <= SNAPSHOT_MAX_GAP_MS;
  const counts: IncidentState['counts'] = {};
  for (const parameter of snapshot.critical) counts[parameter] = continuous ? Math.min(2, (previous.counts[parameter] || 0) + 1) : 1;
  const confirmed = snapshot.critical.filter(parameter => counts[parameter] === 2);
  const everCritical = [...new Set([...previous.everCritical, ...confirmed])];
  const allRecovered = everCritical.length > 0 && snapshot.critical.length === 0 && everCritical.every(parameter => snapshot.valid.includes(parameter));
  const recoverySince = allRecovered ? (continuous ? previous.recoverySince ?? snapshot.at : snapshot.at) : null;
  return {
    state: { lastAt: snapshot.at, counts, confirmed, everCritical, recoverySince } satisfies IncidentState,
    newlyConfirmed: confirmed.filter(parameter => !previous.everCritical.includes(parameter)),
    resolved: recoverySince !== null && snapshot.at - recoverySince >= RECOVERY_MS
  };
}

export function chooseNotification(kind: 'initial' | 'update' | 'reminder', previous: Array<{ kind: string; at: number; status: string }>, now: number) {
  const active = previous.filter(item => item.status !== 'cancelled');
  const daily = active.filter(item => now - item.at < ROLLING_DAY_MS);
  if (kind === 'initial') return !active.some(item => item.kind === 'initial');
  if (kind === 'update') {
    const updates = daily.filter(item => item.kind === 'update');
    return updates.length < 2 && (!updates.length || now - Math.max(...updates.map(item => item.at)) >= UPDATE_INTERVAL_MS);
  }
  const routine = daily.filter(item => item.kind === 'initial' || item.kind === 'reminder');
  const lastRoutine = active.filter(item => item.kind === 'initial' || item.kind === 'reminder').at(-1);
  return routine.length < 3 && Boolean(lastRoutine && now - lastRoutine.at >= ROUTINE_INTERVAL_MS);
}
