import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import { isTrustedJsonRequest, needsBrowserOrigin, trustedOrigins } from './trustedOrigin';

test('production frontend remains trusted when FRONTEND_URL is absent', () => {
  const previous = process.env.FRONTEND_URL;
  try {
    delete process.env.FRONTEND_URL;
    assert.ok(trustedOrigins().includes('https://pondsense-of-us.vercel.app'));
  } finally {
    if (previous === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previous;
  }
});

test('configured origin is normalized without allowing arbitrary sites', () => {
  const previous = process.env.FRONTEND_URL;
  try {
    process.env.FRONTEND_URL = ' https://pondsense-of-us.vercel.app/ ';
    const request = (origin: string, contentType = 'application/json') => ({
      headers: { origin, 'content-type': contentType }
    }) as unknown as Request;
    assert.ok(isTrustedJsonRequest(request('https://pondsense-of-us.vercel.app')));
    assert.ok(!isTrustedJsonRequest(request('https://attacker.example')));
    assert.ok(!isTrustedJsonRequest(request('https://pondsense-of-us.vercel.app', 'text/plain')));
  } finally {
    if (previous === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previous;
  }
});

test('bodyless DELETE with JSON header and trusted origin is accepted', () => {
  const request = {
    method: 'DELETE',
    headers: { origin: 'https://pondsense-of-us.vercel.app', 'content-type': 'application/json; charset=utf-8' },
    is: () => null
  } as unknown as Request;
  assert.ok(isTrustedJsonRequest(request));
});

test('production only trusts its configured HTTPS frontend; only device POSTs bypass browser origin checks', t => {
  const { FRONTEND_URL, NODE_ENV } = process.env;
  t.after(() => {
    if (FRONTEND_URL === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = FRONTEND_URL;
    if (NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = NODE_ENV;
  });
  process.env.NODE_ENV = 'production';
  process.env.FRONTEND_URL = 'https://staging.example.test';
  assert.deepEqual(trustedOrigins(), ['https://staging.example.test']);
  process.env.FRONTEND_URL = 'http://localhost:5173';
  assert.deepEqual(trustedOrigins(), []);
  assert.equal(needsBrowserOrigin({ method: 'POST', path: '/v2/hardware/assignment' } as Request), false);
  assert.equal(needsBrowserOrigin({ method: 'POST', path: '/admin/hardware/1/assign' } as Request), true);
  assert.equal(needsBrowserOrigin({ method: 'DELETE', path: '/v2/hardware/assignment' } as Request), true);
});
