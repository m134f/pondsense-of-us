import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import mysql from 'mysql2/promise';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { migrateFishpenSms } from './migrations/fishpenSms';
import { queueWaterSms, drainWaterSms, sensorSmsMeasurements } from './services/FishpenSms';
import { fishpenSmsRouter } from './routes/fishpenSms';

// Local isolated database only. No .env import and every SMS call uses the injected fake sender.
test('fishpen SMS database and HTTP integration', { skip: process.env.RUN_SMS_DB_TESTS !== '1', timeout: 60000 }, async t => {
  process.env.IPROG_SMS_API_TOKEN = '';
  process.env.SESSION_SECRET = 'local-sms-test-secret';
  process.env.WATER_SMS_THRESHOLDS_REVIEWED = 'true';
  process.env.WATER_SMS_RULES_REFERENCE = 'Test fixture only - not a real scientific validation';
  const database = `pondsense_sms_test_${Date.now()}`;
  const root = mysql.createPool({ host: '127.0.0.1', port: 3307, user: 'root', password: '' });
  await root.query(`CREATE DATABASE ${database}`);
  const db = mysql.createPool({ host: '127.0.0.1', port: 3307, user: 'root', password: '', database, timezone: 'local' });
  await db.query("CREATE TABLE users(id INT PRIMARY KEY, phone VARCHAR(20), role VARCHAR(10))");
  await db.query("INSERT INTO users VALUES (1,'+639111111111','farmer'),(2,'+639222222222','farmer'),(3,'+639333333333','admin')");
  await db.query('CREATE TABLE sensor_devices(id INT PRIMARY KEY, owner_user_id INT, device_name VARCHAR(100), is_active BOOLEAN DEFAULT TRUE)');
  await db.query("INSERT INTO sensor_devices(id,owner_user_id,device_name) VALUES (1,1,'Cuyab A'),(2,2,'Cuyab B')");
  await migrateFishpenSms(db);
  const app = express(); app.use(express.json()); app.use('/api', fishpenSmsRouter(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const cookie = (owner: number) => {
    const content = [{ alg: 'HS256', typ: 'JWT' }, { sub: owner, role: owner === 3 ? 'admin' : 'farmer', exp: Math.floor(Date.now() / 1000) + 3600 }].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
    return `pondsense_auth=${content}.${crypto.createHmac('sha256', process.env.SESSION_SECRET!).update(content).digest('base64url')}`;
  };
  const request = async (path: string, owner: number, method = 'GET', body?: object) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(owner ? { Cookie: cookie(owner) } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  const calls: Array<{ phone: string; message: string }> = [];
  const sender = async (phone: string, message: string) => { calls.push({ phone, message }); return { configured: true, ok: true, message: 'Mock accepted, not delivered', messageId: 'mock-only' }; };
  const rows = async (query: string) => (await db.query<RowDataPacket[]>(query))[0];
  const newPen = async (caretaker: string | null = null, owner = 1) => {
    const [result] = await db.execute<ResultSetHeader>('INSERT INTO sms_fishpens(owner_user_id,name,caretaker_phone,caretaker_enabled) VALUES (?,?,?,?)', [owner, `Test fishpen ${calls.length}`, caretaker, Boolean(caretaker)]);
    return result.insertId;
  };
  const queue = (pen: number, value = 34, owner = 1, offset = 0) => queueWaterSms(db, { owner, fishpenId: pen, sourceId: 1, sourceKind: 'test', measurements: sensorSmsMeasurements({ temperature: value }, { sampledAt: new Date(Date.now() + offset).toISOString(), verifiedParameters: ['temperature'] }) });
  try {
    await t.test('migration preserves owner-only defaults and existing settings', async () => {
      assert.equal((await rows('SELECT * FROM sms_fishpens')).length, 2);
      await db.query("UPDATE sms_fishpens SET caretaker_phone = '+639444444444', caretaker_enabled = 1 WHERE device_id = 1");
      await migrateFishpenSms(db); await migrateFishpenSms(db);
      const pens = await rows('SELECT * FROM sms_fishpens ORDER BY id');
      assert.equal(pens.length, 2); assert.equal(pens[0].caretaker_enabled, 1); assert.equal(pens[1].owner_enabled, 1);
    });
    await t.test('owner-only and missing caretaker: one accepted attempt', async () => {
      const pen = await newPen(); await queue(pen); await drainWaterSms(db, sender, true);
      assert.equal(calls.length, 1); assert.equal(calls[0].phone, '+639111111111'); assert.match(calls[0].message, /Reading: 34 C/);
      assert.equal((await rows(`SELECT status FROM sms_water_attempts WHERE fishpen_id=${pen}`))[0].status, 'accepted');
    });
    await t.test('both recipients get the same warning with separate status', async () => {
      const pen = await newPen('+639444444444'); const start = calls.length;
      await queue(pen); await drainWaterSms(db, sender, true);
      assert.equal(calls.length - start, 2); assert.equal(calls[start].message, calls[start + 1].message);
      assert.deepEqual((await rows(`SELECT recipient_type FROM sms_water_attempts WHERE fishpen_id=${pen} ORDER BY id`)).map(r => r.recipient_type), ['owner', 'caretaker']);
    });
    await t.test('disabled owner, invalid caretaker, recipient disabled while queued', async () => {
      const pen = await newPen('+639444444444'); await db.query(`UPDATE sms_fishpens SET owner_enabled=0 WHERE id=${pen}`);
      const start = calls.length; await queue(pen); await drainWaterSms(db, sender, true); assert.equal(calls.length - start, 1); assert.equal(calls.at(-1)!.phone, '+639444444444');
      const invalid = await newPen('invalid'); await queue(invalid); await db.query(`UPDATE sms_fishpens SET owner_enabled=0 WHERE id=${invalid}`);
      await drainWaterSms(db, sender, true); assert.equal(calls.length - start, 1);
      assert.equal((await rows(`SELECT status FROM sms_water_attempts WHERE fishpen_id=${invalid}`))[0].status, 'cancelled');
    });
    await t.test('concurrent duplicates are sent only once; repeated readings stay suppressed', async () => {
      const pen = await newPen(); const start = calls.length;
      await Promise.all([queue(pen), queue(pen)]);
      await Promise.all([drainWaterSms(db, sender, true), drainWaterSms(db, sender, true)]);
      await db.query(`UPDATE sms_water_attempts SET created_at=DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR) WHERE fishpen_id=${pen}`);
      await queue(pen, 35, 1, 100); await drainWaterSms(db, sender, true);
      assert.equal(calls.length - start, 1);
    });
    await t.test('severity escalation is allowed; recovery and a new episode work after cooldown', async () => {
      const pen = await newPen(); const start = calls.length;
      const ph = (value: number, offset: number) => queueWaterSms(db, { owner: 1, fishpenId: pen, sourceId: 2, sourceKind: 'test', measurements: sensorSmsMeasurements({ ph: value }, { sampledAt: new Date(Date.now() + offset).toISOString(), verifiedParameters: ['ph'] }) });
      await ph(8.8, 0); await drainWaterSms(db, sender, true);
      await ph(9.5, 100); await drainWaterSms(db, sender, true); assert.equal(calls.length - start, 2);
      await ph(7, 200);
      await db.query(`UPDATE sms_water_attempts SET created_at=DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR) WHERE fishpen_id=${pen}`);
      await ph(8.8, 300); await drainWaterSms(db, sender, true); assert.equal(calls.length - start, 3);
    });
    await t.test('provider failure and ambiguous timeout never retry automatically', async () => {
      const pen = await newPen('+639444444444'); let attempts = 0;
      await queue(pen);
      await drainWaterSms(db, async () => { attempts++; return { configured: true, ok: false, uncertain: attempts === 2, message: 'Mock provider failure' }; }, true);
      await queue(pen, 35, 1, 100); await drainWaterSms(db, sender, true);
      assert.equal(attempts, 2); assert.deepEqual((await rows(`SELECT status FROM sms_water_attempts WHERE fishpen_id=${pen} ORDER BY id`)).map(r => r.status), ['failed', 'unknown']);
    });
    await t.test('stale, default, missing and uncalibrated measurements cannot queue', async () => {
      const pen = await newPen();
      for (const body of [{}, { sampledAt: new Date(Date.now() - 60000).toISOString(), verifiedParameters: ['temperature'] }, { sampledAt: new Date().toISOString(), verifiedParameters: [] }]) {
        await queueWaterSms(db, { owner: 1, fishpenId: pen, sourceId: 3, sourceKind: 'test', measurements: sensorSmsMeasurements({ temperature: 34 }, body) });
      }
      assert.equal((await rows(`SELECT * FROM sms_water_attempts WHERE fishpen_id=${pen}`)).length, 0);
      await queue(pen); await db.query(`UPDATE sms_water_attempts SET measured_at=DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE fishpen_id=${pen}`);
      const start = calls.length; await drainWaterSms(db, sender, true); assert.equal(calls.length, start);
    });
    await t.test('HTTP settings enforce authentication, ownership, role and phone validation', async () => {
      const pens = (await request('/fishpen-sms', 1)).data.fishpens;
      const foreign = (await request('/fishpen-sms', 2)).data.fishpens[0].id;
      const body = { name: 'Renamed Cuyab A', deviceId: 1, ownerEnabled: true, caretakerPhone: '09987654321', caretakerEnabled: true };
      assert.equal((await request('/fishpen-sms', 0)).status, 401);
      assert.equal((await request('/fishpen-sms', 3)).status, 403);
      assert.equal((await request(`/fishpen-sms/${foreign}`, 1, 'PUT', { ...body, deviceId: null })).status, 404);
      assert.equal((await request(`/fishpen-sms/${pens[0].id}`, 1, 'PUT', { ...body, deviceId: 2 })).status, 403);
      assert.equal((await request(`/fishpen-sms/${pens[0].id}`, 1, 'PUT', { ...body, caretakerPhone: '123' })).status, 400);
      assert.equal((await request(`/fishpen-sms/${pens[0].id}`, 1, 'PUT', body)).status, 200);
      assert.equal((await request('/fishpen-sms', 1)).data.fishpens[0].caretaker_phone, '+639987654321');
      assert.equal((await request('/admin/water-sms', 1)).status, 403);
      assert.equal((await request('/admin/water-sms', 3)).status, 200);
    });
    await t.test('multiple fishpens and device reassignment do not leak recipients', async () => {
      const a = await newPen('+639444444444'), b = await newPen('+639555555555', 2); const start = calls.length;
      await queue(a); await queue(b, 34, 2); await queue(b, 34, 1); await drainWaterSms(db, sender, true);
      assert.deepEqual(calls.slice(start).map(c => c.phone).sort(), ['+639111111111', '+639222222222', '+639444444444', '+639555555555']);
      const input = { owner: 1, deviceId: 1, sourceId: 5, sourceKind: 'test', measurements: sensorSmsMeasurements({ temperature: 34 }, { sampledAt: new Date().toISOString(), verifiedParameters: ['temperature'] }) };
      await queueWaterSms(db, input); await db.query('UPDATE sensor_devices SET owner_user_id=2 WHERE id=1');
      const before = calls.length; await drainWaterSms(db, sender, true); assert.equal(calls.length, before);
      await queueWaterSms(db, { ...input, owner: 2 }); await drainWaterSms(db, sender, true);
      assert.equal(calls.length, before + 1); assert.equal(calls.at(-1)!.phone, '+639222222222');
    });
    console.log(`Isolated SMS test database retained: ${database}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await db.end(); await root.end();
  }
});
