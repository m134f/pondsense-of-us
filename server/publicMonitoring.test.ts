import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Pool } from 'mysql2/promise';
import { publicMonitoringRouter } from './routes/publicMonitoring';
test('public endpoint returns only measurements and forbids anonymous publication', async () => {
  let sql = '';
  const db = { query: async (query: string) => { sql = query; return [[{ ph: null, temperature_c: '28.5', turbidity_ntu: '120', recorded_at: '2026-11-16T12:00:00Z', sampled_at: null, owner_phone: 'PRIVATE', api_key_hash: 'PRIVATE' }]]; } } as unknown as Pool;
  const app = express(); app.use(express.json()); app.use(publicMonitoringRouter(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(`${base}/public/monitoring`);
    const body = await response.json();
    assert.equal(body.reading.temperature, 28.5);
    assert.equal(body.reading.ph, null);
    assert.ok(!JSON.stringify(body).includes('PRIVATE'));
    assert.match(sql, /p.id = 1 AND t.water_contact_confirmed = TRUE/);
    assert.equal((await fetch(`${base}/admin/public-monitoring`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 1 }) })).status, 401);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
