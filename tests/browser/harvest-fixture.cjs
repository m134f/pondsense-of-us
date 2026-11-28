// In-memory Harvest API for browser tests and the isolated localhost preview.
module.exports = function createHarvestFixture(fishpenAssignment) {
  const groups = new Map();
  let nextId = 1;
  const ok = (json, status = 200) => ({ status, json });
  return (method, path, body = {}) => {
    if (path === '/api/harvests' && method === 'GET') {
      return ok({ harvests: [...groups.values()], fishpenAssignment });
    }
    const groupFields = () => ({
      species: body.species, notes: body.notes, reminderSms: Boolean(body.reminderSms),
      stockingDate: body.stockingDate, targetHarvestDate: body.targetHarvestDate,
      stockedCount: Number(body.stockedCount), targetWeightG: body.targetWeightG ? Number(body.targetWeightG) : null
    });
    if (path === '/api/harvests' && method === 'POST') {
      const id = nextId++;
      groups.set(id, {
        ...groupFields(), id, fishpenName: fishpenAssignment.name,
        actualHarvestDate: null, harvestedKg: null, sellingPrice: null,
        samples: [], mortalities: [], harvestEvents: []
      });
      return ok({ id }, 201);
    }
    const match = /^\/api\/harvests\/(\d+)(?:\/(events|samples|mortalities))?$/.exec(path);
    if (!match) return;
    const group = groups.get(Number(match[1]));
    if (!group) return ok({ message: 'Preview fish group not found.' }, 404);
    const kind = match[2];
    if (!kind && method === 'PUT') {
      Object.assign(group, groupFields());
      return ok({ id: group.id });
    }
    if (!kind && method === 'DELETE') {
      groups.delete(group.id);
      return ok({ deleted: true });
    }
    if (kind && method === 'POST') {
      const available = group.stockedCount - group.mortalities.reduce((sum, row) => sum + row.deadCount, 0)
        - group.harvestEvents.reduce((sum, row) => sum + (row.fishCount ?? 0), 0);
      const count = kind === 'events' ? body.fishCount : kind === 'mortalities' ? Number(body.deadCount) : null;
      if (kind === 'events' && body.harvestType === 'partial' && count == null) {
        return ok({ message: 'Enter the number of fish harvested for a partial harvest.' }, 400);
      }
      if (count != null && (!Number.isSafeInteger(Number(count)) || Number(count) < 1 || Number(count) > available)) {
        return ok({ message: 'Count exceeds available stock.' }, 400);
      }
      const id = nextId++;
      if (kind === 'events') {
        group.harvestEvents.push({ id, harvestDate: body.harvestDate, harvestType: body.harvestType,
          fishCount: body.fishCount ? Number(body.fishCount) : null, weightKg: Number(body.weightKg),
          pricePerKg: body.pricePerKg ? Number(body.pricePerKg) : null });
        if (body.harvestType === 'complete' && body.confirmComplete) group.actualHarvestDate = body.harvestDate;
      } else if (kind === 'samples') {
        group.samples.push({ id, sampledAt: body.sampledAt, sampleSize: Number(body.sampleSize), averageWeightG: Number(body.averageWeightG) });
      } else {
        group.mortalities.push({ id, mortalityDate: body.mortalityDate, deadCount: Number(body.deadCount), notes: body.notes });
      }
      return ok({ id, remainingStock: group.actualHarvestDate ? 0 : available - Number(count ?? 0) }, 201);
    }
  };
};
