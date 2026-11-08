import type { WaterParams } from '../types';

export const parameters = ['ph', 'temperature', 'dissolvedOxygen', 'turbidity', 'ammonia'] as const;
export type Parameter = typeof parameters[number];
export type Measurement = { value: number | null; source: 'sensor' | 'manual'; recordedAt: string | null; unavailable?: boolean; estimated?: boolean };
export type Measurements = Partial<Record<Parameter, Measurement>>;
export type Thresholds = Record<Parameter, [number, number]>;
export type Recommendation = {
  parameter: Parameter; value: number | null; source: 'sensor' | 'manual' | null; recordedAt: string | null;
  state: 'safe' | 'warning' | 'critical' | 'missing' | 'unavailable' | 'stale' | 'unverified';
  priority: 'NORMAL' | 'WATCH' | 'ACTION NEEDED' | 'URGENT'; range: [number, number];
  rule: string;
};
// Existing application reference ranges, not a biological growth prediction.
export const referenceThresholds: Thresholds = { ph: [6.5, 8.5], temperature: [25, 32], dissolvedOxygen: [5, 8], turbidity: [25, 100], ammonia: [0, 0.05] };
export const measurementMaxAge = { sensor: 30_000, manual: 24 * 60 * 60 * 1000 };
export function recommend(measurements: Measurements, ranges: Thresholds, now = Date.now()): Recommendation[] {
  const items = parameters.map((parameter): Recommendation => {
    const m = measurements[parameter];
    const value = m?.value ?? null;
    const result: Recommendation = { parameter, value, source: m?.source ?? null, recordedAt: m?.recordedAt ?? null,
      state: 'missing', priority: 'WATCH', range: ranges[parameter], rule: 'missing-v1' };
    if (m?.unavailable) return { ...result, state: 'unavailable', rule: 'sensor-unavailable-v1' };
    if (value === null || !Number.isFinite(value)) return result;
    const age = now - Date.parse(m?.recordedAt || '');
    if (!Number.isFinite(age) || age < -5000 || age > measurementMaxAge[m!.source]) return { ...result, state: 'stale', rule: 'freshness-v1' };
    if (m?.estimated) return { ...result, state: 'unverified', rule: 'calibration-required-v1' };
    const [min, max] = ranges[parameter];
    const critical = (parameter === 'ph' && (value < 6 || value > 9)) ||
      (parameter === 'dissolvedOxygen' && value < 3) || (parameter === 'ammonia' && value > 0.1);
    if (critical) return { ...result, state: 'critical', priority: 'URGENT', rule: `${parameter}-critical-v1` };
    if (value < min || value > max) return { ...result, state: 'warning', priority: 'ACTION NEEDED', rule: 'outside-configured-range-v1' };
    return { ...result, state: 'safe', priority: 'NORMAL', rule: 'within-configured-range-v1' };
  });
  const oxygen = items.find(i => i.parameter === 'dissolvedOxygen')!;
  const ammonia = items.find(i => i.parameter === 'ammonia')!;
  if ([oxygen, ammonia].every(i => ['safe', 'warning', 'critical'].includes(i.state)) && oxygen.value! < 5 && ammonia.value! > 0.05) {
    for (const item of [oxygen, ammonia]) { item.state = 'critical'; item.priority = 'URGENT'; item.rule = 'combined-low-do-high-ammonia-v1'; }
  }
  return items.sort((a, b) => ['URGENT', 'ACTION NEEDED', 'WATCH', 'NORMAL'].indexOf(a.priority) - ['URGENT', 'ACTION NEEDED', 'WATCH', 'NORMAL'].indexOf(b.priority));
}
export function waterSummary(items: Recommendation[]) {
  if (items.some(i => i.state === 'critical')) return 'critical';
  if (items.some(i => i.state === 'warning')) return 'warning';
  return items.length === 5 && items.every(i => i.state === 'safe') ? 'safe' : 'incomplete';
}
export function completeMeasuredValues(items: Recommendation[]): WaterParams | null {
  if (items.length !== 5 || parameters.some(p => !items.some(i => i.parameter === p)) || items.some(i => i.value === null || !Number.isFinite(i.value) || !['safe', 'warning', 'critical'].includes(i.state))) return null;
  return Object.fromEntries(items.map(i => [i.parameter, i.value])) as WaterParams;
}
export const parameterLabels = { ph: 'pH', temperature: 'Temperature / Temperatura', dissolvedOxygen: 'Dissolved oxygen (DO)', turbidity: 'Turbidity / Labo ng tubig', ammonia: 'Ammonia (NH3)' };
export const units = { ph: '', temperature: 'C', dissolvedOxygen: 'mg/L', turbidity: 'NTU', ammonia: 'mg/L' };
export function recommendationCopy(item: Recommendation, tl: boolean) {
  const states = {
    safe: ['Safe', 'Ligtas'], warning: ['Warning', 'Babala'], critical: ['Critical', 'Kritikal'],
    missing: ['No Measurement', 'Walang sukat'], unavailable: ['Sensor Unavailable', 'Hindi magamit ang sensor'],
    stale: ['Stale', 'Lumang sukat'], unverified: ['Unverified estimate', 'Hindi pa beripikadong tantiya']
  };
  const why = item.rule === 'combined-low-do-high-ammonia-v1' ? ['Low dissolved oxygen and elevated ammonia were recorded together. Inspect fish promptly and verify both readings.', 'Sabay na naitala ang mababang oxygen at mataas na ammonia. Suriin agad ang isda at beripikahin ang dalawang sukat.'] : item.state === 'safe' ? ['Within the configured range for this reference.', 'Pasok sa itinakdang saklaw ng sangguniang ito.'] :
    ['warning', 'critical'].includes(item.state) ? ['Outside the configured range or an application critical limit.', 'Labas sa itinakdang saklaw o kritikal na limitasyon ng sistema.'] :
    ['A recent, verified measurement is needed before assessing this parameter.', 'Kailangan ng bago at beripikadong sukat bago suriin ang parameter na ito.'];
  const actions: Record<Parameter, [string, string]> = {
    ph: ['Recheck with a calibrated meter or test kit. Observe fish and consult BFAR/LGU before any treatment.', 'Sukatin muli gamit ang calibrated meter o test kit. Obserbahan ang isda at kumonsulta sa BFAR/LGU bago maggamot.'],
    temperature: ['Inspect fish behavior and circulation around the nets. Avoid handling stressed fish; review feeding.', 'Suriin ang kilos ng isda at daloy sa paligid ng lambat. Iwasang hawakan ang stressed na isda; suriin ang pagpapakain.'],
    dissolvedOxygen: ['Check for surface gathering. Review feeding and inspect nets and water circulation; seek fisheries assistance if distress continues.', 'Tingnan kung nagtitipon sa ibabaw ang isda. Suriin ang pagpapakain, lambat at daloy ng tubig; humingi ng tulong kung patuloy ang distress.'],
    turbidity: ['Inspect water color, odor, nets, and surrounding lake conditions. Avoid disturbing the lake bottom. Recheck the sample.', 'Suriin ang kulay, amoy, lambat at kondisyon ng lawa. Iwasang galawin ang ilalim ng lawa. Sukatin muli ang sample.'],
    ammonia: ['Inspect organic waste and fish behavior. Review feeding and confirm with a water test kit; consult BFAR/LGU before treatment.', 'Suriin ang organikong basura at kilos ng isda. Suriin ang pagpapakain at kumpirmahin gamit ang water test kit; kumonsulta bago maggamot.']
  };
  const action = item.state === 'safe' ? ['Continue routine observation and record the next measurement.', 'Ipagpatuloy ang pagmamasid at itala ang susunod na sukat.'] :
    ['warning', 'critical'].includes(item.state) ? actions[item.parameter] :
    ['Check the instrument and obtain a fresh measurement. Do not substitute zero for missing data.', 'Suriin ang instrumento at kumuha ng bagong sukat. Huwag gawing zero ang nawawalang datos.'];
  return { label: states[item.state][tl ? 1 : 0], why: why[tl ? 1 : 0], action: action[tl ? 1 : 0],
    followup: tl ? 'Sukatin muli matapos ang inspeksyon; kung may patuloy na distress, kumonsulta sa lokal na fisheries officer.' : 'Retest after inspection; if fish distress persists, consult the local fisheries officer.' };
}
