import type { WaterParams } from '../types';
import { classifyTurbidity, proposedTurbidityRule, turbidityAlertCopy } from './turbidityAlert';

export const parameters = ['ph', 'temperature', 'dissolvedOxygen', 'turbidity', 'ammonia'] as const;
export type Parameter = typeof parameters[number];
export type Measurement = { value: number | null; source: 'sensor' | 'manual'; recordedAt: string | null; unavailable?: boolean; estimated?: boolean };
export type Measurements = Partial<Record<Parameter, Measurement>>;
export type Thresholds = Record<Parameter, [number, number]>;
export type Recommendation = {
  parameter: Parameter; value: number | null; source: 'sensor' | 'manual' | null; recordedAt: string | null;
  state: 'safe' | 'warning' | 'critical' | 'missing' | 'unavailable' | 'stale' | 'unverified' | 'not-assessed';
  priority: 'NORMAL' | 'WATCH' | 'ACTION NEEDED' | 'URGENT'; range: [number, number];
  rule: string;
};
// Existing application reference ranges, not a biological growth prediction.
export const referenceThresholds: Thresholds = { ph: [6.5, 8.5], temperature: [25, 32], dissolvedOxygen: [5, 8], turbidity: [25, 100], ammonia: [0, 0.05] };
export const measurementMaxAge = { sensor: 30_000, manual: 24 * 60 * 60 * 1000 };
const physicalLimits: Record<Parameter, [number, number]> = {
  ph: [0, 14], temperature: [-10, 60], dissolvedOxygen: [0, 30], turbidity: [0, 1000], ammonia: [0, 10]
};
export function recommend(measurements: Measurements, ranges: Thresholds, now = Date.now()): Recommendation[] {
  const items = parameters.map((parameter): Recommendation => {
    const m = measurements[parameter];
    const value = m?.value ?? null;
    const result: Recommendation = { parameter, value, source: m?.source ?? null, recordedAt: m?.recordedAt ?? null,
      state: 'missing', priority: 'WATCH', range: ranges[parameter], rule: 'missing-v1' };
    if (m?.unavailable) return { ...result, state: 'unavailable', rule: 'sensor-unavailable-v1' };
    if (value === null || !Number.isFinite(value)) return result;
    const [physicalMin, physicalMax] = physicalLimits[parameter];
    if (value < physicalMin || value > physicalMax) return { ...result, state: 'unverified', rule: 'invalid-physical-value-v1' };
    const age = now - Date.parse(m?.recordedAt || '');
    if (!Number.isFinite(age) || age < -5000 || age > measurementMaxAge[m!.source]) return { ...result, state: 'stale', rule: 'freshness-v1' };
    if (m?.estimated) return { ...result, state: 'unverified', rule: 'calibration-required-v1' };
    if (parameter === 'turbidity') {
      const state = classifyTurbidity(value, 'verified', proposedTurbidityRule);
      return state === null ? { ...result, range: [0, 1000], state: 'not-assessed', rule: 'turbidity-approval-pending-v1' } :
        { ...result, range: [0, proposedTurbidityRule.criticalAbove], state, priority: state === 'safe' ? 'NORMAL' : state === 'warning' ? 'ACTION NEEDED' : 'URGENT', rule: 'turbidity-operating-rule-v1' };
    }
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
  if (items.length !== 5 || parameters.some(p => !items.some(i => i.parameter === p)) || items.some(i => i.value === null || !Number.isFinite(i.value) || !['safe', 'warning', 'critical', 'not-assessed'].includes(i.state))) return null;
  return Object.fromEntries(items.map(i => [i.parameter, i.value])) as WaterParams;
}
export const parameterLabels = { ph: 'pH', temperature: 'Temperature / Temperatura', dissolvedOxygen: 'Dissolved oxygen (DO)', turbidity: 'Turbidity / Labo ng tubig', ammonia: 'Ammonia (NH3)' };
export const units = { ph: '', temperature: 'C', dissolvedOxygen: 'mg/L', turbidity: 'NTU', ammonia: 'mg/L' };
export const lldaAdvisoryUrl = 'https://llda.gov.ph/presence-of-algal-bloom-in-selected-areas-of-laguna-de-bay/';
export function lowOxygenGuidance(item: Recommendation, tl: boolean) {
  if (item.parameter !== 'dissolvedOxygen' || item.value === null || item.value >= 5 || !['warning', 'critical'].includes(item.state)) return null;
  return tl ? {
    immediate: 'Sukatin muli ang DO at tingnan mismo ang kilos ng isda, lalo na sa madaling araw. Hindi pa nasusukat ng sistema ang pagkabalisa ng isda.',
    monitoring: 'Bantayan kung lumalangoy malapit sa ibabaw o sumisinghap ang isda. I-monitor muli ang DO at itala ang aktuwal na obserbasyon.',
    emergency: 'Kung nakita ang hirap sa paghinga, manu-manong maglagay ng angkop na aerator o paddle wheel kung mayroon at ligtas. Kung matindi at tuloy-tuloy ang distress at maaari nang ibenta ang isda, pag-isipan ang maagang pag-ani. Iulat sa LLDA ang hindi pangkaraniwang algal bloom, maramihang pagkamatay, kakaibang kulay ng tubig, o mabahong amoy.'
  } : {
    immediate: 'Recheck DO and inspect fish behavior directly, especially in the early morning. Fish distress has not been observed by this system.',
    monitoring: 'Watch for fish swimming near the surface or gasping. Recheck DO and record what you actually observe.',
    emergency: 'If oxygen-related distress is observed, manually deploy a suitable aerator or paddle wheel if available and safe. Only if severe distress persists and fish are already marketable, consider early harvest. Report unusual algal blooms, mass mortality, abnormal water color, or foul odors to LLDA.'
  };
}
export function recommendationCopy(item: Recommendation, tl: boolean) {
  const states = {
    safe: ['Safe', 'Ligtas'], warning: ['Warning', 'Babala'], critical: ['Critical', 'Kritikal'],
    missing: ['No Measurement', 'Walang sukat'], unavailable: ['Sensor Unavailable', 'Hindi magamit ang sensor'],
    stale: ['Stale', 'Lumang sukat'], unverified: ['Unverified estimate', 'Hindi pa beripikadong tantiya'],
    'not-assessed': ['Not assessed', 'Hindi tinatasa']
  };
  const why = item.rule === 'combined-low-do-high-ammonia-v1' ? ['Low dissolved oxygen and elevated ammonia were recorded together. Inspect fish promptly and verify both readings.', 'Sabay na naitala ang mababang oxygen at mataas na ammonia. Suriin agad ang isda at beripikahin ang dalawang sukat.'] : item.state === 'safe' ? ['Within the configured range for this reference.', 'Pasok sa itinakdang saklaw ng sangguniang ito.'] :
    ['warning', 'critical'].includes(item.state) ? ['Outside the configured range or an application critical limit.', 'Labas sa itinakdang saklaw o kritikal na limitasyon ng sistema.'] :
    item.state === 'not-assessed' ? ['The turbidity operating thresholds are pending administrator and expert approval.', 'Hinihintay ang pag-apruba ng admin at eksperto sa mga limitasyon ng labo.'] :
    ['A recent, verified measurement is needed before assessing this parameter.', 'Kailangan ng bago at beripikadong sukat bago suriin ang parameter na ito.'];
  const actions: Record<Parameter, [string, string]> = {
    ph: ['Recheck with a calibrated meter or test kit. Observe fish and consult BFAR/LGU before any treatment.', 'Sukatin muli gamit ang calibrated meter o test kit. Obserbahan ang isda at kumonsulta sa BFAR/LGU bago maggamot.'],
    temperature: ['Inspect fish behavior and circulation around the nets. Avoid handling stressed fish; review feeding.', 'Suriin ang kilos ng isda at daloy sa paligid ng lambat. Iwasang hawakan ang stressed na isda; suriin ang pagpapakain.'],
    dissolvedOxygen: ['Check for surface gathering. Review feeding and inspect nets and water circulation; seek fisheries assistance if distress continues.', 'Tingnan kung nagtitipon sa ibabaw ang isda. Suriin ang pagpapakain, lambat at daloy ng tubig; humingi ng tulong kung patuloy ang distress.'],
    turbidity: ['Inspect water color, odor, nets, and surrounding lake conditions. Avoid disturbing the lake bottom. Recheck the sample.', 'Suriin ang kulay, amoy, lambat at kondisyon ng lawa. Iwasang galawin ang ilalim ng lawa. Sukatin muli ang sample.'],
    ammonia: ['Inspect organic waste and fish behavior. Review feeding and confirm with a water test kit; consult BFAR/LGU before treatment.', 'Suriin ang organikong basura at kilos ng isda. Suriin ang pagpapakain at kumpirmahin gamit ang water test kit; kumonsulta bago maggamot.']
  };
  const turbidityAction = item.parameter === 'turbidity' && (item.state === 'safe' || item.state === 'warning' || item.state === 'critical') ? turbidityAlertCopy[item.state] : null;
  const action = turbidityAction ? [turbidityAction.en, turbidityAction.tl] : item.state === 'safe' ? ['Continue routine observation and record the next measurement.', 'Ipagpatuloy ang pagmamasid at itala ang susunod na sukat.'] :
    ['warning', 'critical'].includes(item.state) ? actions[item.parameter] :
    item.state === 'not-assessed' ? ['Keep recording observations while the proposal is reviewed.', 'Ipagpatuloy ang pagtatala habang sinusuri ang mungkahi.'] :
    ['Check the instrument and obtain a fresh measurement. Do not substitute zero for missing data.', 'Suriin ang instrumento at kumuha ng bagong sukat. Huwag gawing zero ang nawawalang datos.'];
  return { label: states[item.state][tl ? 1 : 0], why: why[tl ? 1 : 0], action: action[tl ? 1 : 0],
    followup: tl ? 'Sukatin muli matapos ang inspeksyon; kung may patuloy na distress, kumonsulta sa lokal na fisheries officer.' : 'Retest after inspection; if fish distress persists, consult the local fisheries officer.' };
}
