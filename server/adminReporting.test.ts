import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { Pool } from 'mysql2/promise';
import { createAuthSession } from './auth';
import { adminDeviceConnection, adminFreshnessSeconds, adminReportingRouter, philippineDayBounds } from './routes/adminReporting';

test('connectivity requires a real current-owner upload and a recent trustworthy sample', () => {
  assert.equal(adminFreshnessSeconds(''), 60);
  assert.equal(adminFreshnessSeconds('9'), 60);
  assert.equal(adminFreshnessSeconds('75'), 75);
  assert.equal(adminDeviceConnection(0, 'uploaded', 1, 60), 'inactive');
  assert.equal(adminDeviceConnection(1, null, null, 60), 'never');
  assert.equal(adminDeviceConnection(1, 'uploaded', null, 60), 'offline');
  assert.equal(adminDeviceConnection(1, 'uploaded', -1, 60), 'offline');
  assert.equal(adminDeviceConnection(1, 'uploaded', 59, 60), 'online');
  assert.equal(adminDeviceConnection(1, 'uploaded', 60, 60), 'offline');
});

test('daily counters roll over at Philippine midnight', () => {
  assert.deepEqual(philippineDayBounds(Date.parse('2026-11-23T15:59:59Z')), ['2026-11-22 16:00:00', '2026-11-23 16:00:00']);
  assert.deepEqual(philippineDayBounds(Date.parse('2026-11-23T16:00:00Z')), ['2026-11-23 16:00:00', '2026-11-24 16:00:00']);
});

test('admin reports are role restricted, read-only, and do not expose secrets or guess a historical fishpen', async () => {
  let unavailable = false;
  let queryCount = 0;
  const query = async (sql: string) => {
    if (sql.includes('FROM admin_security')) return [[{ admin_id: 1, enforced: true }]];
    if (sql.includes('FROM admin_credentials')) return [[{ id: 7 }]];
    if (sql.startsWith('SELECT id FROM users')) return [[{ id: 1 }]];
    queryCount++;
    assert.doesNotMatch(sql, /api_key_hash|password_hash|\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
    if (unavailable) throw new Error('fixture database unavailable');
    if (sql.includes('AS sensorReadings')) return [[{ farmers: 3, sensorReadings: 8, criticalToday: 1, smsToday: 2 }]];
    if (sql.includes('FROM sensor_devices d LEFT JOIN users')) {
      assert.match(sql, /t\.owner_user_id = d\.owner_user_id/);
      assert.match(sql, /GREATEST\(TIMESTAMPDIFF\(SECOND, t\.sampled_at/);
      return [[
        { id: 10, is_active: 1, monitoring_fishpen_id: 2, current_upload_at: new Date(), freshness_age: 1 },
        { id: 11, is_active: 1, monitoring_fishpen_id: 3, current_upload_at: new Date(), freshness_age: null },
        { id: 12, is_active: 1, monitoring_fishpen_id: null, current_upload_at: null, freshness_age: null },
        { id: 13, is_active: 0, monitoring_fishpen_id: null, current_upload_at: null, freshness_age: null }
      ]];
    }
    if (sql.includes(') recent ORDER BY')) return [[]];
    if (sql.includes('FROM sensor_telemetry t LEFT JOIN sensor_devices')) {
      assert.match(sql, /u\.id = t\.owner_user_id/);
      assert.doesNotMatch(sql, /fishpen_id/);
      return [[{ id: 19, owner_name: 'Historical owner', ph: null, turbidity_ntu: null }]];
    }
    throw new Error('Unexpected query');
  };
  const pool = { query, execute: query } as unknown as Pool;
  const app = express();
  app.get('/fixture/:role', (req, res) => {
    const admin = req.params.role !== 'farmer';
    createAuthSession(res, 1, admin ? 'admin' : 'farmer', 0, req.params.role === 'admin' ? 7 : undefined);
    res.sendStatus(200);
  });
  app.use('/api', adminReportingRouter(pool));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cookie = async (role: string) => (await fetch(`${base}/fixture/${role}`)).headers.get('set-cookie')!.split(';')[0];
  const get = (path: string, session = '') => fetch(`${base}/api/admin/${path}`, { headers: session ? { Cookie: session } : {} });
  try {
    const farmer = await cookie('farmer');
    for (const path of ['overview', 'devices', 'telemetry']) {
      assert.equal((await get(path)).status, 401);
      assert.equal((await get(path, farmer)).status, 403);
    }
    assert.equal((await get('overview', await cookie('unverified'))).status, 403);
    assert.equal(queryCount, 0);
    const admin = await cookie('admin');
    const response = await get('overview', admin);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const overview = await response.json();
    assert.deepEqual(overview.counts, { farmers: 3, sensorReadings: 8, criticalToday: 1, smsToday: 2 });
    assert.deepEqual(overview.devices, { online: 1, offline: 1, never: 1, inactive: 1, assigned: 2 });
    assert.deepEqual((await (await get('devices', admin)).json()).devices.map((row: { connection: string }) => row.connection), ['online', 'offline', 'never', 'inactive']);
    assert.deepEqual((await (await get('telemetry', admin)).json()).readings, [{ id: 19, owner_name: 'Historical owner', ph: null, turbidity_ntu: null }]);
    unavailable = true;
    assert.equal((await get('overview', admin)).status, 503);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
