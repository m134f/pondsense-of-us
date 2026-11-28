import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response, CookieOptions } from 'express';
import { createAuthSession, verifyAuthToken } from './auth';

test('production signs an HttpOnly, Secure, host-only cookie and refuses it after expiry', t => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  const clock = t.mock.method(Date, 'now', () => Date.parse('2026-11-25T00:00:00Z'));
  let cookie = '';
  let flags: CookieOptions | undefined;
  const response = { cookie(name: string, token: string, options: CookieOptions) { cookie = `${name}=${token}`; flags = options; } } as Response;
  createAuthSession(response, 12, 'admin', 0, 4);
  assert.ok(flags?.httpOnly && flags.secure && flags.path === '/' && flags.domain === undefined);
  assert.equal(flags.sameSite, 'lax');
  const lifetime = 3_600_000;
  assert.equal(flags.maxAge, lifetime);
  const req = { headers: { cookie } } as Request;
  assert.equal(verifyAuthToken(req)?.credentialId, 4);
  clock.mock.mockImplementation(() => Date.parse('2026-11-25T00:00:00Z') + lifetime);
  assert.equal(verifyAuthToken(req), null);
  createAuthSession(response, 5, 'farmer');
  assert.equal(flags.maxAge, 28_800_000);
});
