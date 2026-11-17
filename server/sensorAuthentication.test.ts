import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import type { Pool } from 'mysql2/promise';
import { sensorAuthenticator } from './services/SensorAuthentication';

test('warm uploads use one device lookup while revocation, reassignment and rotated keys take effect immediately', async () => {
  const key='a secure fixture sensor key';
  let row: Record<string, unknown> | null = {id:4,device_name:'Fixture',owner_user_id:10,api_key_hash:await bcrypt.hash(key,4)};
  let scans=0,lookups=0;
  const db={execute:async(sql:string)=>{
    if(sql.startsWith('UPDATE')) return [{affectedRows:1},[]];
    if(sql.includes('WHERE id = ?'))lookups++;else scans++;
    return [row?[{...row}]:[],[]];
  }} as unknown as Pool;
  const authenticate=sensorAuthenticator(db);
  assert.equal((await authenticate(key))?.ownerUserId,10);
  row.owner_user_id=20;
  assert.equal((await authenticate(key))?.ownerUserId,20);
  assert.equal(scans,1);assert.equal(lookups,1);
  row.api_key_hash=await bcrypt.hash('replacement fixture key',4);
  assert.equal(await authenticate(key),null);
  row=null;assert.equal(await authenticate(key),null);
  assert.equal(await authenticate('unknown key'),null);
  assert.equal(await authenticate('x'.repeat(513)),null);
});
