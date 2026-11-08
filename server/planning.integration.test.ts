import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import bcrypt from 'bcryptjs';
import { migratePlanning } from './migrations/planning';
import { planningContext, archiveRecommendations } from './services/PlanningService';
import { sendDailySms } from './services/PlanningSms';

// Opt-in only. This never connects to the application's configured database.
test('planning HTTP, database isolation, history, stock locks and SMS deduplication', { skip: process.env.RUN_PLANNING_DB_TESTS !== '1', timeout: 120000 }, async t => {
  const db = mysql.createPool({ host: '127.0.0.1', port: 3307, user: 'root', password: '', multipleStatements: true });
  const database = `pondsense_planning_test_${Date.now()}`;
  await db.query(`CREATE DATABASE ${database}`);
  const scoped = mysql.createPool({ host: '127.0.0.1', port: 3307, user: 'root', password: '', database, multipleStatements: true });
  const schema = (await readFile('server/schema.sql', 'utf8')).replace(/CREATE DATABASE IF NOT EXISTS pondsense;\s*USE pondsense;/, '');
  await scoped.query(schema);
  const secret = 'isolated-planning-test-signing-secret';
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { windowsHide: true, env: {
    ...process.env, PORT: '5001', MYSQL_HOST: '127.0.0.1', MYSQL_PORT: '3307', MYSQL_USER: 'root', MYSQL_PASSWORD: '', MYSQL_DATABASE: database,
    MYSQL_SSL: 'false', SESSION_SECRET: secret, IPROG_SMS_API_TOKEN: '', NODE_ENV: 'test', ADMIN_PASSWORD: 'planning-test-password', ADMIN_PIN: 'planning-test-pin'
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
  const cookie = (id: number, role = 'farmer') => {
    const content = [ { alg: 'HS256', typ: 'JWT' }, { sub: id, role, exp: Math.floor(Date.now() / 1000) + 3600 } ].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
    return `pondsense_auth=${content}.${crypto.createHmac('sha256', secret).update(content).digest('base64url')}`;
  };
  const request = async (path: string, user: number, method = 'GET', body?: object, extra: Record<string,string> = {}) => {
    const response = await fetch(`http://127.0.0.1:5001/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Cookie: cookie(user) } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); return { status: response.status, data };
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { if ((await request('/health', 0)).data.database === 'mysql-connected') { ready = true; break; } } catch { /* startup */ } await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, output);
    assert.doesNotMatch(output, /storage initialization error/i);
    const hash = await bcrypt.hash('test-password-only', 4);
    const [u] = await scoped.execute<ResultSetHeader>("INSERT INTO users(full_name,phone,password_hash,role) VALUES ('Test Farmer A','+639111111111',?,'farmer'),('Test Farmer B','+639222222222',?,'farmer')", [hash, hash]);
    const a = u.insertId, b = a + 1;
    const deviceKey = 'isolated-test-device-key';
    const [d] = await scoped.execute<ResultSetHeader>('INSERT INTO sensor_devices(device_name,api_key_hash,owner_user_id) VALUES (?,?,?),(?,?,?)', ['Test Pen A device', await bcrypt.hash(deviceKey, 4), a, 'Test Pen B device', hash, a]);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    const batch = { species: 'Tilapia', fishpenName: 'Test Pen A', stockingDate: '2026-01-01', stockedCount: 100, targetHarvestDate: today, targetWeightG: 350, reminderSms: false, sensorDeviceId: d.insertId, notes: 'Farmer chosen plan' };
    const created = await request('/harvests', a, 'POST', batch); assert.equal(created.status, 201, JSON.stringify(created));
    const id = created.data.id;
    const second = await request('/harvests', a, 'POST', { ...batch, fishpenName: 'Test Pen B', sensorDeviceId: d.insertId + 1 }); assert.equal(second.status, 201);
    await t.test('migration is repeatable and keeps batches', async () => { await migratePlanning(scoped); await migratePlanning(scoped); const [rows] = await scoped.query<RowDataPacket[]>('SELECT * FROM harvest_batches WHERE id = ?', [id]); assert.equal(rows[0].notes, batch.notes); });
    await t.test('cross-account access denied on every planning write/read', async () => {
      assert.equal((await request(`/harvests/${id}/review`, b)).status, 404);
      assert.equal((await request(`/harvests/${id}`, b, 'PUT', batch)).status, 404);
      assert.equal((await request(`/harvests/${id}`, b, 'DELETE')).status, 404);
      assert.equal((await request(`/harvests/${id}/water`, b, 'POST', { parameter: 'ph', value: 7 })).status, 404);
      assert.equal((await request(`/harvests/${id}/observations`, b, 'POST', { date: today, category: 'normal' })).status, 404);
      assert.equal((await request('/recommendations', 0)).status, 401);
      assert.equal((await request('/harvests', b)).data.harvests.length, 0);
    });
    await t.test('actual temperature/turbidity together; no phantom DO/ammonia; fishpen isolation', async () => {
      const result = await request('/v1/sensors/measurements', 0, 'POST', { rawValue: 2000, voltage: 1.6, temperatureC: 28.5, turbidityNtu: 65, ph: 7.2 }, { 'X-API-Key': deviceKey });
      assert.equal(result.status, 201, JSON.stringify(result)); assert.equal(result.data.saved, true);
      const context = await planningContext(scoped, a, id);
      assert.equal(context?.recommendations.find(r => r.parameter === 'temperature')?.value, 28.5);
      assert.equal(context?.recommendations.find(r => r.parameter === 'turbidity')?.value, 65);
      assert.equal(context?.recommendations.find(r => r.parameter === 'ammonia')?.state, 'missing');
      assert.equal(context?.status, 'incomplete');
      assert.ok((await planningContext(scoped, a, second.data.id))?.recommendations.every(r => r.state === 'missing'));
      await archiveRecommendations(scoped, a, 'sensor', result.data.telemetryId);
      const [before] = await scoped.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM recommendation_history');
      await request('/recommendations', a); await request('/recommendations', a); await request(`/harvests/${id}/review`, a);
      const [after] = await scoped.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM recommendation_history');
      assert.equal(before[0].n, after[0].n); assert.equal(after[0].n, 10);
      const history = await request('/recommendations/history?parameter=temperature&fishpen=Test+Pen+A', a);
      assert.equal(history.data.history.length, 1);
      const recId = history.data.history[0].id;
      assert.equal((await request(`/recommendations/${recId}/acknowledge`, b, 'POST')).status, 404);
      assert.equal((await request(`/recommendations/${recId}/acknowledge`, a, 'POST')).status, 200);
      assert.equal((await request('/recommendations/history', b)).data.history.length, 0);
      await scoped.query('UPDATE sensor_telemetry SET recorded_at = DATE_SUB(NOW(), INTERVAL 2 MINUTE)');
      assert.equal((await planningContext(scoped, a, id))?.recommendations.find(r => r.parameter === 'temperature')?.state, 'stale');
    });
    await t.test('incomplete species thresholds use explicit reference fallback, never zero', async () => {
      const [fish] = await scoped.query<RowDataPacket[]>("SELECT optimal_do_min FROM fish_species WHERE name = 'Tilapia'");
      try {
        await scoped.execute("UPDATE fish_species SET optimal_do_min = NULL WHERE name = 'Tilapia'");
        const context = await planningContext(scoped, a, id);
        assert.match(context!.reference, /configuration incomplete/);
        assert.equal(context!.recommendations.find(r => r.parameter === 'dissolvedOxygen')?.state, 'missing');
      } finally { await scoped.execute("UPDATE fish_species SET optimal_do_min = ? WHERE name = 'Tilapia'", [fish[0].optimal_do_min]); }
    });
    await t.test('manual measurement validation, source and observations', async () => {
      assert.equal((await request(`/harvests/${id}/water`, a, 'POST', { parameter: 'dissolvedOxygen', value: true })).status, 400);
      const saved = await request(`/harvests/${id}/water`, a, 'POST', { parameter: 'dissolvedOxygen', value: 6 });
      assert.equal(saved.status, 201); assert.equal(saved.data.historySaved, true);
      assert.equal((await planningContext(scoped, a, id))?.recommendations.find(r => r.parameter === 'dissolvedOxygen')?.source, 'manual');
      assert.equal((await request(`/harvests/${id}/observations`, a, 'POST', { date: today, category: 'reduced_feeding', notes: 'Recorded observation, no diagnosis' })).status, 201);
      assert.equal((await request(`/harvests/${id}/review`, a)).data.observations.length, 1);
    });
    await t.test('sampling, mortality, partial harvest, gross sales and stock limits', async () => {
      assert.equal((await request(`/harvests/${id}/samples`, a, 'POST', { sampledAt: today, sampleSize: 10, averageWeightG: 320, notes: 'Actual sample' })).status, 201);
      assert.equal((await request(`/harvests/${id}/mortalities`, a, 'POST', { mortalityDate: today, deadCount: 5, notes: 'Counted' })).status, 201);
      const partial = { harvestType: 'partial', harvestDate: today, fishCount: 20, weightKg: 10, pricePerKg: 120, notes: 'First sale' };
      assert.equal((await request(`/harvests/${id}/events`, a, 'POST', partial)).status, 201);
      assert.equal((await request(`/harvests/${id}/events`, a, 'POST', { ...partial, fishCount: 76 })).status, 400);
      assert.equal((await request(`/harvests/${id}`, a, 'PUT', { ...batch, stockedCount: 24 })).status, 400);
      const rows = (await request('/harvests', a)).data.harvests;
      const row = rows.find((r: { id: number }) => r.id === id);
      assert.equal(row.actualHarvestDate, null); assert.equal(row.samples[0].notes, 'Actual sample');
      assert.equal(row.stockedCount - row.mortalities[0].deadCount - row.harvestEvents[0].fishCount, 75);
      assert.equal(Number(row.harvestEvents[0].weightKg) * Number(row.harvestEvents[0].pricePerKg), 1200);
      assert.equal((await request(`/harvests/${id}/events`, a, 'POST', { ...partial, harvestType: 'complete' })).status, 400);
      const completion = await request(`/harvests/${id}/events`, a, 'POST', { ...partial, harvestType: 'complete', fishCount: 75, confirmComplete: true }); assert.equal(completion.status, 201);
      assert.equal((await request(`/harvests/${id}/samples`, a, 'POST', { sampledAt: today, sampleSize: 1, averageWeightG: 330 })).status, 404);
      const completed = (await request('/harvests', a)).data.harvests.find((r: { id: number }) => r.id === id);
      assert.equal(completed.actualHarvestDate, today); assert.equal(completed.harvestEvents.length, 2); assert.equal(completed.samples.length, 1); assert.equal(completed.mortalities.length, 1);
      assert.equal((await request(`/harvests/${id}/review`, a)).data.observations.length, 1);
    });
    await t.test('concurrent removals cannot oversell stock', async () => {
      const results = await Promise.all([1, 2].map(() => request(`/harvests/${second.data.id}/mortalities`, a, 'POST', { mortalityDate: today, deadCount: 60 })));
      assert.deepEqual(results.map(r => r.status).sort(), [201, 400]);
    });
    await t.test('daily SMS concurrency, failed status, reminder deduplication', async () => {
      process.env.IPROG_SMS_API_TOKEN = 'test-only-not-a-provider-token';
      let sends = 0;
      const sender = async () => { sends++; return { configured: true, ok: false, message: 'Mock provider rejection' }; };
      await Promise.all([1,2].map(() => sendDailySms(scoped, a, '+639111111111', 'test', 'harvest', sender)));
      assert.equal(sends, 1);
      const [rows] = await scoped.query<RowDataPacket[]>('SELECT status FROM planning_sms_log WHERE owner_user_id = ?', [a]); assert.equal(rows[0].status, 'failed');
      for (const day of [7, 1, 0, -1]) for (let repeat = 0; repeat < 2; repeat++) await scoped.execute("INSERT IGNORE INTO harvest_reminder_log(batch_id,reminder_day,target_date,sms_status) VALUES (?,?,?,'failed')", [id, day, today]);
      const [reminders] = await scoped.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM harvest_reminder_log WHERE batch_id = ?', [id]); assert.equal(reminders[0].n, 4);
      delete process.env.IPROG_SMS_API_TOKEN;
    });
    console.log(`Isolated test database retained for inspection: ${database}`);
  } finally {
    child.kill(); await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
    await scoped.end(); await db.end();
  }
});
