// Local browser fixture only; no requests reach a real API or SMS provider.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PONDSENSE_PLAYWRIGHT || 'playwright');

async function main() {
  const base = new URL(process.env.PONDSENSE_BROWSER_URL || 'http://127.0.0.1:5180');
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    page.setDefaultTimeout(10000);
    const errors = [];
    const writes = [];
    let passwordAttempts = 0;
    const unexpected = [];
    page.on('pageerror', error => errors.push(error.stack));
    const owner = { id: 2, role: 'farmer', fullName: 'Fixture Farmer', phone: '+639111111111', accountStatus: 'ACTIVE', fishpenName: 'Fixture Pen' };
    const assignment = { id: 8, name: owner.fishpenName, deviceId: null, hardwareId: null, assignmentId: null };
    const initial = { id: assignment.id, name: assignment.name, loginPhone: owner.phone, ownerAlertPhone: null, ownerPhone: owner.phone, caretakerPhone: null, caretakerEnabled: false };
    let fishpen = initial;
    const masked = number => number && `**** ${number.slice(-4)}`;
    const smsPath = '/api/admin/owners/2/sms-recipients';
    await page.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      if (method === 'PUT' && path === smsPath) {
        writes.push([path, request.postDataJSON()]);
        fishpen = { ...fishpen, ownerAlertPhone: '+639144444444', ownerPhone: '+639144444444', caretakerPhone: '+639987654321', caretakerEnabled: true };
        return route.fulfill({ json: { fishpen } });
      }
      if (method === 'POST' && path === '/api/owner/password') {
        passwordAttempts++;
        return passwordAttempts === 1
          ? route.fulfill({ status: 400, json: { message: 'Current password is incorrect.' } })
          : route.fulfill({ json: { changed: true } });
      }
      const responses = {
        '/api/admin/session': { admin: { id: 1, role: 'admin', fullName: 'Fixture Admin' } },
        '/api/admin/users': { users: [owner] },
        [smsPath]: { fishpen },
        '/api/session': { user: { ...owner, mustChangePassword: false }, fishpenAssignment: assignment },
        '/api/fish-species': { profiles: [] },
        '/api/readings': { sessions: [] },
        '/api/sensors/latest': { telemetry: null, hardwareAssigned: false },
        '/api/sensors/trend': { readings: [] },
        '/api/sensors/devices': { devices: [] },
        '/api/fishpen-sms': { fishpens: [{ id: fishpen.id, name: fishpen.name, owner_enabled: true, caretaker_phone: masked(fishpen.caretakerPhone), caretaker_enabled: fishpen.caretakerEnabled }], ownerPhone: masked(fishpen.ownerPhone), configured: false, policy: { reviewed: true, reference: 'Test fixture' } }
      };
      if (method === 'GET' && responses[path]) return route.fulfill({ json: responses[path] });
      unexpected.push(`${method} ${path}`);
      return route.fulfill({ status: 404, json: { message: 'No fixture for this request.' } });
    });
    const noOverflow = locator => locator.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1);
    for (const width of [1440, 320]) {
      fishpen = initial;
      await page.setViewportSize({ width, height: 900 });
      await page.goto(new URL('/admin/users', base).href);
      await page.getByRole('button', { name: 'View', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: owner.fullName });
      const disclosure = dialog.getByText('SMS recipients', { exact: true });
      await disclosure.focus();
      await page.keyboard.press('Enter');
      const phone = dialog.getByLabel('Caretaker mobile number (optional)');
      await phone.fill('0911-111-1111');
      await dialog.getByText(/no separate caretaker alert/i).waitFor();
      const enable = dialog.getByRole('checkbox', { name: /send confirmed critical/i });
      assert.equal(await enable.isDisabled(), true);
      await dialog.getByLabel('Owner SMS number (optional)').fill('0914 444 4444');
      await phone.fill('639144444444');
      assert.equal(await enable.isDisabled(), true);
      await phone.fill('09987654321');
      await enable.check();
      const save = dialog.getByRole('button', { name: 'Save SMS recipients' });
      assert.equal(await save.isDisabled(), true);
      await dialog.getByRole('checkbox', { name: /the caretaker agreed/i }).check();
      await save.click();
      const confirmation = page.getByRole('dialog', { name: 'Save SMS recipients for Fixture Pen?', exact: true });
      await confirmation.getByText(/ending in 4444/).waitFor();
      assert.ok(!(await confirmation.textContent()).includes('09987654321'));
      await page.keyboard.press('Escape');
      await confirmation.waitFor({ state: 'hidden' });
      assert.ok(await dialog.isVisible());
      assert.equal(writes.length, width === 1440 ? 0 : 1);
      await save.click();
      await confirmation.getByRole('button', { name: 'Save recipients' }).click();
      await dialog.locator('.swal2-toast.swal2-icon-success').getByText('SMS recipients saved. No message was sent.').waitFor();
      assert.equal(await noOverflow(dialog), true);

      await page.goto(new URL('/profile', base).href);
      const sms = page.locator('details').filter({ has: page.getByText('SMS Notifications', { exact: true }) });
      await sms.getByText('**** 4321 (Enabled)', { exact: true }).waitFor();
      await sms.getByText('**** 4444 (Enabled)', { exact: true }).waitFor();
      await page.getByText('Fishpen operator', { exact: true }).waitFor();
      assert.ok(!(await sms.textContent()).includes(fishpen.ownerPhone));
      assert.ok(!(await sms.textContent()).includes(fishpen.caretakerPhone));
      assert.equal(await sms.locator('input, button').count(), 0);
      assert.equal(await noOverflow(sms), true);
      await page.getByText('Change password', { exact: true }).click();
      await page.getByLabel('Current password', { exact: true }).waitFor();
      if (width === 1440) {
        await page.getByLabel('Current password', { exact: true }).fill('fixture-current');
        await page.getByLabel('New password', { exact: true }).fill('fixture-new-pass');
        await page.getByLabel('Confirm new password', { exact: true }).fill('fixture-new-pass');
        await page.getByRole('button', { name: 'Save new password' }).click();
        await page.getByRole('alert').filter({ hasText: 'Current password is incorrect.' }).waitFor();
        await page.locator('.swal2-toast.swal2-icon-error').getByText('Password change not confirmed.').waitFor();
        assert.equal(await page.locator('.swal2-toast.swal2-icon-success').count(), 0);
        await page.getByRole('button', { name: 'Save new password' }).click();
        await page.locator('.swal2-toast').getByText('Password changed.', { exact: true }).waitFor();
      }
      const profile = page.getByRole('main');
      await profile.getByRole('button', { name: 'Filipino', exact: true }).click();
      await page.getByText('Makipag-ugnayan sa admin para baguhin ang mga tatanggap ng SMS.', { exact: true }).waitFor();
      await profile.getByRole('button', { name: 'English', exact: true }).click();
    }
    assert.deepEqual(writes, [1440, 320].map(() => [smsPath, { fishpenId: assignment.id, ownerAlertPhone: '0914 444 4444', caretakerPhone: '09987654321', caretakerEnabled: true, consentConfirmed: true }]));
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    assert.equal(passwordAttempts, 2);
    console.log('SMS recipient UI checks passed on desktop and mobile.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
