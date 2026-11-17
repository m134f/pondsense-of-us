import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { createAuthSession } from './auth';
import { ownerAccess } from './ownerAccess';
import { ownerAccountsRouter } from './routes/ownerAccounts';
import { migrateProvisionedOwners } from './migrations/provisionedOwners';

const database = process.env.PONDSENSE_TEST_DATABASE;
test('restored local database: additive migration and real owner credential lifecycle', { skip: !database }, async () => {
  assert.match(database!, /^pondsense_restore_test_\d+$/);
  assert.ok(['localhost', '127.0.0.1'].includes(process.env.MYSQL_HOST || ''));
  const db = mysql.createPool({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database });
  const snapshot = async () => {
    const [users] = await db.query<RowDataPacket[]>('SELECT id,password_hash,account_status,auth_version FROM users ORDER BY id');
    const counts: Record<string, number> = {};
    for (const table of ['sensor_telemetry', 'sensor_devices', 'water_readings', 'harvest_batches', 'harvest_events', 'sms_water_attempts', 'recommendation_history']) {
      const [rows] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM ${table}`);
      counts[table] = Number(rows[0].total);
    }
    return { users, counts };
  };
  let server: ReturnType<ReturnType<typeof express>['listen']> | undefined;
  try {
    const before = await snapshot();
    await migrateProvisionedOwners(db); await migrateProvisionedOwners(db);
    assert.deepEqual(await snapshot(), before);
    const [admins] = await db.query<RowDataPacket[]>("SELECT id FROM users WHERE role='admin' LIMIT 1");
    assert.equal(admins.length, 1);
    const app = express(); app.use(express.json()); app.use('/api', ownerAccess(db)); app.use('/api', ownerAccountsRouter(db));
    app.get('/api/readings', (_req,res) => res.json({ fishpenId: res.locals.ownerFishpen.id }));
    app.get('/api/session', (_req,res) => res.json({ ok: true }));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
    const session = (id: number, role: 'admin' | 'farmer', version=0) => {
      let result='';
      createAuthSession({cookie: (name:string,value:string) => { result=`${name}=${value}`; }} as never,id,role,version);
      return result;
    };
    const request=(path:string, method='GET', body?:object, cookie='') => fetch(base+path,{method,headers:{Origin:process.env.FRONTEND_URL || 'http://localhost:5173','Content-Type':'application/json',Cookie:cookie},body:body?JSON.stringify(body):undefined});
    const admin=session(Number(admins[0].id),'admin');
    assert.equal((await request('/admin/owners','POST',{})).status,401);
    const owners=[];
    for(let i=0;i<2;i++) {
      const phone='+639'+String(crypto.randomInt(100000000,999999999));
      const created=await request('/admin/owners','POST',{fullName:'Disposable restore test owner',phone,fishpenName:'Disposable restore test fishpen'},admin);
      assert.equal(created.status,200); const owner=await created.json(); owners.push(owner);
      assert.match(owner.deviceKey, /^ps_[A-Za-z0-9_-]{32}$/);
      const [deviceRows] = await db.query<RowDataPacket[]>(`SELECT d.id,d.owner_user_id,p.device_id AS fishpen_device_id
        FROM sensor_devices d JOIN sms_fishpens p ON p.owner_user_id = d.owner_user_id
        WHERE d.id = ?`, [owner.deviceId]);
      assert.equal(Number(deviceRows[0].owner_user_id), owner.id);
      assert.equal(Number(deviceRows[0].fishpen_device_id), owner.deviceId);
      assert.equal((await request(`/admin/owners/${owner.id}/monitoring-device`,'PUT',{deviceId:owner.deviceId},session(owner.id,'farmer'))).status,403);
      assert.equal((await request(`/admin/owners/${owner.id}/monitoring-device`,'PUT',{deviceId:owner.deviceId},admin)).status,200);
      const temporary=session(owner.id,'farmer');
      assert.equal((await request('/readings','GET',undefined,temporary)).status,403);
      const changed=await request('/owner/password','POST',{currentPassword:owner.temporaryPassword,newPassword:'Local restore test passphrase '+i},temporary);
      assert.equal(changed.status,200);
      owner.cookie=changed.headers.get('set-cookie')!.split(';')[0];
      assert.equal((await request('/readings','GET',undefined,temporary)).status,403);
      const data=await (await request('/readings','GET',undefined,owner.cookie)).json(); owner.fishpenId=data.fishpenId;
      assert.ok(Number.isSafeInteger(owner.fishpenId));
      assert.equal((await request('/admin/owners','POST',{},owner.cookie)).status,403);
    }
    assert.notEqual(owners[0].fishpenId,owners[1].fishpenId);
    assert.equal((await request(`/admin/owners/${owners[0].id}/monitoring-device`,'PUT',{deviceId:owners[1].deviceId},admin)).status,403);
    const firstKey = owners[0].deviceKey;
    assert.equal((await request(`/admin/owners/${owners[0].id}/device-key`,'POST',{},owners[0].cookie)).status,403);
    const keyResponse = await request(`/admin/owners/${owners[0].id}/device-key`,'POST',{},admin);
    assert.equal(keyResponse.status,200);
    const replacement = await keyResponse.json();
    assert.equal(replacement.deviceId,owners[0].deviceId);
    const [keyRows] = await db.query<RowDataPacket[]>('SELECT api_key_hash FROM sensor_devices WHERE id = ?',[owners[0].deviceId]);
    assert.equal(await bcrypt.compare(firstKey,keyRows[0].api_key_hash),false);
    assert.equal(await bcrypt.compare(replacement.deviceKey,keyRows[0].api_key_hash),true);
    const [legacyDevice] = await db.execute<import('mysql2').ResultSetHeader>(
      'INSERT INTO sensor_devices (device_name, api_key_hash, owner_user_id) VALUES (?, ?, ?)',
      ['Disposable replacement monitor', await bcrypt.hash('disposable-test-key',10), owners[0].id]);
    assert.equal((await request(`/admin/owners/${owners[0].id}/monitoring-device`,'PUT',{deviceId:legacyDevice.insertId},admin)).status,200);
    const [monitorRows] = await db.query<RowDataPacket[]>('SELECT id,is_active FROM sensor_devices WHERE id IN (?, ?) ORDER BY id',[owners[0].deviceId,legacyDevice.insertId]);
    assert.deepEqual(monitorRows.map(row=>Number(row.is_active)),[0,1]);
    const [penRows] = await db.query<RowDataPacket[]>('SELECT device_id FROM sms_fishpens WHERE id = ?',[owners[0].fishpenId]);
    assert.equal(Number(penRows[0].device_id),legacyDevice.insertId);
    const duplicate=await request('/admin/owners','POST',{fullName:'Duplicate',phone:(await db.query<RowDataPacket[]>('SELECT phone FROM users WHERE id=?',[owners[0].id]))[0][0].phone,fishpenName:'Must rollback'},admin);
    assert.equal(duplicate.status,409);
    const owner=owners[0];
    await db.execute("UPDATE users SET account_status='SUSPENDED',auth_version=auth_version+1 WHERE id=?",[owner.id]);
    assert.equal((await request('/readings','GET',undefined,owner.cookie)).status,403);
    await db.execute("UPDATE users SET account_status='ACTIVE' WHERE id=?",[owner.id]);
    assert.equal((await request('/readings','GET',undefined,owner.cookie)).status,403);
    const reset=await request(`/admin/owners/${owner.id}/reset-password`,'POST',{},admin);
    assert.equal(reset.status,200);
    assert.equal((await request('/readings','GET',undefined,owner.cookie)).status,403);
    const [rows]=await db.query<RowDataPacket[]>('SELECT must_change_password,temporary_password_expires_at,UTC_TIMESTAMP() AS now FROM users WHERE id=?',[owner.id]);
    assert.equal(Number(rows[0].must_change_password),1);
    assert.ok(new Date(rows[0].temporary_password_expires_at).getTime()>new Date(rows[0].now).getTime());
    const after=await snapshot();
    assert.equal(after.counts.sensor_devices,before.counts.sensor_devices + 3);
    for (const table of Object.keys(before.counts).filter(table => table !== 'sensor_devices')) assert.equal(after.counts[table],before.counts[table]);
    assert.deepEqual(after.users.filter(row=>before.users.some(old=>old.id===row.id)),before.users);
  } finally {
    if(server)await new Promise<void>((resolve,reject)=>server!.close(e=>e?reject(e):resolve()));
    await db.end();
  }
});
