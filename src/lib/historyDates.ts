export type HistoryPeriod = 'all' | 'today' | 'week' | 'month' | 'custom';
export type HistoryRange = { from: string; to: string };

const timeZone = 'Asia/Manila';
const dayFormat = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
const timestampFormat = new Intl.DateTimeFormat('en-PH', {
  timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: '2-digit', second: '2-digit'
});

export function manilaDay(date: Date) {
  const parts = dayFormat.formatToParts(date);
  const part = (type: string) => parts.find(value => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function historyTimestamp(date: Date) {
  return Number.isFinite(date.getTime()) ? timestampFormat.format(date) : '';
}

export function isHistoryDay(day: unknown): day is string {
  if (typeof day !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

export function shiftHistoryDay(day: string, days: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function resolveHistoryRange(period: HistoryPeriod, today: string, custom: HistoryRange): HistoryRange | null {
  if (period === 'all') return null;
  if (period === 'custom') return isHistoryDay(custom.from) && isHistoryDay(custom.to) && custom.from <= custom.to ? custom : null;
  const daysBack = period === 'week' ? 6 : period === 'month' ? 29 : 0;
  return { from: shiftHistoryDay(today, -daysBack), to: today };
}

export function historyRecordDay({ recordedAt, timestamp }: { recordedAt?: string; timestamp: string }) {
  const canonical = recordedAt ?? timestamp;
  if (isHistoryDay(canonical)) return canonical;
  if (/^\d{4}-\d{2}-\d{2}T/.test(canonical)) {
    const date = new Date(canonical);
    if (Number.isFinite(date.getTime())) return manilaDay(date);
  }
  // Older cached/API records have an en-PH display date but no timezone.
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?=,|\s|$)/.exec(timestamp);
  if (!match) return null;
  const day = `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  return isHistoryDay(day) ? day : null;
}
