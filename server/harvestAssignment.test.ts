import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Pool } from 'mysql2/promise';
import { harvestAssignmentGuard } from './harvestAssignmentGuard';
import { createAuthSession } from './auth';
import { migrateOwnerFishpen } from './migrations/ownerFishpen';
import { assignedFishpen } from './services/OwnerFishpen';
import { estimatedRemainingStock } from '../src/lib/harvest';

test('assignment migration is additive and only backfills unambiguous owners', async () => {
  const queries: string[] = [];
  await migrateOwnerFishpen({ query: async (sql: string) => { queries.push(sql); return [[], []]; } } as unknown as Pool);
  assert.ok(queries.every(sql => !/^\s*(DROP|DELETE|TRUNCATE)\b/i.test(sql)));
  assert.match(queries.at(-1)!, /HAVING COUNT\(\*\) = 1/);
  assert.match(queries[0], /owner_user_id INT PRIMARY KEY/);
});
test('a monitoring device no longer owned by the farmer invalidates the assignment', async () => {
  const db = { query: async (sql: string) => sql.includes('owner_fishpen_assignments') ? [[{ id: 10, name: 'Cuyab A', deviceId: 7 }], []] : [[], []] } as unknown as Pool;
  assert.equal(await assignedFishpen(db, 1), null);
});
test('remaining stock retains partial-harvest and recorded-death arithmetic', () => {
  assert.equal(estimatedRemainingStock(1000, [{ deadCount: 20 }], [{ fishCount: 100 }, { fishCount: 50 }, { fishCount: null }]), 830);
});
test('HTTP guard resolves assignment server-side, preserves history, and blocks cross-owner writes', async () => {
  const db = { query: async (sql: string, args: unknown[]) => {
    const owner = Number(args[args.length - 1]);
    if (sql.includes('FROM owner_fishpen_assignments')) return [owner === 1 ? [{ id: 10, name: 'Cuyab A', deviceId: null }] : [], []];
    if (sql.includes('FROM harvest_batches')) return [Number(args[0]) === 100 && owner === 1 ? [{ fishpen_id: 10 }] : [], []];
    throw new Error('Unexpected query');
  } } as unknown as Pool;
  const app = express(); app.use(express.json());
  app.get('/test-login/:id', (req, res) => { createAuthSession(res, Number(req.params.id), req.query.admin ? 'admin' : 'farmer'); res.json({ ok: true }); });
  app.use('/api/harvests', harvestAssignmentGuard(db));
  app.get('/api/harvests', (_req, res) => res.json({ assignment: res.locals.fishpenAssignment }));
  app.post('/api/harvests', (_req, res) => res.json({ fishpenId: res.locals.fishpenAssignment.id }));
  app.post('/api/harvests/:id/events', (_req, res) => res.json({ saved: true }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = async (id: string) => (await fetch(base + '/test-login/' + id)).headers.get('set-cookie')!.split(';')[0];
  try {
    const a = await login('1'), b = await login('2'), admin = await login('1?admin=true');
    const request = (path: string, cookie: string, body = {}) => fetch(base + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await fetch(base + '/api/harvests')).status, 401);
    assert.equal((await request('/api/harvests', admin)).status, 403);
    const forged = await request('/api/harvests', a, { fishpenId: 9999, owner_user_id: 2 });
    assert.equal(forged.status, 200); assert.equal((await forged.json()).fishpenId, 10);
    assert.equal((await request('/api/harvests', b)).status, 409);
    assert.equal((await fetch(base + '/api/harvests', { headers: { Cookie: b } })).status, 200);
    assert.equal((await request('/api/harvests/100/events', b)).status, 404);
    assert.equal((await request('/api/harvests/100/events', a)).status, 200);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
