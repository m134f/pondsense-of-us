import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { createAuthSession } from './auth';
import { adminReportingRouter } from './routes/adminReporting';
import { assessmentIsOutdated, type FarmerWaterReport } from '../src/lib/farmerWaterQuality';

const port = Number(process.env.ADMIN_REPORTING_LOCAL_PORT);
test('water quality aggregates persisted sources, retains attribution, and is admin-only', { skip: !port }, async () => {
  const db = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', connectionLimit: 1, multipleStatements: true });
  let fixture: string | undefined;
  try {
    const [[instance]] = await db.query<RowDataPacket[]>('SELECT @@datadir AS datadir');
    assert.match(String(instance.datadir).replaceAll('\\', '/'), /\/pondsense-admin-report-test-[^/]+\/?$/i);
    fixture = `quality_fixture_${randomUUID().replaceAll('-', '')}`;
    await db.query(`CREATE DATABASE ${fixture}; USE ${fixture};
      CREATE TABLE users (id INT PRIMARY KEY, full_name VARCHAR(100), role VARCHAR(12), phone VARCHAR(20));
      CREATE TABLE admin_security (id INT PRIMARY KEY, admin_id INT, enforced BOOLEAN);
      CREATE TABLE admin_credentials (id INT PRIMARY KEY, admin_id INT, revoked_at DATETIME);
      CREATE TABLE owner_fishpen_assignments (owner_user_id INT PRIMARY KEY, fishpen_id INT);
      CREATE TABLE sms_fishpens (id INT PRIMARY KEY, owner_user_id INT, name VARCHAR(100));
      CREATE TABLE water_readings (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, input_mode VARCHAR(10), recorded_at DATETIME,
        ph DECIMAL(4,2), temperature DECIMAL(5,2), dissolved_oxygen DECIMAL(5,2), turbidity DECIMAL(8,2), ammonia DECIMAL(7,3));
      CREATE TABLE hardware_assignments (id INT PRIMARY KEY, owner_user_id INT, ended_at DATETIME);
      CREATE TABLE sensor_telemetry (id INT PRIMARY KEY, owner_user_id INT, assignment_id INT, sampled_at DATETIME, recorded_at DATETIME,
        ph DECIMAL(4,2), temperature_c DECIMAL(5,2), dissolved_oxygen DECIMAL(5,2), turbidity_ntu DECIMAL(8,2), water_contact_confirmed BOOLEAN);
      INSERT INTO users VALUES (1,'Test admin','admin',NULL), (2,'Original owner','farmer',NULL),
        (3,'Other owner','farmer',NULL), (4,'Manual farmer','farmer',NULL), (5,'Demo','farmer','+639000000000');
      INSERT INTO admin_security VALUES (1,1,TRUE);
      INSERT INTO admin_credentials VALUES (21,1,NULL);
      INSERT INTO sms_fishpens VALUES (10,2,'Current pen');
      INSERT INTO owner_fishpen_assignments VALUES (2,10);
      INSERT INTO hardware_assignments VALUES (20,2,UTC_TIMESTAMP()-INTERVAL 5 SECOND);
      INSERT INTO water_readings (user_id,input_mode,recorded_at,ph,turbidity) VALUES
        (2,'manual',UTC_TIMESTAMP()-INTERVAL 1 HOUR,7.2,NULL),
        (3,'manual',UTC_TIMESTAMP()-INTERVAL 5 SECOND,NULL,140),
        (4,'manual',UTC_TIMESTAMP()-INTERVAL 2 DAY,9.4,NULL),
        (5,'manual',UTC_TIMESTAMP()-INTERVAL 1 SECOND,9.5,NULL);
      INSERT INTO sensor_telemetry VALUES
        (1,2,20,UTC_TIMESTAMP()-INTERVAL 8 SECOND,UTC_TIMESTAMP()-INTERVAL 7 SECOND,8.8,NULL,NULL,NULL,TRUE),
        (2,3,NULL,UTC_TIMESTAMP()-INTERVAL 3 SECOND,UTC_TIMESTAMP()-INTERVAL 2 SECOND,9.4,NULL,NULL,NULL,FALSE),
        (3,3,NULL,UTC_TIMESTAMP()-INTERVAL 3 SECOND,UTC_TIMESTAMP()-INTERVAL 2 SECOND,19,NULL,NULL,NULL,TRUE),
        (4,2,NULL,UTC_TIMESTAMP()+INTERVAL 1 HOUR,UTC_TIMESTAMP()-INTERVAL 1 SECOND,9.4,NULL,NULL,NULL,TRUE);`);
    await db.query(`INSERT INTO water_readings (user_id,input_mode,recorded_at,ph) VALUES ?`,
      [Array.from({ length: 1000 }, () => [2, 'manual', '2020-01-01 00:00:00', 7])]);

    const app = express();
    app.get('/session/:role', (req, res) => {
      const admin = req.params.role === 'admin';
      createAuthSession(res, admin ? 1 : 2, admin ? 'admin' : 'farmer', 0, admin ? 21 : undefined);
      res.sendStatus(200);
    });
    app.use('/api', adminReportingRouter(db));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const session = async (role: string) => (await fetch(`${base}/session/${role}`)).headers.get('set-cookie')!.split(';')[0];
      const endpoint = `${base}/api/admin/farmer-water-quality`;
      assert.equal((await fetch(endpoint)).status, 401);
      assert.equal((await fetch(endpoint, { headers: { Cookie: await session('farmer') } })).status, 403);
      const result = await fetch(endpoint, { headers: { Cookie: await session('admin') } });
      assert.equal(result.status, 200, await result.clone().text());
      assert.equal(result.headers.get('cache-control'), 'no-store');
      const report = await result.json() as FarmerWaterReport;
      assert.deepEqual(report.totals, { safe: 0, warning: 1, critical: 1, noData: 1 });
      const byId = new Map(report.farmers.map(row => [row.id, row]));
      assert.deepEqual(byId.get(2)?.counts, { safe: 1001, warning: 1, critical: 0 });
      assert.equal(byId.get(2)?.latest?.source, 'sensor');
      assert.equal(byId.get(2)?.fishpenName, 'Current pen');
      assert.equal(assessmentIsOutdated(byId.get(2)!.latest!, Date.now()), true);
      assert.equal(byId.get(3)?.latest, null);
      assert.equal(byId.get(4)?.latest?.source, 'manual');
      assert.equal(assessmentIsOutdated(byId.get(4)!.latest!, Date.now()), true);
      assert.equal(byId.has(5), false);
      assert.ok(!JSON.stringify(report).includes('turbidity'));
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  } finally {
    if (fixture) await db.query(`DROP DATABASE ${fixture}`);
    await db.end();
  }
});
