export function sensorTurbidityValue(telemetry: { turbidityNtu: number | null; rawValue: number }): number {
  // Preserve calibrated device values. Display limits must not change measurements.
  if (telemetry.turbidityNtu !== null) return telemetry.turbidityNtu;
  return Math.round(Math.max(0, Math.min(250, (1 - telemetry.rawValue / 4095) * 250)));
}

type SensorTimes = { recordedAt: string; sampledAt?: string | null; receivedAt?: string };

export function sensorConnectionState(telemetry: SensorTimes | null, now: number) {
  if (!telemetry) return 'offline';
  const sampledAt = Date.parse(telemetry.sampledAt === undefined ? telemetry.recordedAt : telemetry.sampledAt ?? '');
  const receivedAt = Date.parse(telemetry.receivedAt ?? telemetry.recordedAt);
  if (!Number.isFinite(sampledAt) || !Number.isFinite(receivedAt)) return 'offline';
  const age = Math.max(0, now - Math.min(sampledAt, receivedAt));
  return age < 15_000 ? 'live' : age < 60_000 ? 'stale' : 'offline';
}

export function compareSensorSamples(a: SensorTimes & { id: number }, b: SensorTimes & { id: number }) {
  const time = (reading: SensorTimes) => Date.parse(reading.recordedAt) || 0;
  return time(a) - time(b) || a.id - b.id;
}
