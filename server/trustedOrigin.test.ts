import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import { isTrustedJsonRequest, trustedOrigins } from './trustedOrigin';

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
      headers: { origin },
      is: (type: string) => type === contentType
    }) as unknown as Request;
    assert.ok(isTrustedJsonRequest(request('https://pondsense-of-us.vercel.app')));
    assert.ok(!isTrustedJsonRequest(request('https://attacker.example')));
    assert.ok(!isTrustedJsonRequest(request('https://pondsense-of-us.vercel.app', 'text/plain')));
  } finally {
    if (previous === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previous;
  }
});
