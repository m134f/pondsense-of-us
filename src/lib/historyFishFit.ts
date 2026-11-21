import { activeSpecies } from '../data/fish';
import type { FishSpecies, SessionRecord } from '../types';
import { rankPartialFish } from './partialFish';

export function historyFishFit(row: SessionRecord, profiles: FishSpecies[]) {
  const ranked = rankPartialFish(
    profiles.filter(fish => activeSpecies.some(species => species.id === fish.id)),
    {
      ph: row.ph,
      temperature: row.temperature,
      dissolvedOxygen: row.dissolvedOxygen,
      turbidity: row.turbidityEstimated ? null : row.turbidity,
      ammonia: row.ammonia
    }
  );
  const first = ranked[0];
  if (!first || !first.checks.length) return null;
  const leaders = ranked.filter(item => item.matches.length === first.matches.length && Math.abs(item.distance - first.distance) < 0.000001);
  return {
    fish: leaders.map(item => item.fish.name).join(', '),
    fit: `${first.matches.length}/${first.checks.length}`,
    hasMatch: first.matches.length > 0
  };
}
