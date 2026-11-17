import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import express from 'express';
import type { Pool } from 'mysql2/promise';
import { ownerAccess } from './ownerAccess';
import { ownerAccountsRouter, validOwnerPassword } from './routes/ownerAccounts';
import { createAuthSession } from './auth';
import { migrateProvisionedOwners } from './migrations/provisionedOwners';

test('migration preserves passwords, account statuses, records and is repeatable', async () => {
  const queries: string[] = [];
  const db = { query: async (sql: string) => { queries.push(sql); if (queries.length > 3) throw Object.assign(new Error('exists'), {code:'ER_DUP_FIELDNAME'}); } } as unknown as Pool;
  await migrateProvisionedOwners(db); await migrateProvisionedOwners(db);
  assert.equal(queries.length, 6);
  assert.ok(queries.every(sql => /^ALTER TABLE users ADD COLUMN/.test(sql)));
  assert.match(queries[0], /DEFAULT FALSE/);
});
test('password policy rejects short and bcrypt-truncated credentials', () => {
  assert.equal(validOwnerPassword('short'), false);
  assert.equal(validOwnerPassword('a'.repeat(73)), false);
  assert.equal(validOwnerPassword('界'.repeat(25)), false);
  assert.equal(validOwnerPassword('a secure owner passphrase'), true);
});

test('provision, restricted first login, password change, reset and API authorization with mocked SQL', async () => {
  const users = new Map<number, Record<string, any>>([[1, {id:1, role:'admin', account_status:'ACTIVE', auth_version:0}]]);
  const assignments = new Map<number, Record<string, any>>(); const audits: unknown[][] = [];
  let nextId = 10;
  const query = async (sql: string, args: any[] = []) => {
    if (sql.includes('FROM admin_security')) return [[{admin_id:1, enforced:false}], []];
    if (sql.includes('FROM admin_auth_rate')) return [[{attempts:1}], []];
    if (sql.includes('FROM owner_fishpen_assignments')) return [assignments.has(args[0]) ? [assignments.get(args[0])] : [], []];
    if (sql.includes('FROM users')) { const u=users.get(Number(args[0])); return [u && (!args[1] || args[1]===u.role) ? [{...u}] : [], []]; }
    if (sql.startsWith('INSERT INTO users')) { const id=nextId++; users.set(id,{id,role:'farmer',account_status:'ACTIVE',auth_version:0,password_hash:args[2],must_change_password:1,temporary_password_expires_at:new Date(Date.now()+86400000)}); return [{insertId:id},[]]; }
    if (sql.startsWith('INSERT INTO sms_fishpens')) return [{insertId:100+args[0]},[]];
    if (sql.startsWith('INSERT INTO owner_fishpen_assignments')) { assignments.set(args[0],{id:args[1],name:'Cuyab owner pen',deviceId:null}); return [{affectedRows:1},[]]; }
    if (sql.startsWith('INSERT INTO admin_audit_logs')) { audits.push(args); return [{affectedRows:1},[]]; }
    if (sql.startsWith('UPDATE users SET password_hash')) { const u=users.get(args[1])!; u.password_hash=args[0]; u.auth_version++; u.must_change_password=sql.includes('must_change_password = TRUE')?1:0; u.temporary_password_expires_at=u.must_change_password?new Date(Date.now()+86400000):null; return [{affectedRows:1},[]]; }
    if (sql.startsWith('INSERT INTO admin_auth_rate')) return [{affectedRows:1},[]];
    throw new Error('Unexpected SQL: '+sql);
  };
  const c={query,execute:query,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}};
  const db={query,execute:query,getConnection:async()=>c} as unknown as Pool;
  const app=express(); app.use(express.json());
  app.get('/fixture/login/:id', (req,res)=>{const u=users.get(Number(req.params.id))!;createAuthSession(res,u.id,u.role,u.auth_version);res.json({ok:true});});
  app.use('/api',ownerAccess(db)); app.use('/api',ownerAccountsRouter(db));
  app.all('/api/register',(_req,res)=>res.sendStatus(410));
  app.get('/api/session',(_req,res)=>res.json({ok:true}));
  app.get(['/api/readings','/api/sensors/latest','/api/harvests','/api/fishpen-sms','/api/recommendations'],(_req,res)=>res.json({ok:true}));
  app.post('/api/v1/sensors/measurements',(_req,res)=>res.status(401).json({message:'Device API key required'}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const origin=process.env.FRONTEND_URL||'http://localhost:5173';
  const cookie=async(id:number)=>(await fetch(base+'/fixture/login/'+id)).headers.get('set-cookie')!.split(';')[0];
  const request=(path:string,method='GET',body?:object,auth='',from=origin)=>fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',Origin:from,...(auth?{Cookie:auth}:{})},body:body?JSON.stringify(body):undefined});
  try {
    const admin=await cookie(1);
    assert.equal((await request('/register','POST',{phone:'+639111111111'})).status,410);
    assert.equal((await request('/admin/owners','POST',{},'')).status,401);
    assert.equal((await request('/admin/owners','POST',{},admin,'https://bad.example')).status,403);
    const created=await request('/admin/owners','POST',{fullName:'Owner',phone:'+639111111111',fishpenName:'Cuyab'},admin);
    assert.equal(created.status,200);const data=await created.json();const id=data.id;
    assert.ok(assignments.has(id)); assert.notEqual(users.get(id)!.password_hash,data.temporaryPassword);
    assert.equal(await bcrypt.compare(data.temporaryPassword,users.get(id)!.password_hash),true);
    const temporary=await cookie(id);
    assert.equal((await request('/session','GET',undefined,temporary)).status,200);
    for(const path of ['/readings','/sensors/latest','/harvests','/fishpen-sms','/recommendations']) {
      assert.equal((await request(path)).status,401);
      assert.equal((await request(path,'GET',undefined,temporary)).status,403);
    }
    assert.equal((await request('/admin/owners','POST',{},temporary)).status,403);
    assert.equal((await request('/owner/password','POST',{currentPassword:'wrong',newPassword:'a new strong password'},temporary)).status,403);
    const changed=await request('/owner/password','POST',{currentPassword:data.temporaryPassword,newPassword:'a new strong password'},temporary);
    assert.equal(changed.status,200);const current=changed.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request('/readings','GET',undefined,temporary)).status,403);
    assert.equal((await request('/readings','GET',undefined,current)).status,200);
    users.get(id)!.account_status='SUSPENDED';assert.equal((await request('/readings','GET',undefined,current)).status,403);users.get(id)!.account_status='ACTIVE';
    assignments.delete(id);assert.equal((await request('/readings','GET',undefined,current)).status,403);assignments.set(id,{id:100+id,name:'Cuyab',deviceId:null});
    const reset=await request(`/admin/owners/${id}/reset-password`,'POST',{},admin);assert.equal(reset.status,200);
    assert.equal((await request('/readings','GET',undefined,current)).status,403);
    users.get(id)!.temporary_password_expires_at=new Date(Date.now()-1);
    assert.equal((await request('/session','GET',undefined,await cookie(id))).status,403);
    assert.ok(audits.length>=2);assert.ok(audits.every(row=>!JSON.stringify(row).includes(data.temporaryPassword)));
    assert.equal((await request('/v1/sensors/measurements','POST',{})).status,401);
  } finally {await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
