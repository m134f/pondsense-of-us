// Run against localhost only. Every API response, including credentials, is a test fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PONDSENSE_PLAYWRIGHT || 'playwright');

const base = 'http://localhost:5175';
const now = new Date().toISOString();
const farmer = { id: 2, role: 'farmer', fullName: 'Fixture Farmer', phone: '+639111111111', accountStatus: 'ACTIVE', fishpenName: 'Test Pen', deviceId: 14 };
const monitor = { id: 14, device_name: 'ESP32', owner_user_id: 2, owner_name: farmer.fullName, is_active: 1, monitoring_fishpen_id: 9,
  fishpen_name: 'Test Pen', current_upload_at: now, last_reading_at: now, connection: 'online' };
const offline = { ...monitor, id: 15, monitoring_fishpen_id: null, fishpen_name: null, connection: 'offline' };
const fish = { id: 5, name: 'Tilapia', optimal_ph_min: '6.5', optimal_ph_max: '8.5', optimal_temp_min: 25, optimal_temp_max: 32,
  optimal_do_min: 5, optimal_do_max: 8, optimal_turb_min: 25, optimal_turb_max: 100, max_ammonia: '0.0500' };

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1440, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    const writes = [];
    let overviewUnavailable = true;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== 'GET') writes.push([request.method(), url.pathname, request.postDataJSON()]);
      if (url.pathname === '/api/admin/overview' && overviewUnavailable) return route.fulfill({ status: 503, json: { message: 'Overview temporarily unavailable.' } });
      const responses = {
        '/api/admin/session': { admin: { id: 1, role: 'admin', fullName: 'Fixture Administrator' } },
        '/api/admin/login': { token: 'fixture-login', bootstrapRequired: true },
        '/api/admin/overview': { counts: { farmers: 6, sensorReadings: 142, criticalToday: 0, smsToday: 3 },
          devices: { online: 1, offline: 1, never: 0, inactive: 0, assigned: 1 }, freshnessSeconds: 60,
          activity: [{ id: 1, kind: 'upload', happened_at: now, label: 'ESP32', device_id: 14 }] },
        '/api/admin/users': { users: [farmer] },
        '/api/admin/owners': { temporaryPassword: 'fixture-password', deviceKey: 'fixture-device-key', deviceId: 55 },
        '/api/admin/owners/2/device-key': { deviceId: 14, deviceKey: 'fixture-replacement-key' },
        '/api/admin/devices': { devices: [monitor, offline], freshnessSeconds: 60 },
        '/api/admin/fishpen-assignments': { owners: [{ id: 2, name: farmer.fullName, fishpenId: 9 }], fishpens: [{ id: 9, ownerId: 2, name: 'Test Pen', deviceId: 14 }], devices: [{ id: 14, name: 'ESP32', ownerId: 2 }, { id: 15, name: 'ESP32', ownerId: 2 }] },
        '/api/admin/telemetry': { readings: [{ id: 3, owner_name: 'Owner at upload', device_id: 14, recorded_at: now, sampled_at: null, ph: null, temperature_c: 28, water_contact_confirmed: 1 }] },
        '/api/admin/logs': { logs: [{ id: 4, full_name: 'Manual test operator', recorded_at: now, ph: 9, status: null }] },
        '/api/admin/water-sms': { logs: [{ id: 8, log_type: 'incident', fishpen_name: 'Test Pen', status: 'accepted' }] },
        '/api/admin/alerts': { alerts: [{ id: 6, full_name: 'Legacy owner', sms_status: 'skipped' }] },
        '/api/admin/planning-sms': { logs: [{ id: 7, full_name: farmer.fullName, status: 'sent' }] },
        '/api/admin/audit-logs': { auditLogs: [{ id: 5, full_name: 'Fixture Administrator', action: 'device_assigned' }] },
        '/api/admin/thresholds': { fish: [fish, { id: 'pending', name: 'Pending species', validationPending: true }] },
        '/api/admin/security/devices': { devices: [], currentCredentialId: null },
        '/api/admin/logout': { ok: true }
      };
      if (url.pathname === '/api/admin/thresholds/5' && request.method() === 'PATCH') Object.assign(fish, request.postDataJSON());
      return route.fulfill({ json: responses[url.pathname] ?? {} });
    });
    const go = path => page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await go('/admin/login');
    await page.getByLabel('Admin password').fill('fixture-only');
    await page.getByLabel('Admin PIN').fill('0000');
    await page.getByRole('button', { name: 'Login to Admin' }).click();
    await page.getByRole('button', { name: 'Continue existing admin access until setup' }).click();
    await page.getByRole('alert').getByText('Overview temporarily unavailable.').waitFor();
    overviewUnavailable = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByText('142', { exact: true }).waitFor();
    const nav = page.getByRole('navigation', { name: 'Admin navigation' });
    const open = name => nav.getByRole('link', { name, exact: true }).click();
    assert.equal(await nav.getByRole('link').count(), 6);
    assert.equal((await page.locator('.admin-sidebar').boundingBox()).width, 180);
    fs.mkdirSync('outputs/admin-console', { recursive: true });
    await page.screenshot({ path: 'outputs/admin-console/desktop.png' });

    await open('Users');
    await page.getByRole('row').filter({ hasText: 'Fixture Farmer' }).getByRole('button', { name: 'View', exact: true }).click();
    await page.getByRole('dialog', { name: 'Fixture Farmer' }).getByText('Test Pen').waitFor();
    await page.keyboard.press('Escape');
    await page.getByText('Create farmer account', { exact: true }).click();
    await page.getByLabel('Farmer name', { exact: true }).fill('New fixture');
    await page.getByLabel('Mobile number', { exact: true }).fill('09122222222');
    await page.getByLabel('Assigned fishpen name').fill('New test pen');
    await page.getByRole('button', { name: 'Create owner and fishpen' }).click();
    assert.equal(await page.getByText('fixture-device-key', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Copy Key', exact: true }).click();
    await page.getByText(/Key copied/).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'fixture-device-key');
    await page.getByRole('button', { name: 'Hide credentials' }).click();
    await page.evaluate(() => navigator.clipboard.writeText(''));
    assert.equal(writes.filter(([, path]) => path === '/api/admin/owners').length, 1);

    await open('Devices');
    await page.getByRole('table', { name: 'ESP32 devices' }).getByText('Offline', { exact: true }).waitFor();
    await page.getByLabel('Connection status').selectOption('online');
    assert.equal(await page.getByRole('table', { name: 'ESP32 devices' }).getByText('#15', { exact: true }).count(), 0);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Replace key' }).click();
    await page.getByRole('dialog', { name: 'Replacement device key' }).waitFor();
    assert.deepEqual(writes.find(([, path]) => path.endsWith('/device-key'))?.[2], { expectedDeviceId: 14 });
    await page.getByRole('button', { name: 'Hide key', exact: true }).click();
    await page.getByLabel('Connection status').selectOption('');
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: 'outputs/admin-console/mobile-devices.png' });

    await open('Logs');
    await page.getByRole('table', { name: 'ESP32 uploads' }).getByText('Owner at upload').waitFor();
    await page.getByLabel('Reading source').selectOption('manual');
    const manual = page.getByRole('table', { name: 'Manual analyses' });
    await manual.getByText('Not classified', { exact: true }).waitFor();
    assert.equal(await page.getByText('Owner at upload').count(), 0);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    assert.match(fs.readFileSync(await (await download).path(), 'utf8'), /Manual test operator/);
    await page.getByRole('tab', { name: 'Sensor Readings' }).press('ArrowRight');
    await page.getByRole('table', { name: 'Fishpen water SMS' }).getByText('Provider accepted (delivery unconfirmed)').waitFor();
    await page.getByLabel('SMS source').selectOption('legacy');
    await page.getByRole('table', { name: 'Legacy SMS alerts' }).waitFor();
    await page.getByRole('tab', { name: 'Planning SMS Logs' }).click();
    await page.getByRole('table', { name: 'Planning SMS attempts' }).waitFor();
    await page.getByRole('tab', { name: 'Admin Audit Logs' }).click();
    await page.getByRole('table', { name: 'Admin audit activity' }).getByText('device assigned').waitFor();

    await open('Thresholds');
    await page.getByRole('heading', { name: 'Tilapia' }).waitFor();
    assert.equal(await page.getByLabel('Maximum ammonia (mg/L)', { exact: true }).isVisible(), false);
    await page.getByText('Advanced', { exact: true }).click();
    await page.getByLabel('Maximum ammonia (mg/L)', { exact: true }).waitFor();
    await page.getByRole('group', { name: 'pH', exact: true }).getByLabel('Maximum').fill('8.6');
    await page.getByRole('button', { name: 'Save Thresholds' }).click();
    await page.getByText('Thresholds saved for Tilapia.').waitFor();
    assert.deepEqual(writes.find(([, path]) => path.endsWith('/thresholds/5'))?.[2], { optimal_ph_max: 8.6 });

    await open('Settings');
    await page.getByRole('heading', { name: 'Danger Zone' }).waitFor();
    await page.getByRole('button', { name: 'Clear Logs', exact: true }).click();
    const clear = page.getByRole('dialog', { name: 'Clear Logs' });
    assert.ok(await clear.getByRole('button', { name: 'Confirm Clear Logs' }).isDisabled());
    await clear.getByRole('button', { name: 'Cancel' }).click();
    assert.ok(writes.every(([method]) => method !== 'DELETE'));
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const target of ['Dashboard', 'Users', 'Devices', 'Logs', 'Thresholds', 'Settings']) {
        await open(target);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${target} clips at ${width}px`);
      }
    }
    await page.getByRole('button', { name: 'Logout' }).click();
    await page.getByRole('heading', { name: 'Admin Login' }).waitFor();
    assert.deepEqual(errors, []);
    console.log('Admin session, reporting, key clipboard, device filtering, logs and CSV, threshold save, danger-zone cancellation, and six views at five widths passed. No live API writes.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
