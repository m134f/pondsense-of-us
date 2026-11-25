export type TurbidityThresholds = { warningFrom: number; criticalAbove: number };
export type TurbidityAlertRule = TurbidityThresholds & { approval: 'pending' | 'approved' };
export type TurbidityAlertStatus = 'safe' | 'warning' | 'critical';
type MeasurementBasis = 'verified' | 'uncalibrated' | 'extrapolated' | 'missing' | 'invalid';

export const proposedTurbidityRule = { warningFrom: 25, criticalAbove: 100, approval: 'pending' } as const;

export function parseTurbidityThresholds(input: unknown): TurbidityThresholds | null {
  if (!input || typeof input !== 'object' || !('warningFrom' in input) || !('criticalAbove' in input)) return null;
  const { warningFrom, criticalAbove } = input;
  if (typeof warningFrom !== 'number' || typeof criticalAbove !== 'number' || !Number.isFinite(warningFrom) || !Number.isFinite(criticalAbove) ||
    warningFrom <= 0 || criticalAbove <= warningFrom || criticalAbove > 1000 ||
    warningFrom !== Number(warningFrom.toFixed(2)) || criticalAbove !== Number(criticalAbove.toFixed(2))) return null;
  return { warningFrom, criticalAbove };
}

export function classifyTurbidity(value: number | null, basis: MeasurementBasis, rule: TurbidityAlertRule | null, mode: 'operational' | 'preview' = 'operational'): TurbidityAlertStatus | null {
  if (value === null || !Number.isFinite(value) || value < 0 || value > 1000 || basis === 'missing' || basis === 'invalid' ||
    !rule || !parseTurbidityThresholds(rule) || (mode === 'operational' && (basis !== 'verified' || rule.approval !== 'approved'))) return null;
  return value < rule.warningFrom ? 'safe' : value <= rule.criticalAbove ? 'warning' : 'critical';
}

export const turbidityAlertCopy = {
  safe: { en: 'Continue regular monitoring.', tl: 'Ipagpatuloy ang regular na pagsubaybay.' },
  warning: { en: 'Observe fish behavior, water clarity, and dissolved oxygen.', tl: 'Obserbahan ang kilos ng isda, linaw ng tubig, at dissolved oxygen.' },
  critical: { en: 'Verify the measurement, inspect fish for distress, and investigate possible sediment, pollution, or algal bloom.', tl: 'Kumpirmahin ang sukat, tingnan kung nahihirapan ang isda, at suriin kung may putik, polusyon, o pagdami ng algae.' }
};

export function turbidityStatusLabel(status: TurbidityAlertStatus | null, tl: boolean) {
  if (status === null) return tl ? 'Hindi tinatasa' : 'Not assessed';
  return (tl ? { safe: 'Ligtas', warning: 'Babala', critical: 'Kritikal' } : { safe: 'Safe', warning: 'Warning', critical: 'Critical' })[status];
}
