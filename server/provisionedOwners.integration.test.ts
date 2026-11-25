import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
      assert.equal(owner.deviceKey, undefined);
      assert.equal(owner.deviceId, undefined);
      const [pens] = await db.query<RowDataPacket[]>('SELECT device_id FROM sms_fishpens WHERE owner_user_id = ?', [owner.id]);
      assert.equal(pens.length, 1);
      assert.equal(pens[0].device_id, null);
      assert.equal((await request(`/admin/owners/${owner.id}/monitoring-device`,'PUT',{deviceId:1},session(owner.id,'farmer'))).status,403);
      assert.equal((await request(`/admin/owners/${owner.id}/monitoring-device`,'PUT',{deviceId:1},admin)).status,410);
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
    assert.equal((await request(`/admin/owners/${owners[0].id}/device-key`,'POST',{},owners[0].cookie)).status,403);
    assert.equal((await request(`/admin/owners/${owners[0].id}/device-key`,'POST',{},admin)).status,410);
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
    assert.deepEqual(after.counts, before.counts);
    assert.deepEqual(after.users.filter(row=>before.users.some(old=>old.id===row.id)),before.users);
  } finally {
    if(server)await new Promise<void>((resolve,reject)=>server!.close(e=>e?reject(e):resolve()));
    await db.end();
  }
});
