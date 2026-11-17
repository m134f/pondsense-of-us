import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { Pool } from 'mysql2/promise';
import { migrateAccountStatus } from './migrations/accountStatus';

test('account migration preserves existing users and defaults new users to pending', async () => {
  const queries: string[] = [];
  await migrateAccountStatus({ query: async (sql: string) => { queries.push(sql); return [[], []]; } } as unknown as Pool);
  assert.match(queries[0], /DEFAULT 'ACTIVE'/);
  assert.match(queries[1], /DEFAULT 'PENDING'/);
  assert.match(queries[2], /auth_version/);
  assert.ok(queries.every(sql => !/DELETE|DROP|TRUNCATE/i.test(sql)));
});

test('account migration tolerates existing columns without resetting account decisions', async () => {
  const queries: string[] = [];
  await migrateAccountStatus({ query: async (sql: string) => {
    queries.push(sql);
    if (sql.includes('ADD COLUMN')) throw Object.assign(new Error('exists'), { code: 'ER_DUP_FIELDNAME' });
    return [[], []];
  } } as unknown as Pool);
  assert.equal(queries.length, 3);
  assert.ok(queries.every(sql => !sql.startsWith('UPDATE')));
});

test('production refuses missing, weak, or historical default secrets', () => {
  for (const secret of ['', 'short', 'pondsense-local-dev-jwt-secret']) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '-e', "import('./server/auth.ts')"], {
      env: { ...process.env, NODE_ENV: 'production', SESSION_SECRET: secret, JWT_SECRET: '' }, encoding: 'utf8'
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /Production requires a strong SESSION_SECRET/);
  }
});
