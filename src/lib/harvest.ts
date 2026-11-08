export type HarvestCountRecord = { deadCount: number };
export type HarvestFishRecord = { fishCount: number | null };

export function estimatedRemainingStock(
  stockedCount: number,
  mortalities: HarvestCountRecord[],
  harvests: HarvestFishRecord[]
) {
  const dead = mortalities.reduce((sum, record) => sum + Number(record.deadCount), 0);
  const harvested = harvests.reduce((sum, record) => sum + Number(record.fishCount || 0), 0);
  return Math.max(0, Number(stockedCount) - dead - harvested);
}

export function daysUntilHarvest(targetDate: string, today: string) {
  return Math.round((Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export function harvestReminderDue(targetDate: string, today: string) {
  return daysUntilHarvest(targetDate, today) < 0 || [7, 1, 0].includes(daysUntilHarvest(targetDate, today));
}

export function harvestStage(target: string, today: string, completed = false) {
  if (completed) return 'completed';
  const days = daysUntilHarvest(target, today);
  return days < 0 ? 'overdue' : days === 0 ? 'due' : days <= 7 ? 'approaching' : 'planned';
}
export function recentMortality(records: Array<{ mortalityDate: string; deadCount: number }>, today: string) {
  return records.filter(r => { const age = daysUntilHarvest(r.mortalityDate, today); return age <= 0 && age >= -6; })
    .reduce((sum, r) => sum + Number(r.deadCount), 0);
}
export function csvCell(value: unknown) {
  const text = String(value ?? '');
  return `"${(/^[\s]*[=+@-]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
}
