// Run against local Vite with PONDSENSE_PLAYWRIGHT pointing to Playwright.
const { chromium } = require(process.env.PONDSENSE_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const output = 'outputs/water-quality-trends';
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({ serviceWorkers: 'block' });
    page.setDefaultTimeout(8_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const trend = page.locator('.water-quality-trends');
    const card = key => trend.locator(`section[aria-labelledby="water-trend-${key}"]`);
    const day = 86_400_000;
    const now = Date.now();
    const iso = age => new Date(now - age).toISOString();
    // Isolated API fixtures used only for assertions, never for screenshot output or database writes.
    const sample = (id, age, ph, temperatureC, turbidityNtu) => ({
      id, deviceId: 14, deviceName: 'ESP32', sampledAt: iso(age), receivedAt: iso(age),
      recordedAt: iso(age), ph, temperatureC, turbidityNtu, rawValue: 2000
    });
    const rows = [
      sample(1, 12 * day, 7.2, 27, 60), sample(2, 3 * day, 7.3, 27, 65),
      sample(3, 245_000, 7.1, 27.4, 80), sample(4, 235_000, 7.3, 27.7, 88),
      sample(5, 225_000, null, 28.4, null), sample(6, 215_000, 7.8, 29, 100),
      sample(7, 205_000, 7.6, 32, 120), { ...sample(8, 1000, 13, 45, 600), sampledAt: null }
    ];
    let fixture = 'empty';
    const requests = [];
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      requests.push(request.method());
      assert.equal(request.method(), 'GET');
      if (path === '/api/sensors/trend') {
        if (fixture === 'loading') await new Promise(resolve => setTimeout(resolve, 350));
        if (fixture === 'error') return route.fulfill({ status: 503, json: {} });
        return route.fulfill({ json: { readings: fixture === 'records' || fixture === 'stale' ? rows : [] } });
      }
      const response = {
        '/api/session': { user: { id: 499, fullName: 'Test Owner', role: 'farmer', mustChangePassword: false }, fishpenAssignment: { id: 42, name: 'Test Fishpen', deviceId: 14 } },
        '/api/sensors/latest': { telemetry: fixture === 'records' ? rows[6] : fixture === 'stale' ? sample(9, Date.now() - now + 20_000, null, null, null) : null },
        '/api/readings': { sessions: [] }
      };
      return route.fulfill({ json: response[path] ?? {} });
    });
    const go = () => page.goto('http://localhost:5175/dashboard');
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await go();
      await trend.getByText('No historical readings yet').first().waitFor();
      assert.equal(await trend.getByRole('heading', { level: 3 }).count(), 4);
      await card('dissolvedOxygen').getByText('Min 5', { exact: true }).waitFor();
      const phBox = await card('ph').boundingBox(), doBox = await card('dissolvedOxygen').boundingBox();
      assert.equal(phBox.y === doBox.y, width >= 720);
      assert.ok(await trend.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth));
      if (width === 390 || width === 1440) {
        await trend.scrollIntoViewIfNeeded();
        await card('temperature').getByText('Max 31', { exact: true }).waitFor();
        const clip = await trend.evaluate(el => {
          const { x, y, width, height } = el.getBoundingClientRect();
          return { x: x + scrollX, y: y + scrollY, width, height };
        });
        await page.screenshot({
          path: `${output}/${width === 390 ? 'mobile' : 'desktop'}.png`,
          fullPage: true, clip,
          style: '.farmer-topbar, .farmer-bottom-nav { visibility: hidden; }'
        });
      }
    }
    fixture = 'loading';
    await go();
    await trend.getByRole('status').getByText('Loading historical readings...').or(trend.getByRole('status').filter({ hasText: 'Loading historical readings...' })).first().waitFor();
    await trend.getByText('No historical readings yet').first().waitFor();
    fixture = 'error';
    await go();
    await trend.getByText('Could not load historical readings.').waitFor();
    fixture = 'records';
    await trend.getByRole('button', { name: 'Try again' }).click();
    await trend.getByText('5 samples in this period.', { exact: false }).waitFor();
    await go();
    await trend.getByText('Device offline. Showing recorded history.').waitFor();
    await trend.getByText('1 sample omitted', { exact: false }).waitFor();
    await card('ph').getByText('Within reference range', { exact: true }).waitFor();
    await card('temperature').getByText('Above reference range', { exact: true }).waitFor();
    await card('turbidity').getByText('No DENR NTU limit in Table 3', { exact: true }).waitFor();
    assert.equal(await card('turbidity').locator('.recharts-reference-line').count(), 0);
    assert.equal(await card('dissolvedOxygen').locator('.recharts-line-dot').count(), 0);
    assert.equal(await card('ph').locator('path.recharts-line-curve').count(), 2);
    const phChart = card('ph').locator('svg.recharts-surface[tabindex="0"]');
    await phChart.focus();
    await page.keyboard.press('ArrowRight');
    await card('ph').locator('.water-trend-tooltip').getByText(/pH: 7\.1|pH: 7\.3/).waitFor();
    await card('ph').getByText('View readings', { exact: true }).press('Enter');
    await card('ph').getByText('Missing or invalid', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 900 });
    await card('ph').locator('path.recharts-line-curve').first().waitFor();
    assert.ok(await trend.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 1440, height: 900 });
    await trend.getByRole('button', { name: 'Temperature', exact: true }).click();
    assert.equal(await trend.getByRole('heading', { level: 3 }).count(), 1);
    const range = trend.getByRole('combobox', { name: 'Time range' });
    await range.selectOption('7');
    await trend.getByText('6 samples in this period.', { exact: false }).waitFor();
    await range.selectOption('30');
    await trend.getByText('7 samples in this period.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Filipino', exact: true }).click();
    await trend.getByRole('combobox', { name: 'Saklaw ng petsa' }).waitFor();
    await trend.getByText('7 tala sa panahong ito.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'English', exact: true }).click();
    fixture = 'stale';
    await go();
    await trend.getByText(/The latest sample is stale/).waitFor();
    assert.deepEqual(errors, []);
    assert.ok(requests.length > 0);
    console.log('Passed five viewports, empty-state captures, loading/error/retry, offline/stale, filters, guidelines, gaps, and keyboard tooltips. No API writes.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
