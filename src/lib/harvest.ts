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
  return [7, 1, 0].includes(daysUntilHarvest(targetDate, today));
}
