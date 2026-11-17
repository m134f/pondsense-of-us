export function sensorTurbidityValue(telemetry: { turbidityNtu: number | null; rawValue: number }): number {
  // Preserve calibrated device values. Display limits must not change measurements.
  if (telemetry.turbidityNtu !== null) return telemetry.turbidityNtu;
  return Math.round(Math.max(0, Math.min(250, (1 - telemetry.rawValue / 4095) * 250)));
}
