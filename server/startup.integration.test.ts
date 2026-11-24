import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import mysql, { type RowDataPacket } from 'mysql2/promise';

// Exercise the real entry point without waiting an hour or contacting the SMS provider.
const hooks = `data:text/javascript,${encodeURIComponent(`
  const interval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms, ...args) => {
    if (ms === 3600000) process.on('message', msg => { if (msg === 'hourly-tick') fn(); });
    return interval(fn, ms, ...args);
  };
  globalThis.fetch = async input => {
    if (new URL(input).hostname !== 'sms.iprogtech.com') throw new Error('Unexpected fetch in startup fixture');
    console.log('Fixture SMS attempt');
    return Response.json({ status: 200, message_id: 'fixture-id' });
  };
`)}`;

test('real API startup validates read-only and preserves the reminder schedule and deduplication',
  { skip: process.env.RUN_STARTUP_DB_TESTS !== '1', timeout: 45_000 }, async t => {
    const config = { host: '127.0.0.1', port: 3307, user: 'root', password: '' };
    const root = await mysql.createConnection(config);
    t.after(async () => root.end());
    const [[paths]] = await root.query<RowDataPacket[]>('SELECT @@datadir AS datadir');
    assert.match(String(paths.datadir).replaceAll('\\', '/'), /\/pondsense-admin-report-test-[^/]+\/?$/i);
    const id = Date.now();
    const database = `pondsense_startup_test_${id}`;
    const reader = `startup_read_${id}`;
    const writer = `startup_run_${id}`;
    await root.query(`CREATE DATABASE \`${database}\``);
    await root.query(`USE \`${database}\``);
    await root.query(`CREATE USER '${reader}'@'localhost'`);
    await root.query(`CREATE USER '${writer}'@'localhost'`);
    await root.query(`GRANT SELECT ON \`${database}\`.* TO '${reader}'@'localhost'`);
    await root.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${database}\`.* TO '${writer}'@'localhost'`);
    const db = await mysql.createConnection({ ...config, database, multipleStatements: true });
    t.after(async () => db.end());
    const schema = (await readFile('server/schema.sql', 'utf8')).replace(/CREATE DATABASE IF NOT EXISTS pondsense;\s*USE pondsense;/, '');
    await db.query(schema);
    const env = {
      ...process.env, MYSQL_HOST: config.host, MYSQL_PORT: String(config.port), MYSQL_USER: config.user, MYSQL_PASSWORD: '',
      MYSQL_DATABASE: database, MYSQL_SSL: 'false', NODE_ENV: 'test', SESSION_SECRET: randomBytes(32).toString('hex'),
      ADMIN_USERNAME: 'fixture-admin', ADMIN_PHONE: '+639100000000', ADMIN_PASSWORD: 'fixture-admin-password',
      ADMIN_PIN: 'fixture-pin', ADMIN_ACCOUNT_ID: '', IPROG_SMS_API_TOKEN: ''
    };
    const setup = spawn(process.execPath, ['--import', 'tsx', 'server/prepare-local-database.ts'], { env, windowsHide: true, stdio: 'inherit' });
    assert.deepEqual(await once(setup, 'exit'), [0, null]);
    function start(user: string, token = '', port = '5014') {
      const child = spawn(process.execPath, ['--import', hooks, '--import', 'tsx', 'server/index.ts'], {
        env: { ...env, NODE_ENV: 'production', MYSQL_USER: user, IPROG_SMS_API_TOKEN: token, PORT: port },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      });
      let logs = '';
      child.stdout!.on('data', part => { logs += part; });
      child.stderr!.on('data', part => { logs += part; });
      const exit = once(child, 'exit');
      async function stop() {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exit;
      }
      t.after(stop);
      return { child, exit, stop, logs: () => logs };
    }
    async function until(predicate: () => Promise<boolean> | boolean, error: () => string) {
      for (let i = 0; i < 100; i++) {
        if (await predicate()) return;
        await delay(75);
      }
      assert.fail(error());
    }
    async function health(port: string) {
      try {
        return (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).database === 'mysql-connected';
      } catch { return false; }
    }

    const compatible = start(reader);
    await until(() => health('5014'), compatible.logs);
    await compatible.stop();
    assert.doesNotMatch(compatible.logs(), /Fixture SMS attempt|startup blocked/);

    await db.query('ALTER TABLE harvest_samples DROP COLUMN notes');
    const missingColumn = start(writer, 'fixture-provider-token');
    assert.deepEqual(await missingColumn.exit, [1, null]);
    assert.match(missingColumn.logs(), /missing column harvest_samples\.notes/);
    assert.doesNotMatch(missingColumn.logs(), /API running|Fixture SMS attempt/);
    await db.query('ALTER TABLE harvest_samples ADD COLUMN notes VARCHAR(1000) NULL');

    await db.query('ALTER TABLE planning_sms_log DROP INDEX daily_planning_sms');
    const missingKey = start(writer, 'fixture-provider-token');
    assert.deepEqual(await missingKey.exit, [1, null]);
    assert.match(missingKey.logs(), /missing unique key planning_sms_log\(owner_user_id, send_day\)/);
    assert.doesNotMatch(missingKey.logs(), /API running|Fixture SMS attempt/);
    await db.query('ALTER TABLE planning_sms_log ADD UNIQUE KEY daily_planning_sms (owner_user_id, send_day)');

    const reminders = start(writer, 'fixture-provider-token');
    await until(() => health('5014'), reminders.logs);
    assert.doesNotMatch(reminders.logs(), /Fixture SMS attempt/);
    await db.query(`INSERT INTO harvest_batches
      (owner_user_id, species, stocking_date, stocked_count, target_harvest_date, reminder_sms)
      SELECT id, 'Fixture fish', UTC_DATE(), 10, DATE(UTC_TIMESTAMP() + INTERVAL 8 HOUR), TRUE
      FROM users WHERE role = 'admin'`);
    reminders.child.send('hourly-tick');
    const checkStatus = async () => {
      const [rows] = await db.query<RowDataPacket[]>('SELECT sms_status FROM harvest_reminder_log');
      return rows.length === 1 && rows[0].sms_status === 'sent';
    };
    await until(checkStatus, reminders.logs);
    assert.equal(reminders.logs().match(/Fixture SMS attempt/g)?.length, 1);
    await reminders.stop();

    const restarted = start(writer, 'fixture-provider-token');
    await until(() => health('5014'), restarted.logs);
    restarted.child.send('hourly-tick');
    await delay(400);
    assert.doesNotMatch(restarted.logs(), /Fixture SMS attempt|Harvest reminder check failed/);
    assert.equal(await checkStatus(), true);
    const [[sms]] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS attempts FROM planning_sms_log');
    assert.equal(Number(sms.attempts), 1);
    await restarted.stop();

    // A real due reminder may run at startup. Two instances must still submit it only once.
    await db.query(`INSERT INTO users (full_name, phone, password_hash, role)
      VALUES ('Opted-in fixture farmer', '+639100000001', 'fixture-hash', 'farmer');
      INSERT INTO harvest_batches (owner_user_id, species, stocking_date, stocked_count, target_harvest_date, reminder_sms)
      VALUES (LAST_INSERT_ID(), 'Fixture fish', UTC_DATE(), 10, DATE(UTC_TIMESTAMP() + INTERVAL 8 HOUR), TRUE)`);
    const first = start(writer, 'fixture-provider-token');
    const second = start(writer, 'fixture-provider-token', '5015');
    await until(async () => await health('5014') && await health('5015'), () => first.logs() + second.logs());
    await until(async () => {
      const [[row]] = await db.query<RowDataPacket[]>("SELECT COUNT(*) AS sent FROM harvest_reminder_log WHERE sms_status = 'sent'");
      return Number(row.sent) === 2;
    }, () => first.logs() + second.logs());
    assert.equal((first.logs() + second.logs()).match(/Fixture SMS attempt/g)?.length, 1);
    assert.doesNotMatch(first.logs() + second.logs(), /Harvest reminder check failed/);
    await first.stop();
    await second.stop();
  });
