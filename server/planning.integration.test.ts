import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
  const origin = 'http://localhost:5173';
  const env = {
    ...process.env, PORT: '5001', MYSQL_HOST: '127.0.0.1', MYSQL_PORT: '3307', MYSQL_USER: 'root', MYSQL_PASSWORD: '', MYSQL_DATABASE: database,
    MYSQL_SSL: 'false', SESSION_SECRET: secret, IPROG_SMS_API_TOKEN: '', NODE_ENV: 'test', FRONTEND_URL: origin,
    ADMIN_USERNAME: 'staging-admin', ADMIN_PHONE: '+639199999999', ADMIN_PASSWORD: 'planning-test-password', ADMIN_PIN: 'planning-test-pin'
  };
  const prepare = spawn(process.execPath, ['--import', 'tsx', 'server/prepare-local-database.ts'], { windowsHide: true, env, stdio: 'inherit' });
  assert.equal(await new Promise(resolve => prepare.once('exit', resolve)), 0);
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
  const sessions = new Map<number, string>();
  const request = async (path: string, user: number, method = 'GET', body?: object, extra: Record<string,string> = {}) => {
    const cookie = sessions.get(user);
    const response = await fetch(`http://127.0.0.1:5001/api${path}`, { method, headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { if ((await request('/health', 0)).data.database === 'mysql-connected') { ready = true; break; } } catch { /* startup */ } await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, output);
    assert.doesNotMatch(output, /storage initialization error/i);
    const hash = await bcrypt.hash('test-password-only', 4);
    const [u] = await scoped.execute<ResultSetHeader>("INSERT INTO users(full_name,phone,password_hash,role,account_status) VALUES ('Test Farmer A','+639111111111',?,'farmer','ACTIVE'),('Test Farmer B','+639222222222',?,'farmer','ACTIVE')", [hash, hash]);
    const a = u.insertId, b = a + 1;
    const deviceKey = 'isolated-test-device-key';
    const [d] = await scoped.execute<ResultSetHeader>('INSERT INTO sensor_devices(device_name,api_key_hash,owner_user_id) VALUES (?,?,?),(?,?,?)', ['Test Pen A device', await bcrypt.hash(deviceKey, 4), a, 'Test Pen B device', hash, b]);
    const [pens] = await scoped.execute<ResultSetHeader>('INSERT INTO sms_fishpens(owner_user_id,name,device_id) VALUES (?,?,?),(?,?,?)', [a, 'Test Pen A', d.insertId, b, 'Test Pen B', d.insertId + 1]);
    await scoped.execute('INSERT INTO owner_fishpen_assignments(owner_user_id,fishpen_id) VALUES (?,?),(?,?)', [a, pens.insertId, b, pens.insertId + 1]);
    await t.test('real owner login, assignments, password change and trusted origin', async () => {
      assert.equal((await request('/register', 0, 'POST', {})).status, 410);
      assert.equal((await request('/login', 0, 'POST', { phone: '+639111111111', password: 'wrong' })).status, 401);
      for (const [owner, phone, fishpen, device] of [[a, '+639111111111', pens.insertId, d.insertId], [b, '+639222222222', pens.insertId + 1, d.insertId + 1]] as const) {
        const signedIn = await request('/login', 0, 'POST', { phone, password: 'test-password-only' });
        assert.equal(signedIn.status, 200, JSON.stringify(signedIn.data)); assert.ok(signedIn.cookie);
        sessions.set(owner, signedIn.cookie);
        const session = await request('/session', owner);
        assert.equal(session.status, 200); assert.equal(session.data.fishpenAssignment.id, fishpen); assert.equal(session.data.fishpenAssignment.deviceId, device);
      }
      assert.equal((await request('/readings', a, 'POST', { partialManual: true, ph: 7.2 }, { Origin: 'https://unconfigured.example' })).status, 403);
      assert.equal((await request('/owner/password', a, 'POST', { currentPassword: 'wrong', newPassword: 'another-staging-password' })).status, 403);
      const changed = await request('/owner/password', a, 'POST', { currentPassword: 'test-password-only', newPassword: 'another-staging-password' });
      assert.equal(changed.status, 200, JSON.stringify(changed.data)); assert.ok(changed.cookie);
      assert.equal((await request('/session', a)).status, 403);
      assert.equal((await request('/login', 0, 'POST', { phone: '+639111111111', password: 'test-password-only' })).status, 401);
      const login = await request('/login', 0, 'POST', { phone: '+639111111111', password: 'another-staging-password' });
      assert.equal(login.status, 200); assert.ok(login.cookie); sessions.set(a, login.cookie);
    });
    await t.test('partial manual tests persist with nulls and owner isolation', async () => {
      assert.equal((await request('/readings', 0, 'POST', { partialManual: true, ph: 7.2 })).status, 401);
      for (const values of [{}, { ph: 15 }, { temperature: -1 }, { ph: true }]) {
        assert.equal((await request('/readings', a, 'POST', { partialManual: true, ...values })).status, 400);
      }
      for (const values of [{ ph: 7.2 }, { temperature: 28 }, { ph: 9.2, temperature: 29 }]) {
        const saved = await request('/readings', a, 'POST', { partialManual: true, userId: b, ...values });
        assert.equal(saved.status, 200, JSON.stringify(saved));
        const session = saved.data.session;
        assert.equal(session.dissolvedOxygen, null);
        assert.equal(session.score, null);
        const history = await request('/readings', a);
        assert.deepEqual(history.data.sessions.find((r: { id: string }) => r.id === session.id), session);
        assert.ok(!(await request('/readings', b)).data.sessions.some((r: { id: string }) => r.id === session.id));
        const [rows] = await scoped.query<RowDataPacket[]>('SELECT * FROM water_readings WHERE id = ?', [session.id]);
        assert.equal(rows[0].user_id, a);
        assert.equal(rows[0].status, null);
        assert.equal(rows[0].turbidity, null);
        await scoped.query('DELETE FROM water_readings WHERE id = ?', [session.id]);
      }
    });
    await t.test('four-parameter manual saves are retry-safe and never create SMS alerts', async () => {
      const time = (offset = 0) => new Date(Math.floor(Date.now() / 1000) * 1000 + offset).toISOString();
      for (const body of [{ dissolvedOxygen: -1 }, { turbidity: 1001 }, { ammonia: 0 }, { ph: 9, manualSaveTime: 'bad' }]) {
        assert.equal((await request('/readings', a, 'POST', { partialManual: true, ...body })).status, 400);
      }
      const payload = { partialManual: true, ph: 9, temperature: 35, dissolvedOxygen: 0, turbidity: 210.005, manualSaveTime: time() };
      const [first, duplicate] = await Promise.all([
        request('/readings', a, 'POST', payload), request('/readings', a, 'POST', payload)
      ]);
      assert.equal(first.status, 200, JSON.stringify(first));
      assert.equal(duplicate.status, 200, JSON.stringify(duplicate));
      assert.deepEqual(first.data, duplicate.data);
      const retry = await request('/readings', a, 'POST', payload);
      assert.deepEqual(retry.data, first.data);
      const session = first.data.session;
      assert.equal(session.dissolvedOxygen, 0);
      assert.equal(session.turbidity, 210.01);
      assert.equal(session.ammonia, null);
      const history = await request('/readings', a);
      assert.deepEqual(history.data.sessions, [session]);
      const intentionalRepeat = await request('/readings', a, 'POST', { ...payload, manualSaveTime: time(-2000) });
      assert.equal(intentionalRepeat.status, 200);
      assert.notEqual(intentionalRepeat.data.session.id, session.id);
      const onlyTurbidity = await request('/readings', a, 'POST', { partialManual: true, turbidity: 15, manualSaveTime: time() });
      assert.equal(onlyTurbidity.status, 200);
      assert.equal(onlyTurbidity.data.session.ph, null);
      assert.equal(onlyTurbidity.data.session.dissolvedOxygen, null);
      assert.equal(onlyTurbidity.data.session.turbidity, 15);
      const expired = await request('/readings', a, 'POST', { partialManual: true, ph: 9, manualSaveTime: time(-16 * 60_000) });
      assert.equal(expired.status, 409);
      const [alerts] = await scoped.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM alerts JOIN water_readings ON water_readings.id = alerts.reading_id WHERE water_readings.user_id = ?', [a]);
      assert.equal(Number(alerts[0].total), 0);
      await scoped.execute("DELETE FROM water_readings WHERE user_id = ? AND input_mode = 'manual'", [a]);
    });
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    const batch = { species: 'Tilapia', fishpenName: 'Test Pen A', stockingDate: '2026-01-01', stockedCount: 100, targetHarvestDate: today, targetWeightG: 350, reminderSms: false, sensorDeviceId: d.insertId, notes: 'Farmer chosen plan' };
    const created = await request('/harvests', a, 'POST', batch); assert.equal(created.status, 201, JSON.stringify(created));
    const id = created.data.id;
    const second = await request('/harvests', a, 'POST', { ...batch, fishpenName: 'Ignored fixture name', sensorDeviceId: d.insertId + 1 }); assert.equal(second.status, 201);
    const groups = (await request('/harvests', a)).data.harvests;
    assert.equal(groups.length, 2);
    assert.ok(groups.every((row: { fishpenName: string; sensorDeviceId: number }) => row.fishpenName === 'Test Pen A' && row.sensorDeviceId === d.insertId));
    await t.test('owner SMS contact settings persist without sending SMS', async () => {
      const settings = await request('/fishpen-sms', a);
      assert.equal(settings.status, 200); assert.equal(settings.data.configured, false);
      assert.deepEqual(settings.data.fishpens.map((row: { id: number }) => row.id), [pens.insertId]);
      const body = { name: 'Test Pen A', deviceId: d.insertId, ownerEnabled: true, caretakerPhone: '09987654321', caretakerEnabled: true };
      assert.equal((await request(`/fishpen-sms/${pens.insertId}`, b, 'PUT', body)).status, 403);
      assert.equal((await request(`/fishpen-sms/${pens.insertId}`, a, 'PUT', body)).status, 200);
      assert.equal((await request('/fishpen-sms', a)).data.fishpens[0].caretaker_phone, '+639987654321');
    });
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
      const current = { rawValue: 2000, voltage: 2.5, temperatureC: 28.5, turbidityNtu: 22.5, ph: 7.2, waterContactConfirmed: true, sampledAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), clientReadingId: 'staging-current' };
      const upload = (values: object, key = deviceKey) => request('/v1/sensors/measurements', 0, 'POST', values, { 'X-API-Key': key });
      assert.equal((await upload(current, 'not-the-key')).status, 401);
      assert.equal((await upload({ ...current, waterContactConfirmed: false })).status, 422);
      assert.equal((await upload({ ...current, rawValue: null })).status, 400);
      assert.equal((await upload({ ...current, ph: 15 })).status, 400);
      const result = await upload(current);
      assert.equal(result.status, 201, JSON.stringify(result)); assert.equal(result.data.saved, true);
      const retry = await upload(current);
      assert.equal(retry.status, 201);
      assert.equal(retry.data.duplicate, true);
      assert.equal(retry.data.telemetryId, result.data.telemetryId, 'Retry must not insert another sample');
      const sensorHistory = (await request('/readings', a)).data.sessions;
      const sensorRow = sensorHistory.find((row: { id: string }) => row.id === `sensor-${result.data.telemetryId}`);
      assert.ok(sensorRow, 'Sensor telemetry appears in session history');
      assert.equal(sensorRow.inputMode, 'sensor');
      assert.equal(sensorRow.temperature, 28.5);
      assert.equal(sensorRow.ph, 7.2);
      assert.equal(sensorRow.turbidity, 22.5);
      assert.equal(sensorRow.turbidityEstimated, false);
      assert.equal(sensorRow.dissolvedOxygen, null);
      assert.equal(sensorRow.score, null);
      assert.equal((await request('/readings', b)).data.sessions.length, 0);
      const context = await planningContext(scoped, a, id);
      assert.equal(context?.recommendations.find(r => r.parameter === 'temperature')?.value, 28.5);
      assert.equal(context?.recommendations.find(r => r.parameter === 'turbidity')?.value, 22.5);
      assert.equal(context?.recommendations.find(r => r.parameter === 'ammonia')?.state, 'missing');
      assert.notEqual(context?.status, 'safe');
      assert.equal((await planningContext(scoped, a, second.data.id))?.recommendations.find(r => r.parameter === 'temperature')?.value, 28.5);
      const latest = (await request('/sensors/latest', a)).data.telemetry;
      assert.equal(latest.sampledAt, current.sampledAt.replace(/Z$/, '.000Z'));
      assert.deepEqual([latest.ph, latest.temperatureC, latest.turbidityNtu], [7.2, 28.5, 22.5]);
      assert.equal((await request('/sensors/latest', b)).data.telemetry, null);
      await archiveRecommendations(scoped, a, 'sensor', result.data.telemetryId);
      const [before] = await scoped.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM recommendation_history WHERE source_kind='sensor' AND source_id=?", [result.data.telemetryId]);
      await request('/recommendations', a); await request('/recommendations', a); await request(`/harvests/${id}/review`, a);
      const [after] = await scoped.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM recommendation_history WHERE source_kind='sensor' AND source_id=?", [result.data.telemetryId]);
      assert.equal(before[0].n, after[0].n); assert.equal(after[0].n, 15);
      const history = await request('/recommendations/history?parameter=temperature&fishpen=Test+Pen+A', a);
      assert.equal(history.data.history.length, 2);
      const recId = history.data.history[0].id;
      assert.equal((await request(`/recommendations/${recId}/acknowledge`, b, 'POST')).status, 404);
      assert.equal((await request(`/recommendations/${recId}/acknowledge`, a, 'POST')).status, 200);
      assert.equal((await request('/recommendations/history', b)).data.history.length, 0);
      const buffered = await upload({ ...current, clientReadingId: 'staging-old', sampledAt: new Date(Date.now() - 120_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), ph: null, temperatureC: null, turbidityNtu: null });
      assert.equal(buffered.status, 201);
      assert.equal((await request('/sensors/latest', a)).data.telemetry.id, latest.id);
      const trend = (await request('/sensors/trend', a)).data.readings;
      assert.deepEqual(trend.map((row: { id: number }) => row.id), [buffered.data.telemetryId, latest.id]);
      assert.deepEqual([trend[0].ph, trend[0].temperatureC, trend[0].turbidityNtu], [null, null, null]);
      await scoped.execute('UPDATE sensor_telemetry SET sampled_at = DATE_SUB(NOW(), INTERVAL 90 SECOND) WHERE id = ?', [latest.id]);
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
      assert.equal((await request(`/harvests/${id}`, a, 'PUT', { ...batch, notes: 'Updated in staging' })).status, 200);
      const rows = (await request('/harvests', a)).data.harvests;
      const row = rows.find((r: { id: number }) => r.id === id);
      assert.equal(row.actualHarvestDate, null); assert.equal(row.samples[0].notes, 'Actual sample'); assert.equal(row.notes, 'Updated in staging');
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
      assert.equal((await request(`/harvests/${second.data.id}`, a, 'DELETE')).status, 200);
      assert.ok(!(await request('/harvests', a)).data.harvests.some((row: { id: number }) => row.id === second.data.id));
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
