import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'mysql2/promise';
import { migratePartialManual } from './partialManual';

test('migration only makes measurement columns nullable and preserves existing records', async () => {
  const queries: string[] = [];
  const db = { query: async (sql: string) => {
    queries.push(sql);
    return [[{ Field: 'ph', Null: 'NO' }, { Field: 'temperature', Null: 'YES' }, { Field: 'user_id', Null: 'NO' }]];
  }} as unknown as Pool;
  await migratePartialManual(db);
  assert.equal(queries[1], 'ALTER TABLE water_readings MODIFY COLUMN ph DECIMAL(4,2) NULL');
  assert.ok(!queries.some(sql => /DELETE|DROP|UPDATE/.test(sql)));
});
test('migration is a no-op when nullable columns already exist', async () => {
  let calls = 0;
  const db = { query: async () => { calls++; return [[{ Field: 'ph', Null: 'YES' }]]; } } as unknown as Pool;
  await migratePartialManual(db);
  assert.equal(calls, 1);
});
