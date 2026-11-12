import type { Pool, RowDataPacket } from 'mysql2/promise';
import { activeSpecies, fishDatabase, speciesId } from '../../src/data/fish';
import type { FishSpecies } from '../../src/types';

export function configuredProfile(row: Record<string, unknown>): FishSpecies | undefined {
  const base = fishDatabase.find(f => f.id === speciesId(String(row.name)));
  if (!base) return;
  const n = (key: string) => row[key] == null || String(row[key]).trim() === '' ? NaN : Number(row[key]);
  const ranges: FishSpecies['ranges'] = {
    ph: [n('optimal_ph_min'), n('optimal_ph_max')], temperature: [n('optimal_temp_min'), n('optimal_temp_max')],
    dissolvedOxygen: [n('optimal_do_min'), n('optimal_do_max')], turbidity: [n('optimal_turb_min'), n('optimal_turb_max')],
    ammonia: [0, n('max_ammonia')]
  };
  if (!Object.values(ranges).every(([lo, hi]) => Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && lo < hi)) return;
  return { ...base, ranges };
}
export function buildCatalog(rows: Record<string, unknown>[]) {
  const profiles: FishSpecies[] = [];
  const fish = activeSpecies.map(s => {
    const row = rows.find(r => speciesId(String(r.name)) === s.id);
    if (!row || s.id === 'mamali') return { id: row?.id ?? s.id, name: s.name, validationPending: true };
    const profile = configuredProfile(row);
    if (profile) profiles.push(profile);
    return { ...row, name: s.name };
  });
  return { fish, profiles };
}
export async function loadFishCatalog(pool: Pool) {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM fish_species WHERE is_active = TRUE ORDER BY id');
  return buildCatalog(rows);
}
