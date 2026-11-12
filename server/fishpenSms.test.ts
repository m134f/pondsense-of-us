import { test } from 'node:test';
import assert from 'node:assert/strict';
import { philippinePhone, recipients, validateSmsSettings, sensorSmsMeasurements, alertSignature, waterSmsPolicy } from './services/FishpenSms';
import { recommend, referenceThresholds } from '../src/lib/recommendations';
import { sendSms } from './sms';

test('PH mobile normalization and rejection', () => {
  for (const value of ['09123456789', '639123456789', '+63 (912) 345-6789']) assert.equal(philippinePhone(value), '+639123456789');
  for (const value of ['123', '+12025550123', '091234567890', true, null, '+639123456789abc']) assert.equal(philippinePhone(value), null);
});
test('owner-only, missing caretaker, both recipients, switches and same-number deduplication', () => {
  const pen = { owner_phone: '09123456789', owner_enabled: 1, caretaker_phone: null as string | null, caretaker_enabled: 0 };
  assert.deepEqual(recipients(pen), [{ type: 'owner', phone: '+639123456789' }]);
  assert.equal(recipients({ ...pen, caretaker_enabled: 1 }).length, 1);
  const both = { ...pen, caretaker_phone: '09987654321', caretaker_enabled: 1 };
  assert.equal(recipients(both).length, 2);
  assert.deepEqual(recipients({ ...both, owner_enabled: 0 }), [{ type: 'caretaker', phone: '+639987654321' }]);
  assert.deepEqual(recipients({ ...pen, owner_enabled: 0 }), []);
  assert.equal(recipients({ ...both, caretaker_phone: '+639123456789' }).length, 1);
});
test('settings validation rejects invalid numbers, switches, devices and names', () => {
  const body = { name: 'Cuyab 1', deviceId: null, ownerEnabled: true, caretakerPhone: '', caretakerEnabled: false };
  assert.equal(validateSmsSettings(body).caretakerPhone, null);
  for (const change of [{ caretakerPhone: '123' }, { caretakerEnabled: true }, { ownerEnabled: 'false' }, { name: '\n' }, { deviceId: -1 }]) assert.throws(() => validateSmsSettings({ ...body, ...change }));
});
test('only recent verified data produces an alert signature', () => {
  const now = Date.now();
  const body = { sampledAt: new Date(now).toISOString(), verifiedParameters: ['temperature', 'turbidity'], probeSubmerged: true };
  const items = (extra: object, values = { temperature: 34, turbidity: 150 }) => recommend(sensorSmsMeasurements(values, { ...body, ...extra }), referenceThresholds, now);
  assert.equal(alertSignature(items({})[0]), 'warning:high');
  assert.ok(items({ sampledAt: new Date(now - 60000).toISOString() }).every(i => alertSignature(i) === null));
  assert.ok(items({ sampledAt: null }).every(i => alertSignature(i) === null));
  assert.ok(items({ verifiedParameters: [] }).every(i => alertSignature(i) === null));
  assert.equal(alertSignature(items({ probeSubmerged: false }).find(i => i.parameter === 'turbidity')!), null);
  assert.equal(alertSignature(items({}).find(i => i.parameter === 'ph')!), null);
});
test('expert-review gate fails closed', () => {
  const old = [process.env.WATER_SMS_THRESHOLDS_REVIEWED, process.env.WATER_SMS_RULES_REFERENCE];
  try {
    process.env.WATER_SMS_THRESHOLDS_REVIEWED = 'false'; process.env.WATER_SMS_RULES_REFERENCE = 'test reference';
    assert.equal(waterSmsPolicy().reviewed, false);
    process.env.WATER_SMS_THRESHOLDS_REVIEWED = 'true'; assert.equal(waterSmsPolicy().reviewed, true);
    process.env.WATER_SMS_RULES_REFERENCE = ''; assert.equal(waterSmsPolicy().reviewed, false);
  } finally {
    for (const [key, value] of [['WATER_SMS_THRESHOLDS_REVIEWED', old[0]], ['WATER_SMS_RULES_REFERENCE', old[1]]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
test('provider adapter uses one attempt; distinguishes rejection, acceptance and unknown; redacts token', async () => {
  const original = globalThis.fetch, token = process.env.IPROG_SMS_API_TOKEN;
  process.env.IPROG_SMS_API_TOKEN = 'fake-test-token';
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ status: 400, message: 'fake-test-token rejected' }), { status: 400 }); };
    const failed = await sendSms('+639123456789', 'TEST ONLY', { singleAttempt: true });
    assert.equal(calls, 1); assert.equal(failed.ok, false); assert.equal(failed.uncertain, false); assert.doesNotMatch(failed.message, /fake-test-token/);
    globalThis.fetch = async () => new Response(JSON.stringify({ status: 200, message_id: 'mock-id' }));
    const accepted = await sendSms('+639123456789', 'TEST ONLY', { singleAttempt: true });
    assert.equal(accepted.ok, true); assert.match(accepted.message, /not confirmed/);
    globalThis.fetch = async () => { throw new Error('mock timeout'); };
    assert.equal((await sendSms('+639123456789', 'TEST ONLY', { singleAttempt: true })).uncertain, true);
    globalThis.fetch = async () => new Response('{}', { status: 503 });
    assert.equal((await sendSms('+639123456789', 'TEST ONLY', { singleAttempt: true })).uncertain, true);
  } finally { globalThis.fetch = original; if (token === undefined) delete process.env.IPROG_SMS_API_TOKEN; else process.env.IPROG_SMS_API_TOKEN = token; }
});
