export const turbidityVoltageRange = { min: 0, max: 3.3, step: 0.01 };
export const turbidityReferenceRange = { min: 2.1, max: 2.9 };

export type TurbidityValidity = 'missing' | 'invalid' | 'uncalibrated' | 'extrapolated';

export function estimateTurbidity(voltage: number | null | undefined): {
  voltage: number | null; ntu: number | null; validity: TurbidityValidity;
} {
  if (voltage == null) return { voltage: null, ntu: null, validity: 'missing' };
  if (!Number.isFinite(voltage) || voltage < turbidityVoltageRange.min || voltage > turbidityVoltageRange.max) {
    return { voltage: null, ntu: null, validity: 'invalid' };
  }
  // GPIO34 is wired directly. Use the millivolt precision stored by telemetry.
  const millivolts = Math.round(voltage * 1000);
  const usedVoltage = millivolts / 1000;
  // 131.875 - 43.75 * V, in units of 1/800 NTU for identical ESP32 and web rounding.
  const scaled = 105500 - 35 * millivolts;
  return {
    voltage: usedVoltage,
    ntu: scaled < 0 ? null : Math.floor((scaled + 4) / 8) / 100,
    validity: scaled < 0 ? 'invalid' : usedVoltage < turbidityReferenceRange.min || usedVoltage > turbidityReferenceRange.max ? 'extrapolated' : 'uncalibrated'
  };
}

export function turbidityValidityLabel(validity: TurbidityValidity, tl: boolean) {
  switch (validity) {
    case 'missing': return tl ? 'Walang boltahe' : 'No voltage';
    case 'invalid': return tl ? 'Hindi wastong resulta' : 'Invalid result';
    case 'extrapolated': return tl ? 'Labas sa reference range' : 'Extrapolated';
    case 'uncalibrated': return tl ? 'Hindi pa calibrated' : 'Uncalibrated';
  }
}
