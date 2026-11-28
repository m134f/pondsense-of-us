import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Pool } from 'mysql2/promise';
import { acceptableAdminCredential, canEnrollAdminCredential, isAdminCredentialPolicy } from './services/AdminDevicePolicy';
import { adminWebauthnRouter, flowHash } from './routes/adminWebauthn';

test('the default device-bound policy still rejects eligible or backed-up credentials', () => {
  assert.equal(acceptableAdminCredential({ credentialDeviceType: 'singleDevice', credentialBackedUp: false }), true);
  assert.equal(acceptableAdminCredential({ credentialDeviceType: 'multiDevice', credentialBackedUp: false }), false);
  assert.equal(acceptableAdminCredential({ credentialDeviceType: 'multiDevice', credentialBackedUp: true }), false);
  assert.equal(acceptableAdminCredential({ credentialDeviceType: 'singleDevice', credentialBackedUp: true }), false);
});
test('only an explicit sync-eligible policy accepts multi-device credentials regardless of backup state', () => {
  for (const backedUp of [true, false]) {
    assert.equal(acceptableAdminCredential({ credentialDeviceType: 'multiDevice', credentialBackedUp: backedUp }, 'sync-eligible'), true);
    assert.equal(acceptableAdminCredential({ credentialDeviceType: 'singleDevice', credentialBackedUp: backedUp }, 'sync-eligible'), false);
  }
  for (const value of [undefined, null, 'auto', true]) assert.equal(isAdminCredentialPolicy(value), false);
});
test('third credential and invalid slot counts are rejected', () => {
  for (const count of [0, 1]) assert.equal(canEnrollAdminCredential(count), true);
  for (const count of [2, 3, 4, -1, NaN, 1.5]) assert.equal(canEnrollAdminCredential(count), false);
});
test('flow tokens are represented by stable hashes, not plaintext', () => {
  assert.equal(flowHash('secret').length, 64);
  assert.equal(flowHash('secret'), flowHash('secret'));
  assert.notEqual(flowHash('secret'), flowHash('different'));
});
test('HTTP guards deny absent sessions, cross-origin calls, and unknown/expired flow tokens', async () => {
  const origin = process.env.WEBAUTHN_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:5173';
  const connection = {
    beginTransaction: async () => {}, rollback: async () => {}, commit: async () => {}, release: () => {},
    query: async () => [[], []], execute: async () => [[], []]
  };
  const db = { getConnection: async () => connection, execute: async () => [[], []], query: async () => [[{ attempts: 1 }], []] } as unknown as Pool;
  const app = express(); app.use(express.json()); app.use('/api', adminWebauthnRouter(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/admin/security`;
  try {
    assert.equal((await fetch(base + '/devices')).status, 401);
    assert.equal((await fetch(base + '/enroll/approve', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' })).status, 401);
    assert.equal((await fetch(base + '/enroll/options', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
    for (const path of ['/authenticate/options', '/authenticate/verify', '/enroll/request', '/enroll/options', '/enroll/verify']) {
      const result = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token: 'unknown-or-expired-token' }) });
      assert.equal(result.status, 400);
      assert.equal(result.headers.get('set-cookie'), null);
    }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
