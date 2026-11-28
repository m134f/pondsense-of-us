// Local-only fixture browser check. No synthetic readings are used in screenshots.
const { chromium } = require(process.env.PONDSENSE_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const base = new URL(process.env.PONDSENSE_BROWSER_URL || 'http://127.0.0.1:5181');
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block', hasTouch: true });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const now = Date.now();
    await page.clock.setFixedTime(new Date(now));
    const day = 86_400_000;
    const sample = (id, age, fields = {}) => {
      const time = new Date(now - age).toISOString();
      return { id, deviceId: 14, deviceName: 'Fixture ESP32', assignmentId: 'fixture-14', recordedAt: time, receivedAt: time, sampledAt: time,
        ph: 7.2, temperatureC: 27.4, dissolvedOxygen: 6.2, turbidityNtu: 30, rawValue: 2000, ...fields };
    };
    const records = [
      sample(1, 12 * day), sample(2, 3 * day),
      sample(3, 245000), sample(4, 235000, { ph: 7.4, temperatureC: 27.6, turbidityNtu: 36 }),
      sample(5, 225000, { ph: null, dissolvedOxygen: null, turbidityNtu: null }),
      sample(6, 215000), sample(7, 205000, { ph: 7.6 }),
      sample(8, 1100, { sampledAt: null, ph: 13 })
    ];
    let fixture = 'empty';
    await page.route('**/api/**', route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      assert.equal(request.method(), 'GET');
      if (path === '/api/sensors/trend' && fixture === 'error') return route.fulfill({ status: 503, json: {} });
      const latest = fixture === 'partial' ? sample(9, 1000, { dissolvedOxygen: null, turbidityNtu: null, voltage: 0.5 })
        : fixture === 'critical' ? sample(10, 1000, { dissolvedOxygen: 2 })
          : fixture === 'full' ? sample(11, 1000) : fixture === 'records' ? records[6] : null;
      const responses = {
        '/api/session': { user: { id: 499, fullName: 'Test Owner', role: 'farmer', mustChangePassword: false }, fishpenAssignment: { id: 42, name: 'Test Fishpen', deviceId: 14 } },
        '/api/sensors/latest': { telemetry: latest },
        '/api/sensors/trend': { readings: fixture === 'records' ? records : [] },
        '/api/turbidity-alert-rule': { rule: { warningFrom: 25, criticalAbove: 100, approval: 'pending' } },
        '/api/readings': { sessions: [] }
      };
      return route.fulfill({ json: responses[path] ?? {} });
    });
    const go = () => page.goto(new URL('/dashboard', base).href);
    const trend = page.getByRole('region', { name: 'Water Quality Trends' });
    const fish = page.getByRole('region', { name: 'Analyze Fish Suitability' });
    const analyze = fish.getByRole('button', { name: 'Analyze', exact: true });
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    const text = (root, value) => root.getByText(value, { exact: true }).waitFor();
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await go();
      await text(trend, 'No historical readings yet');
      assert.equal(await page.locator('.dashboard-monitor-grid article').count(), 4);
      assert.ok(await analyze.isDisabled());
      assert.ok(await noOverflow());
    }
    fixture = 'error';
    await go();
    await text(trend, 'Historical readings unavailable.');
    fixture = 'records';
    await trend.getByRole('button', { name: 'Try again' }).click();
    await text(trend, '5 samples · PHT · Independent scales');
    await trend.getByText('1 untimed samples omitted').waitFor();
    const chart = trend.locator('svg.recharts-surface[tabindex="0"]');
    await chart.waitFor();
    assert.equal(await chart.count(), 1);
    assert.ok(await chart.locator('.recharts-line-curve').count() >= 4);
    await chart.focus();
    await page.keyboard.press('ArrowRight');
    await trend.locator('.dashboard-trend-tooltip').getByText(/27\.[46] °C/).waitFor();
    const plot = await chart.boundingBox();
    await page.touchscreen.tap(plot.x + plot.width / 2, plot.y + plot.height / 2);
    await trend.locator('.dashboard-trend-picked').getByText(/°C/).waitFor();
    await trend.getByText('View readings', { exact: true }).click();
    await trend.getByText('Uncalibrated', { exact: true }).first().waitFor();
    const ph = trend.getByRole('button', { name: 'pH', exact: true });
    await ph.click();
    assert.equal(await ph.getAttribute('aria-pressed'), 'false');
    await ph.click();
    assert.equal(await ph.getAttribute('aria-pressed'), 'true');
    await trend.getByRole('button', { name: '7 Days' }).click();
    await text(trend, '6 samples · PHT · Independent scales');
    await trend.getByRole('button', { name: '30 Days' }).click();
    await text(trend, '7 samples · PHT · Independent scales');
    await page.setViewportSize({ width: 390, height: 900 });
    assert.ok(await noOverflow());
    fixture = 'partial';
    await go();
    await page.getByText('Provisional: Critical', { exact: true }).waitFor();
    await analyze.click();
    await text(fish, 'Preliminary match');
    await fish.getByText(/Missing: Dissolved Oxygen, Turbidity/).waitFor();
    assert.ok(await fish.getByRole('progressbar').count() >= 2);
    await page.waitForFunction(() => [...document.querySelectorAll('.dashboard-fish-list img')].every(img => img.complete && img.naturalWidth > 0));
    assert.ok(await noOverflow());
    fixture = 'full';
    await go();
    await analyze.click();
    await text(fish, 'Tied best match');
    await fish.getByText(/4\/4 parameters measured/).waitFor();
    fixture = 'critical';
    await go();
    await text(fish, 'No recommendation');
    await text(fish, 'Confirmed critical: Dissolved Oxygen');
    await analyze.click();
    assert.equal(await fish.getByRole('progressbar').count(), 0);
    assert.deepEqual(errors, []);
    console.log('Combined chart, time filters, keyboard values and units, gaps, responsive layout, incomplete ranking, ties and critical blocking passed. No writes.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
