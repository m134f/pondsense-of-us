import test from 'node:test';
import assert from 'node:assert/strict';
import { apiErrorMessage } from './apiError';
test('proxy failures explain unavailable server without blaming credentials', () => {
  assert.match(apiErrorMessage(500), /server is unavailable/);
  assert.match(apiErrorMessage(502), /password has not been verified/);
  assert.equal(apiErrorMessage(401, 'Invalid credentials.'), 'Invalid credentials.');
  assert.equal(apiErrorMessage(403, 'Device verification required.'), 'Device verification required.');
});
