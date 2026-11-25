// Local UI test. Every response and credential is a fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PONDSENSE_PLAYWRIGHT || 'playwright');

const base = process.env.PONDSENSE_BROWSER_URL || 'http://localhost:5175';
const output = 'outputs/admin-simplified';
const now = new Date().toISOString();
const farmer = { id: 2, role: 'farmer', fullName: 'Sample Farmer', phone: '+639111111111', accountStatus: 'ACTIVE', fishpenName: 'Cuyab Demonstration Pen', deviceId: 14 };
const other = { ...farmer, id: 3, fullName: 'Other Farmer', phone: '+639222222222', fishpenName: 'Other Pen', deviceId: 17 };
const monitor = { id: 14, device_name: 'ESP32', owner_user_id: 2, owner_name: farmer.fullName, is_active: 1, monitoring_fishpen_id: 9,
  fishpen_name: farmer.fishpenName, current_upload_at: now, last_reading_at: now, connection: 'online' };
const offline = { ...monitor, id: 15, monitoring_fishpen_id: null, fishpen_name: null, connection: 'offline', current_upload_at: '2026-01-02T00:00:00Z' };
const never = { ...offline, id: 16, connection: 'never', current_upload_at: null };
const inactive = { ...offline, id: 17, owner_user_id: 3, owner_name: other.fullName, is_active: 0, connection: 'inactive' };
const tilapia = { id: 5, name: 'Tilapia', optimal_ph_min: '6.5', optimal_ph_max: '8.5', optimal_temp_min: 25, optimal_temp_max: 32,
  optimal_do_min: 5, optimal_do_max: 8, optimal_turb_min: 25, optimal_turb_max: 100, max_ammonia: '0.0500' };
const fish = [tilapia, { id: 'mamali', name: 'Mamali', validationPending: true }, { ...tilapia, id: 6, name: 'Bangus (Milkfish)' }];

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1440, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [], reads = [], writes = [];
    let overviewUnavailable = true;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      if (method === 'GET') reads.push(url.pathname);
      else writes.push([method, url.pathname, request.postDataJSON()]);
      if (url.pathname === '/api/admin/overview' && overviewUnavailable) return route.fulfill({ status: 503, json: { message: 'Overview temporarily unavailable.' } });
      if (url.pathname === '/api/admin/users/2/status' && method === 'PATCH') farmer.accountStatus = request.postDataJSON().status;
      if (url.pathname === '/api/admin/thresholds/5' && method === 'PATCH') Object.assign(tilapia, request.postDataJSON());
      const responses = {
        '/api/admin/session': { admin: { id: 1, role: 'admin', fullName: 'Sample Administrator' } },
        '/api/admin/login': { token: 'fixture-login', bootstrapRequired: true },
        '/api/admin/overview': { counts: { farmers: 2, sensorReadings: 142, criticalToday: 7, smsToday: 3 },
          devices: { online: 1, offline: 1, never: 1, inactive: 1, assigned: 1 },
          activity: [{ id: 1, kind: 'upload', happened_at: now, label: 'Hidden fixture activity', device_id: 14 }] },
        '/api/admin/users': { users: [farmer, other] },
        '/api/admin/owners': { temporaryPassword: 'fixture-password', deviceKey: 'fixture-device-key', deviceId: 55 },
        '/api/admin/owners/2/reset-password': { temporaryPassword: 'fixture-reset' },
        '/api/admin/owners/2/device-key': { deviceId: 14, deviceKey: 'fixture-replacement-key' },
        '/api/admin/devices': { devices: [monitor, offline, never, inactive], freshnessSeconds: 60 },
        '/api/admin/fishpen-assignments': { owners: [{ id: 2, name: farmer.fullName, fishpenId: 9 }, { id: 3, name: other.fullName, fishpenId: 10 }],
          fishpens: [{ id: 9, ownerId: 2, name: farmer.fishpenName, deviceId: 14 }, { id: 10, ownerId: 3, name: other.fishpenName, deviceId: 17 }],
          devices: [{ id: 14, name: 'Primary ESP32', ownerId: 2 }, { id: 15, name: 'Spare ESP32', ownerId: 2 }, { id: 17, name: 'Other ESP32', ownerId: 3 }] },
        '/api/admin/telemetry': { readings: [{ id: 1, owner_name: farmer.fullName, device_id: 14, recorded_at: now, sampled_at: null, ph: null, temperature_c: 28, water_contact_confirmed: 1 },
          { id: 2, owner_name: 'Not this device', device_id: 15, recorded_at: now, temperature_c: 29 }] },
        '/api/admin/logs': { logs: [{ id: 4, user_id: 2, full_name: farmer.fullName, recorded_at: now, ph: 9, status: null },
          { id: 5, user_id: 3, full_name: other.fullName, recorded_at: now, ph: 8 }] },
        '/api/admin/water-sms': { logs: [{ id: 8, owner_user_id: 2, log_type: 'incident', fishpen_name: farmer.fishpenName, status: 'accepted' },
          { id: 9, owner_user_id: 3, log_type: 'incident', fishpen_name: other.fishpenName, status: 'failed' }] },
        '/api/admin/alerts': { alerts: [{ id: 6, user_id: 2, full_name: farmer.fullName, sms_status: 'skipped' }] },
        '/api/admin/planning-sms': { logs: [{ id: 7, owner_user_id: 2, full_name: farmer.fullName, status: 'sent' }] },
        '/api/admin/thresholds': { fish },
        '/api/admin/security/devices': { devices: [{ id: 21, label: 'Admin laptop', last_used_at: now, revoked_at: null }], currentCredentialId: 21 },
        '/api/admin/logout': { ok: true }
      };
      return route.fulfill({ json: responses[url.pathname] ?? {} });
    });

    const go = path => page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const nav = page.getByRole('navigation', { name: 'Admin navigation' });
    const open = name => nav.getByRole('link', { name, exact: true }).click();
    const save = name => process.env.PONDSENSE_BROWSER_SKIP_SCREENSHOTS ? Promise.resolve() : page.screenshot({ path: output + '/' + name + '.png', fullPage: true, animations: 'disabled' });
    if (!process.env.PONDSENSE_BROWSER_SKIP_SCREENSHOTS) fs.mkdirSync(output, { recursive: true });

    await go('/admin/login');
    await page.getByText('Recover admin access', { exact: true }).click();
    await page.getByText(/contact the system operator/).waitFor();
    await page.getByLabel('Admin password').fill('fixture-only');
    await page.getByLabel('Admin PIN').fill('0000');
    await page.getByRole('button', { name: 'Login to Admin' }).click();
    await page.getByRole('button', { name: 'Continue existing admin access until setup' }).click();
    await page.getByRole('alert').getByText('Overview temporarily unavailable.').waitFor();
    overviewUnavailable = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.locator('.admin-metric dd').filter({ hasText: /^4$/ }).waitFor();
    assert.deepEqual(await nav.getByRole('link').allTextContents().then(rows => rows.map(s => s.trim())), ['Dashboard', 'Users', 'Devices', 'Thresholds']);
    assert.equal((await page.locator('.admin-sidebar').boundingBox()).width, 180);
    assert.ok(await page.locator('.admin-sidebar-footer').getByRole('button', { name: 'Logout' }).isVisible());
    assert.deepEqual(await page.locator('.admin-metric dd').allTextContents(), ['2', '4', '1', '1']);
    assert.equal(await page.getByText(/Sensor Readings|Critical Alerts Today|Recent Activity|SMS Accepted|Farmer Dashboard|Danger Zone/).count(), 0);
    await save('desktop-dashboard');

    await page.getByRole('button', { name: 'Create farmer account' }).click();
    assert.ok(await page.getByLabel('Farmer name', { exact: true }).isVisible());
    await page.getByLabel('Farmer name', { exact: true }).fill('New sample farmer');
    await page.getByLabel('Mobile number', { exact: true }).fill('09122222222');
    await page.getByLabel('Assigned fishpen name').fill('New sample pen');
    await page.getByRole('button', { name: 'Create owner and fishpen' }).click();
    assert.equal(await page.getByText('fixture-device-key', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Copy Key', exact: true }).click();
    await page.getByText(/Key copied/).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'fixture-device-key');
    await page.getByRole('button', { name: 'Hide credentials' }).click();
    await page.evaluate(() => navigator.clipboard.writeText(''));
    assert.equal(writes.filter(([, path]) => path === '/api/admin/owners').length, 1);
    await page.getByText('Create farmer account', { exact: true }).click();
    await save('desktop-users');

    const farmerTable = page.getByRole('table', { name: 'Farmer accounts' });
    await page.getByRole('searchbox', { name: 'Search users' }).fill('Sample Farmer');
    assert.equal(await farmerTable.getByText('Other Farmer').count(), 0);
    await farmerTable.getByRole('button', { name: 'View', exact: true }).click();
    const farmerDetail = page.getByRole('dialog', { name: farmer.fullName });
    await farmerDetail.getByText(farmer.fishpenName).waitFor();
    assert.ok(!reads.includes('/api/admin/logs'));
    await farmerDetail.getByText('Farmer records', { exact: true }).click();
    const manual = farmerDetail.getByRole('table', { name: 'Manual analyses' });
    await manual.getByText('Not classified').waitFor();
    assert.equal(await manual.getByText(other.fullName).count(), 0);
    const download = page.waitForEvent('download');
    await farmerDetail.getByRole('button', { name: 'Export CSV' }).click();
    const csv = fs.readFileSync(await (await download).path(), 'utf8');
    assert.match(csv, /Sample Farmer/);
    assert.doesNotMatch(csv, /Other Farmer/);
    await farmerDetail.getByLabel('Record type').selectOption({ label: 'Fishpen water SMS' });
    const sms = farmerDetail.getByRole('table', { name: 'Fishpen water SMS' });
    await sms.getByText('Provider accepted (delivery unconfirmed)').waitFor();
    assert.equal(await sms.getByText('Other Pen').count(), 0);
    page.once('dialog', dialog => dialog.accept());
    await farmerDetail.getByRole('button', { name: 'Suspend account' }).click();
    await farmerDetail.getByRole('button', { name: 'Reactivate account' }).waitFor();
    page.once('dialog', dialog => dialog.accept());
    await farmerDetail.getByRole('button', { name: 'Reactivate account' }).click();
    await farmerDetail.getByRole('button', { name: 'Suspend account' }).waitFor();
    page.once('dialog', dialog => dialog.accept());
    await farmerDetail.getByRole('button', { name: 'Reset password' }).click();
    await page.getByRole('dialog', { name: 'Temporary password' }).getByText('fixture-reset').waitFor();
    await page.getByRole('button', { name: 'Hide password' }).click();
    assert.equal(writes.filter(([, path]) => path.endsWith('/device-key')).length, 0);

    await open('Devices');
    const deviceTable = page.getByRole('table', { name: 'ESP32 devices' });
    for (const label of ['Online', 'Offline', 'Never uploaded', 'Inactive']) await deviceTable.getByText(label, { exact: true }).waitFor();
    await save('desktop-devices');
    await page.getByLabel('Filter by connection').selectOption('online');
    assert.equal(await deviceTable.getByRole('button', { name: 'View ESP32 #15' }).count(), 0);
    await deviceTable.getByRole('button', { name: 'View ESP32 #14' }).click();
    const device = page.getByRole('dialog', { name: 'ESP32 #14' });
    assert.ok(!reads.includes('/api/admin/telemetry'));
    await device.getByText('Upload history', { exact: true }).click();
    const uploads = device.getByRole('table', { name: 'ESP32 uploads' });
    await uploads.getByText('Confirmed', { exact: true }).waitFor();
    assert.equal(await uploads.getByText('Not this device').count(), 0);
    await page.keyboard.press('Escape');
    await page.getByLabel('Filter by connection').selectOption('');
    await page.getByText('Fishpen assignments', { exact: true }).click();
    await page.getByLabel('Farmer', { exact: true }).selectOption('2');
    const options = await page.getByLabel('Monitoring device', { exact: true }).locator('option').allTextContents();
    assert.ok(options.some(s => s.includes('Spare ESP32')));
    assert.ok(options.every(s => !s.includes('Other ESP32')));
    await page.getByLabel('Monitoring device', { exact: true }).selectOption('15');
    await page.getByRole('button', { name: 'Save assignment' }).click();
    await page.getByText('Fishpen assignment saved.').waitFor();
    assert.deepEqual(writes.find(([, path]) => path.endsWith('/fishpen-assignments/2'))?.[2], { fishpenId: 9, name: farmer.fishpenName, deviceId: 15 });
    page.once('dialog', dialog => dialog.accept());
    await deviceTable.getByRole('button', { name: 'Replace key' }).click();
    await page.getByRole('dialog', { name: 'Replacement device key' }).waitFor();
    assert.deepEqual(writes.find(([, path]) => path.endsWith('/device-key'))?.[2], { expectedDeviceId: 14 });
    assert.equal(await page.getByText('fixture-replacement-key', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Hide key', exact: true }).click();

    await open('Thresholds');
    await page.getByRole('heading', { name: 'Tilapia' }).waitFor();
    const species = page.getByLabel('Fish species', { exact: true });
    assert.deepEqual(await species.locator('option').allTextContents(), ['Tilapia', 'Mamali', 'Bangus']);
    assert.equal(await page.getByLabel('Maximum ammonia (mg/L)', { exact: true }).isVisible(), false);
    await species.selectOption('mamali');
    await page.getByText('No editable ranges are configured for this species.').waitFor();
    await species.selectOption('bangus');
    await page.getByRole('heading', { name: 'Bangus (Milkfish)' }).waitFor();
    await species.selectOption('tilapia');
    await save('desktop-thresholds');
    await page.getByText('Advanced', { exact: true }).click();
    await page.getByLabel('Maximum ammonia (mg/L)', { exact: true }).waitFor();
    await page.getByRole('group', { name: 'pH', exact: true }).getByLabel('Maximum').fill('8.6');
    await page.getByRole('button', { name: 'Save Thresholds' }).click();
    await page.getByText('Thresholds saved for Tilapia.').waitFor();
    assert.deepEqual(writes.find(([, path]) => path.endsWith('/thresholds/5'))?.[2], { optimal_ph_max: 8.6 });
    tilapia.optimal_ph_max = '8.5';

    assert.ok(!reads.includes('/api/admin/security/devices'));
    await page.getByRole('button', { name: 'Login security' }).click();
    const security = page.getByRole('dialog', { name: 'Login security' });
    await security.getByText(/Admin laptop/).waitFor();
    assert.equal(await security.getByLabel('Enrollment request').isVisible(), false);
    await security.getByText('Approve a new login device', { exact: true }).click();
    await security.getByLabel('Enrollment request').fill('fixture-enrollment-request');
    page.once('dialog', dialog => dialog.accept());
    await security.getByRole('button', { name: 'Approve device enrollment' }).click();
    await security.getByText('Saved.', { exact: true }).waitFor();
    assert.ok(writes.some(([method, path]) => method === 'POST' && path.endsWith('/security/enroll/approve')));
    await security.getByText('Recover access', { exact: true }).click();
    await security.getByText(/system operator/).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Login security' }).waitFor();

    for (const retired of ['/admin/logs', '/admin/settings']) {
      await go(retired);
      await page.waitForURL('**/admin/dashboard');
      await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
    }
    assert.ok(writes.every(([method]) => method !== 'DELETE'));
    const pages = { Dashboard: 'dashboard', Users: 'users', Devices: 'devices', Thresholds: 'thresholds' };
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [target, slug] of Object.entries(pages)) {
        await open(target);
        await page.locator('.admin-main h1').filter({ hasText: target }).waitFor();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), target + ' clips at ' + width);
        if (width === 390) {
          if (target === 'Users') await page.getByRole('table', { name: 'Farmer accounts' }).waitFor();
          if (target === 'Devices') await page.getByRole('table', { name: 'ESP32 devices' }).waitFor();
          if (target === 'Thresholds') await page.getByRole('heading', { name: 'Tilapia' }).waitFor();
          if (target === 'Dashboard') await page.locator('.admin-metric dd').filter({ hasText: /^4$/ }).waitFor();
          await save('mobile-' + slug);
        }
      }
    }
    await page.getByRole('button', { name: 'Logout' }).click();
    await page.getByRole('heading', { name: 'Admin Login' }).waitFor();
    assert.deepEqual(errors, []);
    console.log('Passed four admin pages at five widths, farmer actions, scoped records and CSV, key copying/replacement, same-owner assignment, species editing, login security, and logout. Fixture API only.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
