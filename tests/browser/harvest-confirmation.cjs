const assert = require('node:assert/strict');
const { chromium } = require(process.env.PONDSENSE_PLAYWRIGHT || 'playwright');
const createHarvest = require('./harvest-fixture.cjs');

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 840 }, serviceWorkers: 'block' });
    page.setDefaultTimeout(10000);
    const fishpenAssignment = { id: 1, name: 'Test Fishpen', deviceId: null };
    const fixture = createHarvest(fishpenAssignment);
    const writes = [];
    let rejectFirstSave = true;
    await page.route('**/api/**', route => {
      const req = route.request(), path = new URL(req.url()).pathname, method = req.method();
      const body = req.postDataJSON();
      if (method !== 'GET') {
        writes.push({ method, path, body });
        if (rejectFirstSave) {
          rejectFirstSave = false;
          return route.fulfill({ status: 400, json: { message: 'Test save rejected.' } });
        }
      }
      const result = fixture(method, path, body ?? undefined);
      if (result) return route.fulfill(result);
      const responses = {
        '/api/session': { user: { id: 1, role: 'farmer', fullName: 'Test Farmer', mustChangePassword: false }, fishpenAssignment },
        '/api/sensors/devices': { devices: [] },
        '/api/readings': { sessions: [] },
        '/api/sensors/latest': { telemetry: null }
      };
      return route.fulfill({ json: responses[path] ?? {} });
    });
    const button = name => page.getByRole('button', { name, exact: true });
    const dialog = name => page.getByRole('dialog', { name, exact: true });
    const heading = name => page.getByRole('heading', { name, exact: true });
    const savedToast = page.locator('.swal2-toast').getByText('Fish group saved.', { exact: true });
    const expectSavedToast = async () => {
      await savedToast.waitFor();
      assert.equal(await page.locator('.farmer-alert').getByText('Fish group saved.', { exact: true }).count(), 0);
      const rect = await savedToast.boundingBox();
      assert.ok(rect.x >= 0 && rect.x + rect.width <= page.viewportSize().width);
    };
    const confirm = async (title, label) => {
      const popup = dialog(title);
      await popup.getByRole('button', { name: label, exact: true }).click();
      await popup.waitFor({ state: 'hidden' });
    };
    await page.goto(new URL('/harvest', process.env.PONDSENSE_BROWSER_URL || 'http://127.0.0.1:5177').href);
    await button('Add Fish Group').click();
    await button('Cancel').click();
    await heading('Harvest Management').waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
    await button('Add Fish Group').click();
    const saveGroup = 'Are you sure you want to save this record?';
    await button('Save Fish Group').click();
    assert.equal(await page.getByRole('dialog').count(), 0, 'invalid form must not open the confirmation');
    await page.getByLabel('Date fish were stocked').fill('2025-01-10');
    await page.getByLabel('Number of fish stocked').fill('50');
    await page.getByLabel('Your planned harvest date').fill('2025-02-10');
    const discard = 'Discard unsaved changes?';
    await button('Cancel').click();
    await confirm(discard, 'Keep editing');
    assert.equal(await page.getByLabel('Number of fish stocked').inputValue(), '50');
    const mobileNav = page.getByRole('navigation', { name: 'Mobile navigation' });
    await mobileNav.getByRole('link', { name: 'Analysis' }).click();
    await confirm(discard, 'Keep editing');
    assert.ok(page.url().endsWith('/harvest'));
    await mobileNav.getByRole('link', { name: 'Analysis' }).click();
    await confirm(discard, 'Discard changes');
    await page.getByRole('heading', { name: 'Manual water analysis' }).waitFor();
    assert.equal(writes.length, 0);
    await mobileNav.getByRole('link', { name: 'Harvest' }).click();
    await button('Add Fish Group').click();
    assert.equal(await page.getByLabel('Number of fish stocked').inputValue(), '');
    await page.getByLabel('Date fish were stocked').fill('2025-01-10');
    await page.getByLabel('Number of fish stocked').fill('50');
    await page.getByLabel('Your planned harvest date').fill('2025-02-10');
    await button('Save Fish Group').focus();
    await page.locator('.harvest-entry').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await dialog(saveGroup).getByText(/50 fish stocked/).waitFor();
    assert.equal(writes.length, 0);
    const rect = await dialog(saveGroup).boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= 390, 'confirmation fits mobile viewport');
    await confirm(saveGroup, 'Cancel');
    await button('Save Fish Group').and(page.locator(':focus')).waitFor();
    assert.equal(writes.length, 0);
    assert.equal(await savedToast.count(), 0);
    assert.equal(await page.getByLabel('Number of fish stocked').inputValue(), '50');
    await button('Save Fish Group').click();
    await confirm(saveGroup, 'Save fish group');
    await dialog('Save not confirmed').getByText('Test save rejected.').waitFor();
    await confirm('Save not confirmed', 'OK');
    assert.equal(writes.length, 1);
    assert.equal(await savedToast.count(), 0);
    assert.equal(await page.getByLabel('Number of fish stocked').inputValue(), '50');
    await button('Save Fish Group').click();
    await confirm(saveGroup, 'Save fish group');
    await expectSavedToast();
    await savedToast.waitFor({ state: 'hidden' });
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0], writes[1]);

    await page.setViewportSize({ width: 1440, height: 900 });
    const openGroup = async () => page.locator('.harvest-species-row').first().click();
    assert.equal(await button('Measure Fish').count(), 0);
    await openGroup();
    assert.equal(await button('Measure Fish').count(), 0);
    await button('Edit fish group').click();
    await page.getByLabel('Number of fish stocked').fill('100');
    await button('Save Fish Group').click();
    await confirm('Save changes to this fish group?', 'Save changes');
    await expectSavedToast();
    assert.equal(writes.at(-1).method, 'PUT');
    assert.equal(writes.at(-1).body.stockedCount, 100);
    const groupId = Number(writes.at(-1).path.split('/').at(-1));
    fixture('POST', `/api/harvests/${groupId}/samples`, { sampledAt: '2025-01-11', sampleSize: 3, averageWeightG: 120 });
    await page.reload();
    await openGroup();
    await page.getByText('120 g', { exact: true }).filter({ visible: true }).waitFor();
    await button('Record Harvest').click();
    const stock = page.getByRole('group', { name: 'Stock balance' });
    const balance = (label, value) => stock.locator('dl > div').filter({ hasText: label }).getByText(value, { exact: true }).waitFor();
    await balance('Available from records', '100');
    await page.getByLabel('Harvested weight (kg)').fill('5');
    const fishCount = page.getByLabel(/^Number of fish harvested/);
    assert.equal(await fishCount.getAttribute('required'), '');
    await button('Save Record').click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(writes.length, 3);
    await fishCount.fill('40');
    await balance('Remaining after save', '60');
    await button('Save Record').click();
    await confirm('Save this partial harvest?', 'Save harvest');
    await page.locator('.swal2-toast.swal2-icon-success').getByText('Partial harvest saved.', { exact: true }).waitFor();
    await heading('Harvest Record Saved!').waitFor();
    assert.equal(writes.at(-1).body.confirmComplete, false);
    assert.equal(writes.at(-1).body.fishCount, 40);
    await page.getByText('60 fish', { exact: true }).waitFor();
    await button('Add Another Record').click();
    assert.equal(await page.getByLabel('Which fish group?').inputValue(), String(groupId));
    await balance('Available from records', '60');
    assert.equal(await fishCount.getAttribute('max'), '60');
    await button('Back to Fish Group').click();
    await page.getByRole('heading', { name: 'Saved Records' }).waitFor();

    await page.reload();
    await openGroup();
    await button('Record Fish Deaths').click();
    await balance('Available from records', '60');
    await page.getByLabel('Number of dead fish').fill('5');
    await balance('Remaining after save', '55');
    await button('Save Record').click();
    await confirm('Save this fish death record?', 'Save fish deaths');
    await page.locator('.swal2-toast.swal2-icon-success').getByText('Fish death record saved.', { exact: true }).waitFor();
    await balance('Available from records', '55');
    assert.match(writes.at(-1).path, /\/mortalities$/);
    await button('Cancel').click();
    await button('Record Harvest').click();
    await balance('Available from records', '55');
    await page.getByLabel('Harvested weight (kg)').fill('8');
    await fishCount.fill('56');
    await button('Save Record').click();
    assert.equal(await fishCount.evaluate(input => input.validity.rangeOverflow), true);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(writes.length, 5);
    await page.getByLabel(/Are you finishing this fish group/).selectOption('complete');
    await fishCount.fill('55');
    await button('Save Record').click();
    await confirm('Save harvest and close this fish group?', 'Cancel');
    assert.equal(writes.length, 5);
    await button('Save Record').click();
    await confirm('Save harvest and close this fish group?', 'Save and close group');
    await page.locator('.swal2-toast.swal2-icon-success').getByText('Harvest complete. Fish group closed.', { exact: true }).waitFor();
    await heading('Harvest Record Saved!').waitFor();
    assert.equal(writes.at(-1).body.confirmComplete, true);
    await button('View Harvest Records').click();
    await page.getByText('Filter records', { exact: true }).click();
    await page.getByLabel(/Fishpen \(including old records\)/).fill('Test Fishpen');
    await page.locator('.harvest-group-row').first().click();
    await button('Back to Records').click();
    assert.equal(await page.getByLabel(/Fishpen \(including old records\)/).inputValue(), 'Test Fishpen');
    await page.locator('.harvest-group-row').first().click();
    await button('Delete fish group').click();
    const remove = 'Delete this fish group?';
    await dialog(remove).getByText(/This cannot be undone/).waitFor();
    await confirm(remove, 'Cancel');
    assert.equal(writes.length, 6);
    await button('Delete fish group').click();
    await confirm(remove, 'Delete fish group');
    await page.locator('.swal2-toast.swal2-icon-success').getByText('Fish group deleted.', { exact: true }).waitFor();
    assert.equal(writes.length, 7);
    assert.equal(writes.at(-1).method, 'DELETE');
    await page.goto(new URL('/profile', process.env.PONDSENSE_BROWSER_URL || 'http://127.0.0.1:5177').href);
    await heading('Account & Settings').waitFor();
    await page.getByRole('alert').filter({ hasText: 'SMS settings could not be loaded.' }).waitFor();
    assert.equal(await page.getByRole('main').getByRole('button', { name: 'Logout' }).count(), 0);
    await page.locator('.farmer-nav').getByRole('button', { name: 'Logout' }).waitFor();
    assert.equal(await page.locator('.farmer-topbar').evaluate(el => getComputedStyle(el).backgroundColor),
      await page.locator('.farmer-nav').evaluate(el => getComputedStyle(el).backgroundColor));
    await page.setViewportSize({ width: 390, height: 900 });
    await button('More').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Logout' }).waitFor();
    console.log('Harvest counts 100 → 60 after reload → 55 after deaths, over-count validation, same group, older samples, back and filters, SweetAlerts, and profile navigation verified.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
