import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { createAuthSession } from './auth';
import { adminReportingRouter } from './routes/adminReporting';

const port = Number(process.env.ADMIN_REPORTING_LOCAL_PORT);

test('real reporting SQL on a clean loopback MariaDB fixture', { skip: !port }, async () => {
  const db = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', timezone: 'Z', connectionLimit: 1, multipleStatements: true });
  try {
    const [[settings]] = await db.query<RowDataPacket[]>('SELECT @@datadir AS datadir');
    assert.match(String(settings.datadir).replaceAll('\\', '/'), /\/pondsense-admin-report-test-[^/]+\/?$/i);
    const fixture = `admin_reporting_fixture_${randomUUID().replaceAll('-', '')}`;
    await db.query(`SET time_zone = '+00:00'; CREATE DATABASE ${fixture}; USE ${fixture};
      CREATE TABLE users (id INT PRIMARY KEY, full_name VARCHAR(100), role VARCHAR(12), phone VARCHAR(20));
      CREATE TABLE admin_security (id INT PRIMARY KEY, admin_id INT, enforced BOOLEAN);
      CREATE TABLE sensor_devices (id INT PRIMARY KEY, device_name VARCHAR(100), owner_user_id INT, is_active BOOLEAN, last_seen_at DATETIME);
      CREATE TABLE sms_fishpens (id INT PRIMARY KEY, owner_user_id INT, name VARCHAR(100), device_id INT UNIQUE);
      CREATE TABLE owner_fishpen_assignments (owner_user_id INT PRIMARY KEY, fishpen_id INT UNIQUE);
      CREATE TABLE sensor_telemetry (id INT PRIMARY KEY, device_id INT, owner_user_id INT, sampled_at DATETIME, recorded_at DATETIME,
        ph DECIMAL(4,2), temperature_c DECIMAL(5,2), turbidity_ntu DECIMAL(8,2), water_contact_confirmed BOOLEAN);
      CREATE TABLE sms_critical_incidents (opened_at DATETIME);
      CREATE TABLE sms_critical_notifications (status VARCHAR(20), attempted_at DATETIME);
      CREATE TABLE sms_water_attempts (status VARCHAR(20), attempted_at DATETIME);
      CREATE TABLE planning_sms_log (status VARCHAR(20), created_at TIMESTAMP);
      CREATE TABLE alerts (sms_sent BOOLEAN, sent_at DATETIME);
      CREATE TABLE admin_audit_logs (id INT PRIMARY KEY, created_at DATETIME, action VARCHAR(50));
      INSERT INTO users VALUES (1,'Admin fixture','admin',NULL), (2,'Current owner','farmer','+639111111111'),
        (3,'Prior owner','farmer',NULL), (4,'Guest','farmer','+639000000000');
      INSERT INTO admin_security VALUES (1,1,FALSE);
      INSERT INTO sensor_devices VALUES (10,'Fresh monitor',2,TRUE,NOW()), (11,'Buffered monitor',2,TRUE,NOW()),
        (12,'Changed owner',2,TRUE,NOW()), (13,'Inactive monitor',3,FALSE,NOW());
      INSERT INTO sms_fishpens VALUES (20, 2, 'Test pen', 10);
      INSERT INTO owner_fishpen_assignments VALUES (2, 20);
      INSERT INTO sensor_telemetry VALUES (30,10,2,NOW()-INTERVAL 4 SECOND,NOW(),7,28,NULL,TRUE),
        (31,10,2,NOW()-INTERVAL 2 HOUR,NOW(),7,28,NULL,TRUE), (32,11,2,NOW()-INTERVAL 2 HOUR,NOW(),NULL,NULL,NULL,TRUE),
        (33,12,3,NOW()-INTERVAL 4 SECOND,NOW(),NULL,28,NULL,TRUE), (34,13,3,NOW()-INTERVAL 2 SECOND,NOW(),NULL,28,NULL,TRUE);
      INSERT INTO sms_critical_incidents VALUES (UTC_TIMESTAMP()), (UTC_TIMESTAMP()-INTERVAL 24 HOUR);
      INSERT INTO sms_critical_notifications VALUES ('accepted',UTC_TIMESTAMP()), ('pending',UTC_TIMESTAMP());
      INSERT INTO sms_water_attempts VALUES ('failed',UTC_TIMESTAMP());
      INSERT INTO planning_sms_log VALUES ('sent',UTC_TIMESTAMP());
      INSERT INTO alerts VALUES (TRUE,UTC_TIMESTAMP()-INTERVAL 24 HOUR);
      INSERT INTO admin_audit_logs VALUES (1,NOW(),'fishpen_assigned');`);

    const app = express();
    app.get('/fixture/session', (_req, res) => { createAuthSession(res, 1, 'admin'); res.sendStatus(200); });
    app.use('/api', adminReportingRouter(db));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const cookie = (await fetch(`${base}/fixture/session`)).headers.get('set-cookie')!.split(';')[0];
      const get = async (path: string) => {
        const response = await fetch(`${base}/api/admin/${path}`, { headers: { Cookie: cookie } });
        assert.equal(response.status, 200);
        return response.json();
      };
      const { counts, devices, activity } = await get('overview');
      assert.deepEqual(counts, { farmers: 2, sensorReadings: 5, criticalToday: 1, smsToday: 2 });
      assert.deepEqual(devices, { online: 1, offline: 1, never: 1, inactive: 1, assigned: 1 });
      assert.equal(activity.length, 6);
      const { devices: fleet } = await get('devices');
      assert.equal(fleet.find((row: { id: number }) => row.id === 10).fishpen_name, 'Test pen');
      assert.equal(fleet.find((row: { id: number }) => row.id === 12).current_upload_at, null);
      const { readings } = await get('telemetry');
      const historical = readings.find((row: { id: number }) => row.id === 33);
      assert.equal(historical.owner_name, 'Prior owner');
      assert.equal(historical.ph, null);
      assert.ok(!('fishpen_id' in historical));
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  } finally { await db.end(); }
});
