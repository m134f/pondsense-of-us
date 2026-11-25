import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { drainIncidentSms } from './services/IncidentSms';
import { migrateSharedHardware } from './migrations/sharedHardware';
import { verifyStartupSchema } from './startupSchema';

test('shared physical ESP32 lifecycle, sensor/SMS isolation and owner tools without hardware',
  { skip: process.env.RUN_HARDWARE_DB_TESTS !== '1', timeout: 90_000 }, async t => {
    const config = { host: '127.0.0.1', port: 3307, user: 'root', password: '' };
    const root = await mysql.createConnection(config);
    t.after(() => root.end());
    const [[info]] = await root.query<RowDataPacket[]>('SELECT @@datadir AS dir');
    assert.match(String(info.dir).replaceAll('\\', '/'), /\/pondsense-admin-report-test-[^/]+\/?$/i);
    const database = `pondsense_hardware_test_${Date.now()}`;
    await root.query(`CREATE DATABASE ${database}`);
    const db = mysql.createPool({ ...config, database, multipleStatements: true });
    t.after(() => db.end());
    const schema = (await readFile('server/schema.sql', 'utf8')).replace(/CREATE DATABASE IF NOT EXISTS pondsense;\s*USE pondsense;/, '');
    await db.query(schema);
    const origin = 'http://localhost:5173', port = '5018';
    const env = {
      ...process.env, NODE_ENV: 'test', MYSQL_HOST: config.host, MYSQL_PORT: String(config.port), MYSQL_USER: config.user,
      MYSQL_PASSWORD: '', MYSQL_DATABASE: database, MYSQL_SSL: 'false', PORT: port, FRONTEND_URL: origin,
      ADMIN_USERNAME: 'hardware-admin', ADMIN_PHONE: '+639100000001', ADMIN_PASSWORD: 'fixture-hardware-password',
      ADMIN_PIN: 'fixture-pin', ADMIN_ACCOUNT_ID: '', SESSION_SECRET: randomBytes(32).toString('hex'),
      IPROG_SMS_API_TOKEN: '', PONDSENSE_LEGACY_TEST: '', PONDSENSE_ENABLE_SHARED_UPLOADS: 'true', PONDSENSE_PAUSE_HARDWARE_UPLOADS: '',
      WATER_SMS_THRESHOLDS_REVIEWED: 'true', WATER_SMS_RULES_REFERENCE: 'Isolated fixture, not a scientific reference'
    };
    const prep = spawn(process.execPath, ['--import', 'tsx', 'server/prepare-local-database.ts', '--pre-shared-hardware'], { env, windowsHide: true, stdio: 'inherit' });
    assert.deepEqual(await once(prep, 'exit'), [0, null]);
    const [[before]] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM users');
    await assert.rejects(verifyStartupSchema(db), /missing table registered_hardware/);
    await db.query('ALTER TABLE users DROP COLUMN password_changed_at');
    await assert.rejects(migrateSharedHardware(db), /migration blocked.*missing column users.password_changed_at.*No schema changes were attempted/);
    const [uncreated] = await db.query<RowDataPacket[]>("SHOW TABLES LIKE 'registered_hardware'");
    assert.equal(uncreated.length, 0);
    await db.query('ALTER TABLE users ADD COLUMN password_changed_at DATETIME NULL');
    await migrateSharedHardware(db);
    await migrateSharedHardware(db);
    await verifyStartupSchema(db);
    const [[after]] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM users');
    assert.equal(after.n, before.n);
    const app = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = once(app, 'exit');
    t.after(async () => { if (app.exitCode === null && app.signalCode === null) app.kill(); await exit; });
    let logs = '';
    app.stdout?.on('data', data => { logs += data; });
    app.stderr?.on('data', data => { logs += data; });
    const request = async (path: string, options: { body?: object; cookie?: string; key?: string; method?: string; origin?: string; port?: string } = {}) => {
      const response = await fetch(`http://127.0.0.1:${options.port ?? port}/api${path}`, {
        method: options.method ?? (options.body ? 'POST' : 'GET'),
        headers: { Origin: options.origin ?? origin, 'Content-Type': 'application/json', ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.key ? { 'X-API-Key': options.key } : {}) },
        body: options.body && JSON.stringify(options.body)
      });
      const content = await response.text();
      let data;
      try { data = JSON.parse(content); }
      catch { assert.fail(`${path} returned ${response.status} without JSON: ${logs}`); }
      return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0], cache: response.headers.get('cache-control') };
    };
    async function until(fn: () => Promise<boolean>, diagnostic = () => logs) {
      for (let i = 0; i < 130; i++) {
        if (await fn().catch(() => false)) return;
        await delay(90);
      }
      assert.fail(diagnostic());
    }
    const rows = async (sql: string, args: string[] = []) => (await db.query<RowDataPacket[]>(sql, args))[0];
    await until(async () => (await request('/health')).data.database === 'mysql-connected');
    const auth = await request('/admin/login', { body: { identifier: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, pin: env.ADMIN_PIN } });
    assert.equal(auth.status, 200);
    const admin = auth.cookie!;
    const adminPost = (path: string, body: object) => request(`/admin${path}`, { cookie: admin, body });
    const adminGet = (path: string) => request(`/admin${path}`, { cookie: admin });
    async function farmer(name: string, phone: string, fishpenName: string) {
      const made = await adminPost('/owners', { fullName: name, phone, fishpenName });
      assert.equal(made.status, 200);
      assert.equal(made.data.deviceKey, undefined);
      assert.equal(made.data.deviceId, undefined);
      const login = await request('/login', { body: { phone, password: made.data.temporaryPassword } });
      assert.equal(login.status, 200);
      const change = await request('/owner/password', { cookie: login.cookie, body: { currentPassword: made.data.temporaryPassword, newPassword: 'isolated-farmer-passphrase' } });
      assert.equal(change.status, 200);
      const session = await request('/session', { cookie: change.cookie });
      assert.ok(session.data.fishpenAssignment.id > 0);
      assert.equal(session.data.fishpenAssignment.hardwareId, null);
      return { id: made.data.id, cookie: change.cookie!, fishpenId: Number(session.data.fishpenAssignment.id), fishpenName, phone };
    }
    const a = await farmer('Farmer A', '+639111111111', 'Pen A');
    const b = await farmer('Authorized Caretaker B', '+639222222222', 'Pen B');
    await t.test('admin routes deny signed-out and farmer sessions; registration and cross-origin writes are blocked', async () => {
      const routes = [
        ['GET', '/admin/session'], ['GET', '/admin/users'], ['GET', '/admin/overview'], ['GET', '/admin/telemetry'],
        ['GET', '/admin/logs'], ['GET', '/admin/alerts'], ['GET', '/admin/water-sms'], ['GET', '/admin/audit-logs'],
        ['GET', '/admin/thresholds'], ['GET', '/admin/turbidity-alert-rule'], ['PATCH', '/admin/turbidity-alert-rule'], ['GET', '/admin/security/devices'], ['GET', '/admin/hardware'],
        ['GET', '/admin/hardware/fishpens'], ['GET', `/admin/owners/${b.id}/sms-recipients`],
        ['POST', '/admin/owners'], ['POST', `/admin/owners/${b.id}/reset-password`],
        ['PATCH', `/admin/users/${b.id}/status`], ['PUT', `/admin/owners/${b.id}/sms-recipients`],
        ['POST', '/admin/hardware'], ['POST', '/admin/hardware/1/assign'], ['POST', '/admin/hardware/1/unassign'],
        ['POST', '/admin/hardware/1/key'], ['PATCH', '/admin/thresholds/1'], ['DELETE', '/admin/factory-reset']
      ];
      for (const [method, path] of routes) {
        const body = method === 'GET' ? undefined : {};
        assert.equal((await request(path, { method, body })).status, 401, `signed-out ${method} ${path}`);
        assert.equal((await request(path, { method, body, cookie: a.cookie })).status, 403, `farmer ${method} ${path}`);
      }
      assert.equal((await request('/register', { body: {} })).status, 410);
      for (const path of [`/admin/owners/${b.id}/reset-password`, `/admin/hardware/1/assign`]) {
        assert.equal((await request(path, { body: {}, cookie: admin, origin: 'https://untrusted.example' })).status, 403);
      }
      for (const path of ['/readings', '/harvests', '/sensors/latest', '/fishpen-sms', '/turbidity-alert-rule']) {
        assert.equal((await request(path)).status, 401, path);
      }
    });
    await t.test('turbidity proposal stays separate, persisted, owner-readable and pending', async () => {
      const endpoint = '/admin/turbidity-alert-rule';
      const save = (body: object, extra: { origin?: string } = {}) => request(endpoint, { method: 'PATCH', body, cookie: admin, ...extra });
      assert.deepEqual((await adminGet('/turbidity-alert-rule')).data.rule, { warningFrom: 25, criticalAbove: 100, approval: 'pending' });
      const speciesBefore = (await adminGet('/thresholds')).data;
      assert.equal((await save({ warningFrom: 30, criticalAbove: 90 }, { origin: 'https://untrusted.example' })).status, 403);
      assert.equal((await save({ warningFrom: 30, criticalAbove: 90, approval: 'approved' })).status, 400);
      assert.equal((await save({ warningFrom: 91, criticalAbove: 90 })).status, 400);
      const saved = await save({ warningFrom: 30, criticalAbove: 90 });
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.data.rule, { warningFrom: 30, criticalAbove: 90, approval: 'pending' });
      assert.deepEqual((await request('/turbidity-alert-rule', { cookie: a.cookie })).data.rule, saved.data.rule);
      assert.deepEqual((await adminGet('/thresholds')).data, speciesBefore);
      assert.equal((await rows("SELECT id FROM admin_audit_logs WHERE action = 'turbidity_proposal_update'")).length, 1);
    });
    assert.equal((await rows('SELECT id FROM sensor_devices')).length, 0);
    assert.equal((await adminGet('/hardware')).data.hardware.length, 0);
    const bOwnerAlert = '+639133333333';
    const bCaretakerAlert = b.phone;
    const bRecipientsPath = `/owners/${b.id}/sms-recipients`;
    const bSms = { fishpenId: b.fishpenId, ownerAlertPhone: '0913 333 3333', caretakerPhone: '0922 222 2222', caretakerEnabled: true, consentConfirmed: true };
    const putRecipients = (body: object) => request(`/admin${bRecipientsPath}`, { cookie: admin, method: 'PUT', body });
    assert.equal((await adminGet(bRecipientsPath)).data.fishpen.ownerPhone, b.phone);
    assert.equal((await putRecipients({ ...bSms, consentConfirmed: false })).status, 400);
    assert.equal((await request(`/admin${bRecipientsPath}`, { cookie: b.cookie, method: 'PUT', body: bSms })).status, 403);
    assert.equal((await request(`/fishpen-sms/${b.fishpenId}`, { cookie: b.cookie, method: 'PUT', body: bSms })).status, 403);
    const contacts = await putRecipients(bSms);
    assert.equal(contacts.status, 200, JSON.stringify(contacts.data));
    assert.deepEqual([contacts.data.fishpen.loginPhone, contacts.data.fishpen.ownerPhone, contacts.data.fishpen.caretakerPhone], [b.phone, bOwnerAlert, bCaretakerAlert]);
    await migrateSharedHardware(db);
    assert.deepEqual((await adminGet(bRecipientsPath)).data.fishpen, contacts.data.fishpen);
    const smsView = await request('/fishpen-sms', { cookie: b.cookie });
    assert.deepEqual([smsView.data.ownerPhone, smsView.data.fishpens[0].caretaker_phone], ['**** 3333', '**** 2222']);
    assert.equal((await request('/session', { cookie: b.cookie })).data.user.phone, b.phone);
    assert.equal((await request('/fishpen-sms', { cookie: a.cookie })).data.ownerPhone, '**** 1111');
    assert.equal((await rows('SELECT id FROM sms_critical_notifications')).length, 0);

    const chipId = '001122AABBCC';
    const board = await adminPost('/hardware', { name: 'Shared fixture monitor', chipId });
    assert.equal(board.status, 201);
    assert.equal(board.cache, 'no-store');
    const { hardwareId, deviceKey } = board.data;
    assert.match(deviceKey, /^ps_[\w-]{32}$/);
    const hw = `/hardware/${hardwareId}`;
    const [[anchor]] = await db.query<RowDataPacket[]>('SELECT id, api_key_hash, owner_user_id FROM sensor_devices LIMIT 1');
    assert.equal(anchor.owner_user_id, null);
    assert.ok(await bcrypt.compare(deviceKey, anchor.api_key_hash));
    assert.equal((await adminPost('/hardware', { name: 'Duplicate board', chipId })).status, 409);
    assert.equal((await rows('SELECT id FROM sensor_devices')).length, 1);
    const inventory = await adminGet('/hardware');
    assert.equal(inventory.data.hardware[0].status, 'Unassigned');
    assert.ok(!JSON.stringify(inventory.data).includes(deviceKey));
    assert.equal((await request('/admin/hardware', { cookie: a.cookie, body: { name: 'Unauthorized', chipId: 'AA' } })).status, 403);

    const sync = (other = chipId) => request('/v2/hardware/assignment', { key: deviceKey, body: { chipId: other } });
    assert.equal((await request('/admin/session', { key: deviceKey })).status, 401);
    assert.equal((await request('/v2/hardware/assignment', { body: { chipId }, cookie: a.cookie })).status, 401);
    const assign = (who: typeof a, fishpenId = who.fishpenId) => adminPost(hw + '/assign', { ownerId: who.id, fishpenId, confirmedMoved: true });
    const unassign = (id: string) => adminPost(hw + '/unassign', { assignmentId: id });
    let serial = 0;
    const payload = (assignmentId: string, sampledAt = new Date().toISOString(), ph = 7) => ({
      chipId, assignmentId, sampledAt, clientReadingId: `fixture-${++serial}`, waterContactConfirmed: true, rawValue: 1100,
      voltage: 2.4, ph, temperatureC: 28, turbidityNtu: 50, dissolvedOxygen: 6, verifiedParameters: ['ph', 'temperature', 'dissolvedOxygen']
    });
    const upload = (body: object) => request('/v2/hardware/readings', { key: deviceKey, body });
    assert.equal((await sync()).status, 409);
    assert.equal((await sync('FFFF')).status, 401);
    assert.equal((await request('/v2/hardware/assignment', { key: 'invalid', body: { chipId } })).status, 401);
    assert.equal((await request('/v1/sensors/measurements', { key: deviceKey, body: {} })).status, 410);
    assert.equal((await assign(a, b.fishpenId)).status, 409);

    const first = await assign(a);
    assert.equal(first.status, 200);
    const firstId = first.data.assignmentId;
    assert.equal((await assign(b)).status, 409);
    assert.equal((await sync()).data.assignmentId, firstId);
    assert.equal((await adminGet('/hardware')).data.hardware[0].status, 'Never Connected');
    const firstSample = payload(firstId, new Date().toISOString(), 4);
    const accepted = await upload(firstSample);
    assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
    assert.equal((await upload(firstSample)).data.duplicate, true);
    const lastA = await request('/sensors/latest', { cookie: a.cookie });
    assert.equal(lastA.data.telemetry.id, accepted.data.telemetryId);
    assert.equal(lastA.data.telemetry.dissolvedOxygen, 6);
    assert.equal((await request('/sensors/latest', { cookie: b.cookie })).data.telemetry, null);
    assert.equal((await adminGet('/hardware')).data.hardware[0].status, 'Online');
    assert.equal((await upload(payload(firstId, new Date(Date.now() - 90_000).toISOString()))).status, 409);
    await delay(50);
    const secondA = payload(firstId, new Date().toISOString(), 4);
    assert.equal((await upload(secondA)).status, 201);
    await until(async () => (await rows("SELECT id FROM sms_critical_notifications WHERE assignment_id = ? AND status = 'pending'", [firstId])).length === 1);
    const bufferedA = payload(firstId);
    const [raceUpload, raceEnd] = await Promise.all([upload(payload(firstId)), unassign(firstId)]);
    assert.ok([201, 409].includes(raceUpload.status));
    assert.equal(raceEnd.status, 200);
    assert.equal((await sync()).status, 409);
    assert.equal((await upload(bufferedA)).status, 409);
    const competing = await Promise.all([assign(b), assign(a)]);
    assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
    if (competing[1].status === 200) { assert.equal((await unassign(competing[1].data.assignmentId)).status, 200); competing[0] = await assign(b); }
    assert.equal(competing[0].status, 200);
    const secondId = competing[0].data.assignmentId;
    assert.notEqual(secondId, firstId);
    assert.equal((await sync()).data.assignmentId, secondId);
    assert.equal((await unassign(firstId)).status, 409);
    assert.equal((await upload(bufferedA)).status, 409);
    assert.equal((await upload({ ...bufferedA, assignmentId: secondId })).status, 409);
    assert.equal((await upload({ ...firstSample, assignmentId: secondId, sampledAt: new Date().toISOString() })).status, 409);
    assert.equal((await request('/sensors/latest', { cookie: a.cookie })).data.hardwareAssigned, false);
    assert.equal((await request('/sensors/latest', { cookie: b.cookie })).data.telemetry, null);
    const bSaved = await upload(payload(secondId, new Date().toISOString(), 4));
    assert.equal(bSaved.status, 201);
    await delay(40);
    assert.equal((await upload(payload(secondId, new Date().toISOString(), 4))).status, 201);
    await until(async () => (await rows("SELECT id FROM sms_critical_notifications WHERE assignment_id = ? AND status = 'pending'", [secondId])).length === 2);
    const bQueued = await rows('SELECT owner_user_id, fishpen_id, recipient_type, recipient_phone FROM sms_critical_notifications WHERE assignment_id = ? ORDER BY recipient_type', [secondId]);
    assert.deepEqual(bQueued.map(row => [row.owner_user_id, row.fishpen_id, row.recipient_type, row.recipient_phone]),
      [[b.id, b.fishpenId, 'caretaker', bCaretakerAlert], [b.id, b.fishpenId, 'owner', bOwnerAlert]]);
    const duplicate = await putRecipients({ ...bSms, caretakerPhone: '639133333333', consentConfirmed: false });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.data.fishpen.caretakerEnabled, false);
    assert.equal((await request('/fishpen-sms', { cookie: b.cookie })).data.fishpens[0].caretaker_enabled, false);
    const readings = await rows('SELECT id, hardware_id, device_id, owner_user_id, fishpen_id, assignment_id FROM sensor_telemetry ORDER BY id');
    assert.ok(readings.every(row => row.hardware_id === hardwareId && row.device_id === anchor.id &&
      (row.assignment_id === firstId ? row.owner_user_id === a.id && row.fishpen_id === a.fishpenId : row.assignment_id === secondId && row.owner_user_id === b.id && row.fishpen_id === b.fishpenId)));
    assert.equal((await rows('SELECT api_key_hash FROM sensor_devices'))[0].api_key_hash, anchor.api_key_hash);
    const aHistory = await request('/readings', { cookie: a.cookie });
    assert.ok(aHistory.data.sessions.some((entry: { id: string; fishpenName: string }) => entry.id === `sensor-${accepted.data.telemetryId}` && entry.fishpenName === a.fishpenName));
    assert.ok(!aHistory.data.sessions.some((entry: { id: string }) => entry.id === `sensor-${bSaved.data.telemetryId}`));
    assert.ok((await request('/sensors/trend', { cookie: a.cookie })).data.readings.every((entry: { assignmentId: string }) => entry.assignmentId === firstId));
    assert.ok((await request('/sensors/trend', { cookie: b.cookie })).data.readings.every((entry: { assignmentId: string }) => entry.assignmentId === secondId));

    process.env.WATER_SMS_THRESHOLDS_REVIEWED = 'true';
    process.env.WATER_SMS_RULES_REFERENCE = env.WATER_SMS_RULES_REFERENCE;
    const submissions: string[] = [];
    await drainIncidentSms(db, async phone => { submissions.push(phone); return { configured: true, ok: true, message: 'Mock provider acceptance' }; }, true, true);
    assert.deepEqual(submissions, [bOwnerAlert]);
    assert.equal((await rows('SELECT status FROM sms_critical_notifications WHERE assignment_id = ?', [firstId]))[0].status, 'cancelled');
    assert.deepEqual((await rows('SELECT status FROM sms_critical_notifications WHERE assignment_id = ? ORDER BY recipient_type', [secondId])).map(row => row.status), ['cancelled', 'accepted']);
    assert.equal((await putRecipients({ ...bSms, ownerAlertPhone: null, caretakerPhone: null, caretakerEnabled: false, consentConfirmed: false })).data.fishpen.ownerPhone, b.phone);
    await until(async () => (await rows('SELECT id FROM recommendation_history WHERE owner_user_id = ? AND fishpen_name = ?', [String(b.id), b.fishpenName])).length > 0);
    assert.equal((await request('/readings', { cookie: a.cookie, body: { partialManual: true, ph: 7.5 } })).status, 200);
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    const harvest = await request('/harvests', { cookie: a.cookie, body: { species: 'Tilapia', stockingDate: day, stockedCount: 100, targetHarvestDate: day, reminderSms: false } });
    assert.equal(harvest.status, 201, JSON.stringify(harvest.data));
    assert.ok((await request('/harvests', { cookie: a.cookie })).data.harvests.length > 0);
    assert.equal((await request('/harvests', { cookie: b.cookie })).data.harvests.length, 0);
    const batchId = harvest.data.id;
    assert.equal((await request(`/harvests/${batchId}/review`, { cookie: b.cookie })).status, 404);
    assert.equal((await request(`/harvests/${batchId}`, { method: 'PUT', body: {}, cookie: b.cookie })).status, 404);
    assert.equal((await request('/admin/public-monitoring', { cookie: admin, method: 'PUT', body: { deviceId: anchor.id } })).status, 410);
    await db.execute('INSERT INTO public_monitoring(id, device_id) VALUES (1, ?)', [anchor.id]);
    assert.equal((await request('/public/monitoring')).status, 401);
    assert.equal((await request('/public/monitoring', { cookie: a.cookie })).status, 410);

    const legacyKey = 'isolated-original-device-key';
    const hash = await bcrypt.hash(legacyKey, 4);
    const [old] = await db.execute<import('mysql2').ResultSetHeader>('INSERT INTO sensor_devices(device_name,api_key_hash,owner_user_id) VALUES (?,?,?)', ['Legacy fixture', hash, a.id]);
    const legacyChip = '0000000012BF';
    await db.execute(`INSERT INTO sensor_telemetry(device_id,owner_user_id,turbidity_raw,turbidity_voltage,ph,client_reading_id,water_contact_confirmed)
      VALUES (?,?,1000,2.4,7,'12BF-00000001-00000002',TRUE)`, [old.insertId, a.id]);
    const adoption = { name: 'Adopted fixture', chipId: legacyChip, legacyDeviceId: old.insertId, verifiedPhysicalBoard: true };
    assert.equal((await adminPost('/hardware', { ...adoption, chipId: '12BE' })).status, 409);
    const adopted = await adminPost('/hardware', adoption);
    assert.equal(adopted.status, 201);
    assert.equal(adopted.data.deviceKey, undefined);
    assert.equal((await rows('SELECT api_key_hash FROM sensor_devices WHERE id = ?', [String(old.insertId)]))[0].api_key_hash, hash);
    const adoptedAssignment = await adminPost(`/hardware/${adopted.data.hardwareId}/assign`, { ownerId: a.id, fishpenId: a.fishpenId, confirmedMoved: true });
    assert.equal(adoptedAssignment.status, 200);
    assert.equal((await request('/v2/hardware/assignment', { key: legacyKey, body: { chipId: legacyChip } })).data.assignmentId, adoptedAssignment.data.assignmentId);
    const legacy = (await rows('SELECT owner_user_id,assignment_id,fishpen_id FROM sensor_telemetry WHERE device_id = ?', [String(old.insertId)]))[0];
    assert.deepEqual([legacy.owner_user_id, legacy.assignment_id, legacy.fishpen_id], [a.id, null, null]);
    const bench = { chipId: legacyChip, assignmentId: adoptedAssignment.data.assignmentId, sampledAt: new Date().toISOString(),
      clientReadingId: 'bench-three-probes', waterContactConfirmed: true, rawValue: 1100, voltage: 2.4,
      ph: 5, temperatureC: 28.4, turbidityNtu: 26.88, verifiedParameters: ['ph', 'temperature', 'turbidity'] };
    const benchUpload = await request('/v2/hardware/readings', { key: legacyKey, body: bench });
    assert.equal(benchUpload.status, 201);
    const { telemetry: measured } = (await request('/sensors/latest', { cookie: a.cookie })).data;
    assert.equal(measured.id, benchUpload.data.telemetryId);
    assert.deepEqual([measured.ph, measured.temperatureC, measured.turbidityNtu, measured.dissolvedOxygen], [bench.ph, bench.temperatureC, bench.turbidityNtu, null]);
    await until(async () => (await rows("SELECT id FROM recommendation_history WHERE owner_user_id = ? AND parameter_name = 'ph' AND source_id = ?",
      [String(a.id), String(benchUpload.data.telemetryId)])).length > 0);
    const doRows = await rows(`SELECT severity, payload FROM recommendation_history
      WHERE owner_user_id = ? AND source_kind = 'sensor' AND source_id = ? AND parameter_name = 'dissolvedOxygen'`,
      [String(a.id), String(benchUpload.data.telemetryId)]);
    assert.ok(doRows.length > 0 && doRows.every(row => {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      return row.severity === 'missing' && payload.value === null;
    }));
    const manualDO = await request('/readings', { cookie: a.cookie, body: { partialManual: true, dissolvedOxygen: 2.5 } });
    assert.equal(manualDO.status, 200);
    assert.ok((await request('/readings', { cookie: a.cookie })).data.sessions.some((entry: { inputMode: string; dissolvedOxygen: number }) =>
      entry.inputMode === 'manual' && entry.dissolvedOxygen === 2.5));
    assert.equal((await request('/sensors/latest', { cookie: a.cookie })).data.telemetry.dissolvedOxygen, null);
    assert.ok(!(await rows('SELECT details FROM admin_audit_logs')).some(row => String(row.details).includes(deviceKey)));

    await t.test('admin reset, suspension and reactivation preserve records and revoke farmer sessions', async () => {
      const recordCounts = () => rows('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM sensor_telemetry) AS telemetry, (SELECT COUNT(*) FROM water_readings) AS readings');
      const before = await recordCounts();
      const setStatus = (status: string) => request(`/admin/users/${b.id}/status`, { method: 'PATCH', body: { status }, cookie: admin });
      assert.equal((await setStatus('SUSPENDED')).status, 200);
      assert.equal((await request('/session', { cookie: b.cookie })).status, 403);
      assert.equal((await setStatus('ACTIVE')).status, 200);
      const reset = await adminPost(`/owners/${b.id}/reset-password`, {});
      assert.equal(reset.status, 200);
      const login = (password: string) => request('/login', { body: { phone: b.phone, password } });
      assert.equal((await login('isolated-farmer-passphrase')).status, 401);
      const temporary = await login(reset.data.temporaryPassword);
      assert.equal(temporary.status, 200);
      assert.equal(temporary.data.mustChangePassword, true);
      assert.equal((await request('/readings', { cookie: temporary.cookie })).status, 403);
      assert.equal((await request('/owner/password', { cookie: temporary.cookie,
        body: { currentPassword: reset.data.temporaryPassword, newPassword: 'isolated-farmer-passphrase' } })).status, 200);
      assert.deepEqual(await recordCounts(), before);
    });

    await t.test('registry rollout defaults to V2 paused and keeps legacy telemetry with its existing farmer', async t => {
      const transitionPort = '5019';
      const transition = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
        env: { ...env, PORT: transitionPort, PONDSENSE_ENABLE_SHARED_UPLOADS: '' }, windowsHide: true, stdio: 'ignore'
      });
      const closed = once(transition, 'exit');
      t.after(async () => { if (transition.exitCode === null && transition.signalCode === null) transition.kill(); await closed; });
      const call = (path: string, options: Parameters<typeof request>[1] = {}) => request(path, { ...options, port: transitionPort });
      await until(async () => (await call('/health')).data.database === 'mysql-connected');
      const v1Key = 'separate-isolated-v1-transition-key';
      const [existing] = await db.execute<import('mysql2').ResultSetHeader>('INSERT INTO sensor_devices(device_name,api_key_hash,owner_user_id) VALUES (?,?,?)', ['V1 transition fixture', await bcrypt.hash(v1Key, 4), a.id]);
      await db.execute('UPDATE sms_fishpens SET device_id=? WHERE id=?', [existing.insertId, a.fishpenId]);
      const before = await rows('SELECT id, owner_user_id, api_key_hash FROM sensor_devices WHERE owner_user_id IS NOT NULL ORDER BY id');
      const farmerCreated = await call('/admin/owners', { cookie: admin, body: { fullName: 'Transition Farmer', phone: '+639177777777', fishpenName: 'Transition Pen' } });
      assert.equal(farmerCreated.status, 200);
      assert.equal(farmerCreated.data.deviceKey, undefined);
      assert.deepEqual(await rows('SELECT id, owner_user_id, api_key_hash FROM sensor_devices WHERE owner_user_id IS NOT NULL ORDER BY id'), before);
      const newLogin = await call('/login', { body: { phone: '+639177777777', password: farmerCreated.data.temporaryPassword } });
      assert.equal(newLogin.status, 200);
      const newSession = await call('/session', { cookie: newLogin.cookie });
      assert.equal(newSession.data.fishpenAssignment.deviceId, null);
      const stagedChip = 'BB2233445566';
      const staged = await call('/admin/hardware', { cookie: admin, body: { name: 'Staged Board', chipId: stagedChip } });
      assert.equal(staged.status, 201);
      const stagedId = staged.data.hardwareId;
      const placement = await call(`/admin/hardware/${stagedId}/assign`, { cookie: admin, body: { ownerId: farmerCreated.data.id, fishpenId: newSession.data.fishpenAssignment.id, confirmedMoved: true } });
      assert.equal(placement.status, 200);
      const view = await call('/admin/hardware', { cookie: admin });
      assert.equal(view.data.uploadsEnabled, false);
      assert.equal(view.data.hardware.find((row: {id: number}) => row.id === stagedId).status, 'Paused');
      for (const path of ['/v2/hardware/assignment', '/v2/hardware/readings']) {
        assert.equal((await call(path, { key: staged.data.deviceKey, body: { chipId: stagedChip } })).status, 503);
      }
      assert.equal((await call('/admin/hardware', { cookie: admin, body: { name: 'Legacy adoption', chipId: '1234', legacyDeviceId: existing.insertId, verifiedPhysicalBoard: true } })).status, 409);
      const body = { rawValue: 1100, voltage: 2.4, ph: 7.2, temperatureC: 28, clientReadingId: 'transition-legacy', waterContactConfirmed: true };
      const initial = await call('/v1/sensors/measurements', { key: staged.data.deviceKey, body });
      assert.equal(initial.status, 409);
      const valid = await call('/v1/sensors/measurements', { key: v1Key, body });
      assert.equal(valid.status, 201);
      const [[received]] = await db.execute<RowDataPacket[]>('SELECT device_id, owner_user_id, assignment_id FROM sensor_telemetry WHERE id = ?', [valid.data.telemetryId]);
      assert.deepEqual([received.device_id, received.owner_user_id, received.assignment_id], [existing.insertId, a.id, null]);
      assert.equal((await call('/sensors/latest', { cookie: a.cookie })).data.telemetry.id, valid.data.telemetryId);
      const currentB = await call('/login', { body: { phone: b.phone, password: 'isolated-farmer-passphrase' } });
      assert.equal(currentB.status, 200);
      const otherView = await call('/sensors/latest', { cookie: currentB.cookie });
      assert.equal(otherView.status, 200);
      assert.equal(otherView.data.telemetry, null);
      assert.equal((await call(`/admin/hardware/${stagedId}/unassign`, { cookie: admin, body: { assignmentId: placement.data.assignmentId } })).status, 200);
    });
    await t.test('existing enforced administrator device protection is unchanged', async () => {
      await db.query('UPDATE admin_security SET enforced = TRUE WHERE id = 1');
      assert.equal((await request('/admin/session', { cookie: admin })).status, 403);
      const challenge = await request('/admin/login', { body: { identifier: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, pin: env.ADMIN_PIN } });
      assert.equal(challenge.data.webauthnRequired, true);
      assert.equal(challenge.cookie, undefined);
      assert.ok(![deviceKey, legacyKey, env.ADMIN_PASSWORD, env.ADMIN_PIN].some(secret => logs.includes(secret)));
    });
  });
