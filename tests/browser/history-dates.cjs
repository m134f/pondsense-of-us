const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require(process.env.PONDSENSE_PLAYWRIGHT || 'playwright');

const base = new URL(process.env.PONDSENSE_BROWSER_URL || 'http://127.0.0.1:5180');
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', timezoneId: 'America/Los_Angeles' });
    page.setDefaultTimeout(10000);
    await page.clock.setFixedTime(new Date('2026-11-27T16:03:00Z'));
    const reading = (id, recordedAt, day, timestamp, inputMode, ph) => ({
      day, id, recordedAt, timestamp, inputMode, ph,
      temperature: null, dissolvedOxygen: null, turbidity: null, ammonia: null, bestFish: '', score: null
    });
    const today = reading('1', '2026-11-27T16:00:00Z', '2026-11-28', '11/28/2026, 12:00:00 AM', 'manual', 7.2);
    const previous = reading('sensor-1', '2026-11-27T15:59:59Z', '2026-11-27', '11/27/2026, 11:59:59 PM', 'sensor', 9.1);
    const legacy = reading('2', undefined, '2026-11-18', '11/18/2026, 8:00:00 AM', 'manual', 7.4);
    const old = reading('3', '2026-09-03T04:00:00Z', '2026-09-03', '9/3/2026, 12:00:00 PM', 'manual', 7.3);
    const recent = [today, previous, legacy];
    const requests = [];
    let failFirstOldRequest = true;
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/readings') {
        const from = url.searchParams.get('from'), to = url.searchParams.get('to');
        if (!from) return route.fulfill({ json: { sessions: recent } });
        requests.push([from, to]);
        if (from === old.day && failFirstOldRequest) {
          failFirstOldRequest = false;
          return route.fulfill({ status: 503, json: {} });
        }
        return route.fulfill({ json: { sessions: [...recent, old].filter(row => from <= row.day && row.day <= to) } });
      }
      const responses = {
        '/api/session': { user: { id: 11, fullName: 'History Farmer', role: 'farmer', mustChangePassword: false }, fishpenAssignment: { id: 5, name: 'Fixture Pen', deviceId: null } },
        '/api/sensors/latest': { telemetry: null },
        '/api/sensors/trend': { readings: [] }
      };
      return route.fulfill({ json: responses[url.pathname] ?? {} });
    });
    const status = text => page.getByText(text, { exact: true }).waitFor();
    const period = page.getByLabel('Date range (PHT)', { exact: true });
    const exportButton = page.getByRole('button', { name: 'Export CSV' });
    await page.goto(new URL('/history', base).href);
    await status('3 of 3 records shown');
    await period.selectOption('today');
    await status('1 of 1 records shown');
    assert.deepEqual(requests.at(-1), ['2026-11-28', '2026-11-28']);
    await period.selectOption('month');
    await status('3 of 3 records shown');
    assert.deepEqual(requests.at(-1), ['2026-10-30', '2026-11-28']);
    await period.selectOption('week');
    await status('2 of 2 records shown');
    assert.deepEqual(requests.at(-1), ['2026-11-22', '2026-11-28']);
    await page.getByLabel('Filter by source').selectOption('sensor');
    await page.getByLabel('Filter by status').selectOption('critical');
    await status('1 of 2 records shown');
    const download = page.waitForEvent('download');
    await exportButton.click();
    const csv = await fs.readFile(await (await download).path(), 'utf8');
    assert.ok(csv.includes(previous.timestamp));
    assert.ok(!csv.includes(today.timestamp) && !csv.includes(legacy.timestamp));

    await page.setViewportSize({ width: 320, height: 900 });
    await page.getByLabel('Filter by source').selectOption('all');
    await page.getByLabel('Filter by status').selectOption('all');
    await period.selectOption('custom');
    await page.getByLabel('From (PHT)', { exact: true }).fill('2026-09-04');
    await page.getByLabel('To (PHT)', { exact: true }).fill('2026-09-03');
    await status('The start date must be on or before the end date.');
    assert.equal(await exportButton.isDisabled(), true);
    assert.equal(requests.length, 3);
    await page.getByLabel('From (PHT)', { exact: true }).fill('2026-09-03');
    await status('Could not load records for the selected dates.');
    await page.getByRole('button', { name: 'Try again' }).click();
    await status('1 of 1 records shown');
    await page.getByRole('heading', { name: old.timestamp, exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await period.selectOption('all');
    await status('3 of 3 records shown');
    console.log('History date presets, old custom dates, failed-range retry, Philippine midnight, combined filters, filtered CSV, and mobile layout passed.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
