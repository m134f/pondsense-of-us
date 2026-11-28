// Local UI test. Every response and credential is a fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PONDSENSE_PLAYWRIGHT || 'playwright');

const base = process.env.PONDSENSE_BROWSER_URL || 'http://localhost:5175';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const output = 'outputs/shared-hardware';
const now = new Date().toISOString();
const farmer = { id: 2, role: 'farmer', fullName: 'Sample Farmer', phone: '+639111111111', accountStatus: 'ACTIVE', fishpenName: 'Cuyab Demonstration Pen', deviceId: 14 };
const other = { ...farmer, id: 3, fullName: 'Other Farmer', phone: '+639222222222', fishpenName: 'Other Pen', deviceId: 17 };
const unused = { ...farmer, id: 4, fullName: 'Unused Farmer', phone: '+639333333333', fishpenName: 'Empty Pen', deviceId: null, accountStatus: 'SUSPENDED' };
const sampleAssignment = 'aaaaaaaa-1234-4321-1234-123456789abc';
const monitor = { id: 1, credentialDeviceId: 14, name: 'Shared ESP32', chipId: '001122AABBCC', farmer: farmer.fullName,
  fishpen: farmer.fishpenName, assignmentId: sampleAssignment, status: 'Online', lastUpload: now, active: 1 };
const hardware = [monitor];
const tilapia = { id: 5, name: 'Tilapia', optimal_ph_min: '6.5', optimal_ph_max: '8.5', optimal_temp_min: 25, optimal_temp_max: 32,
  optimal_do_min: 5, optimal_do_max: 8, optimal_turb_min: 25, optimal_turb_max: 100, max_ammonia: '0.0500' };
const fish = [tilapia, { id: 'mamali', name: 'Mamali', validationPending: true }, { ...tilapia, id: 6, name: 'Bangus (Milkfish)' }];
const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
const assessment = (source, status, assessedAt) => ({
  source, status, assessedAt, sampledAt: source === 'sensor' ? assessedAt : null,
  receivedAt: assessedAt, previousAssignment: false
});
const qualityReport = {
  updatedAt: now, totals: { safe: 1, warning: 1, critical: 1, noData: 3 },
  farmers: [
    { id: 2, name: farmer.fullName, fishpenName: farmer.fishpenName, latest: assessment('sensor', 'warning', past), counts: { safe: 3, warning: 2, critical: 0 } },
    { id: 3, name: other.fullName, fishpenName: other.fishpenName, latest: assessment('manual', 'critical', now), counts: { safe: 0, warning: 0, critical: 1 } },
    { id: 4, name: unused.fullName, fishpenName: unused.fishpenName, latest: assessment('manual', 'safe', now), counts: { safe: 1, warning: 0, critical: 0 } },
    ...[5, 6, 7].map(id => ({ id, name: 'No Data Farmer ' + id, fishpenName: null, latest: null, counts: { safe: 0, warning: 0, critical: 0 } }))
  ]
};

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1440, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [], reads = [], writes = [];
    let overviewUnavailable = true;
    let unusedDeleted = false;
    let failCreation = true;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      if (method === 'GET') reads.push(url.pathname);
      else writes.push([method, url.pathname, request.postDataJSON()]);
      if (url.pathname === '/api/admin/overview' && overviewUnavailable) return route.fulfill({ status: 503, json: { message: 'Overview temporarily unavailable.' } });
      if (url.pathname === '/api/admin/owners' && method === 'POST' && failCreation) {
        failCreation = false;
        return route.fulfill({ status: 409, json: { message: 'A farmer account already uses this mobile number.' } });
      }
      if (url.pathname === '/api/admin/users/2/status' && method === 'PATCH') farmer.accountStatus = request.postDataJSON().status;
      if (method === 'DELETE' && url.pathname === '/api/admin/owners/2') {
        return route.fulfill({ status: 409, json: { message: 'This account has linked history and was not deleted.' } });
      }
      if (method === 'DELETE' && url.pathname === '/api/admin/owners/4') {
        assert.deepEqual(request.postDataJSON(), { confirm: 'DELETE' });
        unusedDeleted = true;
        return route.fulfill({ json: { deleted: true } });
      }
      if (url.pathname === '/api/admin/thresholds/5' && method === 'PATCH') Object.assign(tilapia, request.postDataJSON());
      if (url.pathname === '/api/admin/hardware' && method === 'POST') {
        hardware.push({ ...monitor, id: 2, chipId: '001122AABBEE', name: 'Fixture spare', assignmentId: null, farmer: null, fishpen: null, lastUpload: null, status: 'Unassigned' });
        return route.fulfill({ status: 201, json: { hardwareId: 2, deviceKey: 'fixture-device-key' } });
      }
      if (url.pathname.endsWith('/hardware/1/unassign')) Object.assign(monitor, { assignmentId: null, lastUpload: null, farmer: null, fishpen: null, status: 'Unassigned' });
      if (url.pathname.endsWith('/hardware/1/assign')) Object.assign(monitor, { assignmentId: 'b', farmer: other.fullName, fishpen: other.fishpenName, status: 'Offline' });
      const responses = {
        '/api/admin/session': { admin: { id: 1, role: 'admin', fullName: 'Sample Administrator' } },
        '/api/admin/login': { fixtureSession: true },
        '/api/admin/overview': { counts: { farmers: 2, sensorReadings: 142, criticalToday: 7, smsToday: 3 },
          devices: { online: 1, offline: 1, never: 1, inactive: 1, assigned: 1 },
          activity: [{ id: 1, kind: 'upload', happened_at: now, label: 'Hidden fixture activity', device_id: 14 }] },
        '/api/admin/farmer-water-quality': qualityReport,
        '/api/admin/users': { users: [farmer, other, ...(unusedDeleted ? [] : [unused])] },
        '/api/admin/owners': { temporaryPassword: 'fixture-password' },
        '/api/admin/hardware': { hardware },
        '/api/admin/hardware/fishpens': { fishpens: [{ ownerId: 2, farmer: farmer.fullName, fishpenId: 9, fishpen: farmer.fishpenName },
          { ownerId: 3, farmer: other.fullName, fishpenId: 10, fishpen: other.fishpenName }] },
        '/api/admin/hardware/1/unassign': { saved: true },
        '/api/admin/hardware/1/assign': { assignmentId: 'b' },
        '/api/admin/hardware/1/key': { hardwareId: 1, deviceKey: 'fixture-replacement-key' },
        '/api/admin/owners/2/reset-password': { temporaryPassword: 'fixture-reset' },
        '/api/admin/telemetry': { readings: [{ id: 1, owner_name: farmer.fullName, device_id: 14, recorded_at: now, sampled_at: null, ph: null, temperature_c: 28, water_contact_confirmed: 1 },
          { id: 2, owner_name: 'Not this device', device_id: 15, recorded_at: now, temperature_c: 29 }] },
        '/api/admin/logs': { logs: [{ id: 4, user_id: 2, full_name: farmer.fullName, recorded_at: now, ph: 9, status: null },
          { id: 5, user_id: 3, full_name: other.fullName, recorded_at: now, ph: 8 }] },
        '/api/admin/water-sms': { logs: [{ id: 8, owner_user_id: 2, log_type: 'incident', fishpen_name: farmer.fishpenName, status: 'accepted' },
          { id: 9, owner_user_id: 3, log_type: 'incident', fishpen_name: other.fishpenName, status: 'failed' }] },
        '/api/admin/alerts': { alerts: [{ id: 6, user_id: 2, full_name: farmer.fullName, sms_status: 'skipped' }] },
        '/api/admin/planning-sms': { logs: [{ id: 7, owner_user_id: 2, full_name: farmer.fullName, status: 'sent' }] },
        '/api/admin/thresholds': { fish },
        '/api/admin/security/devices': { devices: [{ id: 21, label: 'Admin laptop', last_used_at: now, revoked_at: null,
          credential_policy: 'device-bound', backup_eligible: 0, backed_up: 0 }], currentCredentialId: 21, maxCredentials: 2 },
        '/api/admin/security/enroll/approve': { approved: true },
        '/api/admin/logout': { ok: true }
      };
      return route.fulfill({ json: responses[url.pathname] ?? {} });
    });

    const go = path => page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const nav = page.getByRole('navigation', { name: 'Admin navigation' });
    const open = name => nav.getByRole('link', { name, exact: true }).click();
    const toast = (message, icon = 'success') => page.locator(`.swal2-toast.swal2-icon-${icon}`).getByText(message, { exact: true });
    const screenshots = !process.env.PONDSENSE_BROWSER_SKIP_SCREENSHOTS;
    const save = name => screenshots && page.screenshot({ path: output + '/' + name + '.png', fullPage: true, animations: 'disabled' });
    if (screenshots) fs.mkdirSync(output, { recursive: true });

    await go('/admin/login');
    await page.getByLabel('Admin password').fill('fixture-only');
    await page.getByLabel('Admin PIN').fill('0000');
    await page.getByRole('button', { name: 'Login to Admin' }).click();
    await page.getByRole('alert').getByText('Overview temporarily unavailable.').waitFor();
    overviewUnavailable = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.locator('.admin-metric dd').filter({ hasText: /^Online$/ }).waitFor();
    assert.deepEqual(await nav.getByRole('link').allTextContents().then(rows => rows.map(s => s.trim())), ['Dashboard', 'Users', 'Devices', 'Thresholds']);
    assert.equal((await page.locator('.admin-sidebar').boundingBox()).width, 180);
    assert.ok(await page.locator('.admin-sidebar-footer').getByRole('button', { name: 'Logout' }).isVisible());
    assert.deepEqual(await page.locator('.admin-metric dd').allTextContents(), ['2', '1', 'Online', farmer.fullName]);
    assert.equal(await page.getByText(/Sensor Readings|Critical Alerts Today|Recent Activity|SMS Accepted|Farmer Dashboard|Danger Zone/).count(), 0);
    const quality = page.getByRole('region', { name: 'Farmer Water Quality Records', exact: true }).filter({ has: page.getByRole('heading', { name: 'Farmer Water Quality Records' }) });
    const qualityTable = quality.getByRole('table', { name: 'Farmer water quality records' });
    await qualityTable.getByText('Outdated', { exact: true }).waitFor();
    assert.deepEqual(await quality.locator('.admin-quality-totals dd').allTextContents(), ['1', '1', '1', '3']);
    assert.equal(await quality.getByRole('row').count(), 6);
    await quality.getByRole('button', { name: 'Next page' }).click();
    await qualityTable.getByText('No Data Farmer 7', { exact: true }).waitFor();
    await quality.getByRole('combobox', { name: 'Filter by water quality status' }).selectOption('warning');
    await qualityTable.getByText('Warning 2', { exact: true }).waitFor();
    await quality.getByRole('combobox', { name: 'Filter by assessment source' }).selectOption('manual');
    await quality.getByText('No farmer records match these filters.').waitFor();
    await quality.getByRole('combobox', { name: 'Filter by water quality status' }).selectOption('all');
    await quality.getByRole('searchbox', { name: 'Search farmer or fishpen' }).fill(other.fishpenName);
    await qualityTable.getByText(other.fullName, { exact: true }).waitFor();
    assert.equal(await qualityTable.getByText(farmer.fullName, { exact: true }).count(), 0);
    await quality.getByRole('searchbox', { name: 'Search farmer or fishpen' }).clear();
    await quality.getByRole('combobox', { name: 'Filter by assessment source' }).selectOption('all');
    await save('desktop-dashboard');

    await page.getByRole('button', { name: 'Create farmer account' }).click();
    assert.ok(await page.getByLabel('Farmer name', { exact: true }).isVisible());
    await page.getByLabel('Farmer name', { exact: true }).fill('New sample farmer');
    await page.getByLabel('Mobile number', { exact: true }).fill('09122222222');
    await page.getByLabel('Assigned fishpen name').fill('New sample pen');
    await page.getByRole('button', { name: 'Create owner and fishpen' }).click();
    await toast('Account creation not confirmed.', 'error').waitFor();
    assert.equal(await page.getByText('fixture-password', { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('Farmer name', { exact: true }).inputValue(), 'New sample farmer');
    await page.getByRole('button', { name: 'Create owner and fishpen' }).click();
    await toast('Farmer account and fishpen created.').waitFor();
    assert.equal(await page.locator('.swal2-toast').getByText(/fixture-password/).count(), 0);
    await page.getByText('fixture-password', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Copy Key', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Hide credentials' }).click();
    await page.evaluate(() => navigator.clipboard.writeText(''));
    assert.equal(writes.filter(([, path]) => path === '/api/admin/owners').length, 2);
    await page.getByText('Create farmer account', { exact: true }).click();
    await save('desktop-users');

    const farmerTable = page.getByRole('table', { name: 'Farmer accounts' });
    await page.getByRole('searchbox', { name: 'Search users' }).fill('Sample Farmer');
    assert.equal(await farmerTable.getByText('Other Farmer').count(), 0);
    await farmerTable.getByRole('button', { name: 'View', exact: true }).click();
    const farmerDetail = page.getByRole('dialog', { name: farmer.fullName });
    await farmerDetail.getByText(farmer.fishpenName).waitFor();
    assert.equal(await farmerDetail.getByRole('button', { name: 'Delete account' }).count(), 0);
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
    await farmerDetail.getByRole('button', { name: 'Suspend account' }).click();
    const suspend = page.getByRole('dialog', { name: 'Suspend Sample Farmer?', exact: true });
    await suspend.getByRole('button', { name: 'Cancel', exact: true }).click();
    await suspend.waitFor({ state: 'hidden' });
    assert.equal(writes.filter(([, path]) => path.endsWith('/status')).length, 0);
    await farmerDetail.getByRole('button', { name: 'Suspend account' }).click();
    await suspend.getByRole('button', { name: 'Suspend account', exact: true }).click();
    await toast('Farmer account suspended.').waitFor();
    await farmerDetail.getByRole('button', { name: 'Reactivate account' }).waitFor();
    await farmerDetail.getByRole('button', { name: 'Delete account' }).click();
    const confirmDelete = page.getByRole('dialog', { name: 'Delete farmer account' });
    assert.ok(await confirmDelete.getByRole('button', { name: 'Delete permanently' }).isDisabled());
    await confirmDelete.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(writes.filter(([method]) => method === 'DELETE').length, 0);
    await farmerDetail.getByRole('button', { name: 'Delete account' }).click();
    await confirmDelete.getByLabel('Type DELETE to confirm').fill('DELETE');
    await confirmDelete.getByRole('button', { name: 'Delete permanently' }).click();
    await confirmDelete.getByRole('alert').filter({ hasText: 'linked history' }).waitFor();
    await toast('Account deletion not confirmed.', 'error').waitFor();
    await confirmDelete.getByRole('button', { name: 'Cancel' }).click();
    await farmerDetail.getByRole('button', { name: 'Reactivate account' }).click();
    await page.getByRole('dialog', { name: 'Reactivate Sample Farmer?', exact: true }).getByRole('button', { name: 'Reactivate account' }).click();
    await toast('Farmer account reactivated.').waitFor();
    await farmerDetail.getByRole('button', { name: 'Suspend account' }).waitFor();
    await farmerDetail.getByRole('button', { name: 'Reset password' }).click();
    await page.getByRole('dialog', { name: 'Reset the password for Sample Farmer?', exact: true }).getByRole('button', { name: 'Reset password' }).click();
    await page.getByRole('dialog', { name: 'Temporary password' }).getByText('fixture-reset').waitFor();
    await toast('Farmer password reset.').waitFor();
    assert.equal(await page.locator('.swal2-toast').getByText(/fixture-reset/).count(), 0);
    await page.getByRole('button', { name: 'Hide password' }).click();
    assert.equal(writes.filter(([, path]) => path.endsWith('/device-key')).length, 0);
    await page.getByRole('searchbox', { name: 'Search users' }).fill(unused.fullName);
    await farmerTable.getByRole('button', { name: 'View', exact: true }).click();
    await page.getByRole('dialog', { name: unused.fullName }).getByRole('button', { name: 'Delete account' }).click();
    await confirmDelete.getByLabel('Type DELETE to confirm').fill('DELETE');
    await confirmDelete.getByRole('button', { name: 'Delete permanently' }).click();
    await page.locator('.swal2-toast').getByText('Farmer account deleted.').waitFor();
    await page.getByText('No farmer accounts match.').waitFor();

    await open('Devices');
    const deviceTable = page.getByRole('table', { name: 'Registered hardware' });
    await deviceTable.getByText('Online', { exact: true }).waitFor();
    await save('desktop-devices');
    await deviceTable.getByRole('button', { name: 'Shared ESP32', exact: true }).click();
    const device = page.getByRole('dialog', { name: 'Shared ESP32' });
    await device.getByText('Upload history', { exact: true }).click();
    const uploads = device.getByRole('table', { name: 'ESP32 uploads' });
    await uploads.getByText('Confirmed', { exact: true }).waitFor();
    assert.equal(await uploads.getByText('Not this device').count(), 0);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Register Hardware' }).click();
    const register = page.getByRole('dialog', { name: 'Register Hardware' });
    await register.getByLabel('Hardware name').fill('Fixture spare');
    await register.getByLabel('ESP32 Hardware ID').fill('001122AABBEE');
    await register.getByRole('button', { name: 'Register', exact: true }).click();
    const keyDialog = page.getByRole('dialog', { name: 'One-time hardware key' });
    await toast('Hardware registered.').waitFor();
    assert.equal(await page.locator('.swal2-toast').getByText(/fixture-device-key/).count(), 0);
    await keyDialog.getByRole('button', { name: 'Copy Key' }).click();
    await keyDialog.getByText(/Key copied/).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'fixture-device-key');
    await page.keyboard.press('Escape');
    await page.evaluate(() => navigator.clipboard.writeText(''));

    const row = deviceTable.getByRole('row').filter({ hasText: '001122AABBCC' });
    await row.getByRole('button', { name: 'Unassign Hardware' }).click();
    const unassign = page.getByRole('dialog', { name: 'Unassign Shared ESP32?', exact: true });
    await unassign.getByText(/Assigned to Sample Farmer/).waitFor();
    await unassign.getByRole('button', { name: 'Unassign hardware', exact: true }).click();
    await toast('Hardware unassigned.').waitFor();
    await row.getByRole('button', { name: 'Assign Hardware', exact: true }).waitFor();
    assert.deepEqual(writes.find(([, path]) => path.endsWith('/hardware/1/unassign'))?.[2], { assignmentId: sampleAssignment });
    await row.getByRole('button', { name: 'Assign Hardware', exact: true }).click();
    const assignment = page.getByRole('dialog', { name: 'Assign Shared ESP32' });
    await assignment.getByLabel('Farmer and fishpen').selectOption('10');
    assert.equal(await assignment.getByRole('button', { name: 'Activate assignment' }).isEnabled(), false);
    await assignment.getByRole('checkbox').check();
    await assignment.getByRole('button', { name: 'Activate assignment' }).click();
    await toast('Hardware assigned. Waiting for its first upload at this fishpen.').waitFor();
    await row.getByText('Other Pen', { exact: true }).waitFor();
    assert.deepEqual(writes.find(([, path]) => path.endsWith('/hardware/1/assign'))?.[2], { ownerId: 3, fishpenId: 10, confirmedMoved: true });
    assert.ok(!writes.some(([, path]) => path.endsWith('/hardware/1/key')));
    await row.getByRole('button', { name: 'Replace Key' }).click();
    const replace = page.getByRole('dialog', { name: 'Replace the key for Shared ESP32?', exact: true });
    await replace.getByText(/Assigned to Other Farmer/).waitFor();
    await replace.getByRole('button', { name: 'Replace key', exact: true }).click();
    await toast('Hardware key replaced.').waitFor();
    await keyDialog.getByRole('button', { name: 'Copy Key' }).waitFor();
    await page.keyboard.press('Escape');

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
    assert.equal(await page.getByText('Advanced', { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('Maximum ammonia (mg/L)', { exact: true }).count(), 0);
    await page.getByRole('group', { name: 'pH', exact: true }).getByLabel('Maximum').fill('8.6');
    await page.getByRole('button', { name: 'Save Thresholds' }).click();
    const thresholds = page.getByRole('dialog', { name: 'Save thresholds for Tilapia?', exact: true });
    await thresholds.getByText('pH maximum: 8.5 to 8.6').waitFor();
    await thresholds.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.ok(!writes.some(([, path]) => path.endsWith('/thresholds/5')));
    await page.getByRole('button', { name: 'Save Thresholds' }).click();
    await thresholds.getByRole('button', { name: 'Save thresholds', exact: true }).click();
    await toast('Thresholds saved for Tilapia.').waitFor();
    assert.deepEqual(writes.find(([, path]) => path.endsWith('/thresholds/5'))?.[2], { optimal_ph_max: 8.6 });
    assert.equal(await page.getByText(/Turbidity alert proposal|Voltage-to-NTU calculator|Not a DENR or LLDA standard/).count(), 0);
    assert.ok(!reads.includes('/api/admin/turbidity-alert-rule'));
    assert.equal(tilapia.optimal_turb_max, 100);
    tilapia.optimal_ph_max = '8.5';

    assert.ok(!reads.includes('/api/admin/security/devices'));
    assert.equal(await page.locator('.admin-topbar').getByRole('button').count(), 0);
    assert.equal(await page.getByRole('button', { name: /Login security|Passkey settings/ }).count(), 0);
    assert.equal(await page.locator('a[href="/admin/passkeys"]').count(), 0);
    await go('/admin/passkeys');
    const security = page.locator('.admin-main');
    await security.getByRole('heading', { name: 'Passkeys', exact: true }).waitFor();
    await security.getByText(/Admin laptop/).waitFor();
    assert.equal(await security.getByLabel('Enrollment request').isVisible(), false);
    await security.getByText('Approve a new login device', { exact: true }).click();
    await security.getByLabel('Enrollment request').fill('fixture-enrollment-request');
    await security.getByRole('button', { name: 'Approve device enrollment' }).click();
    const approval = page.getByRole('dialog', { name: 'Authorize this device-bound passkey?' });
    await approval.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.ok(!writes.some(([, path]) => path.endsWith('/security/enroll/approve')));
    await security.getByRole('button', { name: 'Approve device enrollment' }).click();
    await approval.getByRole('button', { name: 'Approve enrollment', exact: true }).click();
    await toast('Passkey enrollment approved.').waitFor();
    assert.ok(writes.some(([method, path, body]) => method === 'POST' && path.endsWith('/security/enroll/approve') && body.policy === 'device-bound'));
    await security.getByText('Recover access', { exact: true }).click();
    await security.getByText(/system operator/).waitFor();

    for (const retired of ['/admin/logs', '/admin/settings']) {
      await go(retired);
      await page.waitForURL('**/admin/dashboard');
      await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
    }
    assert.deepEqual(writes.filter(([method]) => method === 'DELETE'), [
      ['DELETE', '/api/admin/owners/2', { confirm: 'DELETE' }], ['DELETE', '/api/admin/owners/4', { confirm: 'DELETE' }]
    ]);
    const pages = { Dashboard: 'dashboard', Users: 'users', Devices: 'devices', Thresholds: 'thresholds' };
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [target, slug] of Object.entries(pages)) {
        await open(target);
        await page.locator('.admin-main h1').filter({ hasText: target }).waitFor();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), target + ' clips at ' + width);
        if (width === 390) {
          if (target === 'Users') await page.getByRole('table', { name: 'Farmer accounts' }).waitFor();
          if (target === 'Devices') await page.getByRole('table', { name: 'Registered hardware' }).waitFor();
          if (target === 'Thresholds') await page.getByRole('heading', { name: 'Tilapia' }).waitFor();
          if (target === 'Dashboard') await page.locator('.admin-metric dd li').filter({ hasText: 'Shared ESP32: Offline' }).waitFor();
          await save('mobile-' + slug);
        }
      }
      if (width === 320 || width === 390) {
        await go('/admin/passkeys');
        await security.getByText('Authorized login devices', { exact: true }).waitFor();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Passkeys clips at ' + width);
        await save('mobile-passkeys-' + width);
      }
    }
    await page.getByRole('button', { name: 'Logout' }).click();
    await page.getByRole('heading', { name: 'Admin Login' }).waitFor();
    assert.deepEqual(errors, []);
    console.log('Passed four admin pages at five widths, farmer actions, scoped records and CSV, key copying/replacement, physical hardware assignment and reassignment, species editing, login security, and logout. Fixture API only.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
