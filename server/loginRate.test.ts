import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import type { Pool } from 'mysql2/promise';
import { allowSource, trustedProxy } from './loginRate';

test('proxy IP trust is off by default and requires explicitly verified CIDRs', () => {
  assert.equal(trustedProxy({}), false);
  assert.equal(trustedProxy({ NODE_ENV: 'production', RENDER: 'true' }), false);
  for (const range of ['true', '0.0.0.0/0', '::/0', '::ffff:192.0.2.1/128', '192.0.2.1/33']) {
    assert.throws(() => trustedProxy({ AUTH_TRUSTED_PROXY_CIDRS: range }), /verified proxies/);
  }
});

test('Render without a trusted proxy shares rate limits and ignores forwarded client addresses', async () => {
  const buckets: unknown[] = [];
  const db = {
    execute: async (sql: string, params: unknown[]) => { if (sql.startsWith('INSERT')) buckets.push(params[0]); },
    query: async () => [[{ attempts: buckets.length }]],
  } as unknown as Pool;
  const env = { NODE_ENV: 'production', RENDER: 'true' };
  for (const [index, ip] of ['192.0.2.53', '198.51.100.3'].entries()) {
    const request = { ip, headers: { 'x-forwarded-for': ip } } as unknown as Request;
    assert.equal(await allowSource(db, request, 'admin-login', 1, env), index === 0);
  }
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0], buckets[1]);
});

test('the allowlist matches only specified peers, including IPv4-mapped sockets', () => {
  const trust = trustedProxy({ AUTH_TRUSTED_PROXY_CIDRS: '192.0.2.4/30,2001:db8:1234::/48' });
  assert.ok(trust);
  assert.equal(trust('192.0.2.4'), true);
  assert.equal(trust('::ffff:192.0.2.5'), true);
  assert.equal(trust('2001:db8:1234::1'), true);
  assert.equal(trust('192.0.2.9'), false);
  assert.equal(trust('::ffff:192.0.2.9'), false);
  assert.equal(trust('2001:db8:4321::1'), false);
  assert.equal(trust('invalid'), false);
});
