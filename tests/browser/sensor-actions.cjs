// Run with Vite on port 5175 and PONDSENSE_PLAYWRIGHT pointing to a Playwright installation.
const { chromium } = require(process.env.PONDSENSE_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, serviceWorkers: 'block' });
    const url = (process.env.PONDSENSE_BROWSER_URL || 'http://localhost:5175') + '/dashboard';
    const output = 'outputs/sensor-actions';
    const pen = { id: 42, name: 'Test Fishpen', deviceId: 14 };
    const writes = [];
    let scenario = 'alerts';
    fs.mkdirSync(output, { recursive: true });
    await page.route('**/api/**', async route => {
      const request = route.request();
      if (request.method() !== 'GET') {
        writes.push(request.url());
        return route.abort();
      }
      const timestamp = new Date(Date.now() - (scenario === 'stale' ? 20_000 : 500)).toISOString();
      const shared = ['unassigned', 'assigned-waiting', 'assigned-live', 'assigned-offline'].includes(scenario);
      const offline = scenario === 'assigned-offline';
      const fishComparison = ['fish-comparison', 'calibrated-safe', 'calibrated-warning'].includes(scenario);
      const latest = ['missing', 'unassigned', 'assigned-waiting'].includes(scenario) ? null : {
        id: 44, deviceId: 14, deviceName: 'Test ESP32', sampledAt: timestamp, recordedAt: timestamp,
        receivedAt: new Date().toISOString(), rawValue: fishComparison ? 1900 : 2200,
        voltage: ['extrapolated', 'stale'].includes(scenario) ? 1.602 : scenario === 'estimate-critical' ? 0.5 : scenario === 'invalid-turbidity' ? 3.3 : 2.5,
        ph: fishComparison ? 8.28 : scenario === 'normal' ? 7.2 : 5,
        temperatureC: fishComparison ? 26.1 : scenario === 'normal' ? 27 : 35,
        // The three-sensor firmware omits DO. A separate fixture exercises guidance for measured DO.
        dissolvedOxygen: scenario === 'alerts' ? 2.4 : null,
        turbidityNtu: scenario === 'calibrated-safe' ? 50 : scenario === 'calibrated-warning' ? 134 : ['normal', 'fish-comparison', 'extrapolated', 'stale', 'estimate-critical', 'custom-rule', 'invalid-turbidity'].includes(scenario) ? null : 210
      };
      if (latest && offline) {
        latest.sampledAt = latest.recordedAt = latest.receivedAt = new Date(Date.now() - 90_000).toISOString();
      }
      const responses = {
        '/api/session': { user: { id: 499, fullName: 'Test Owner', role: 'farmer', mustChangePassword: false }, fishpenAssignment: pen },
        '/api/sensors/latest': { telemetry: latest, ...(shared ? { hardwareAssigned: scenario !== 'unassigned' } : {}) },
        '/api/sensors/trend': { readings: latest ? [latest] : [] },
        '/api/turbidity-alert-rule': { rule: { warningFrom: scenario === 'custom-rule' ? 20 : 25, criticalAbove: 100, approval: 'pending' } },
        '/api/readings': { sessions: [] },
        '/api/recommendations': { recommendations: [{ parameter: 'ph', value: 4.8, source: 'manual', recordedAt: timestamp, state: 'critical', priority: 'URGENT', range: [6.5, 8.5], rule: 'test-fixture' }], reference: 'Application reference ranges' },
        '/api/recommendations/history': { history: [] }
      };
      return route.fulfill({ json: responses[new URL(request.url()).pathname] ?? {} });
    });
    const section = page.locator('#farmer-recommended-actions');
    const noOverflow = async () => assert.equal(await section.evaluate(el =>
      document.documentElement.scrollWidth <= innerWidth &&
      Array.from(el.querySelectorAll('article, article dt, article dd, article li')).every(node => node.scrollWidth <= node.clientWidth + 1)
    ), true);
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 920 });
      await page.goto(url);
      const ph = section.getByRole('article', { name: 'pH' });
      await ph.getByText('Critical', { exact: true }).waitFor();
      assert.deepEqual(await section.locator('article h3').allTextContents(), ['pH', 'Dissolved Oxygen (DO)', 'Water Temperature']);
      const oxygen = section.getByRole('article', { name: 'Dissolved Oxygen (DO)' });
      await oxygen.getByText(/do not wait for fish to gasp/i).waitFor();
      const disclosure = oxygen.getByText('Why am I seeing this?', { exact: true });
      await disclosure.focus();
      await page.keyboard.press('Enter');
      await oxygen.getByText(/Application guidance range/).waitFor();
      assert.equal(await oxygen.getByRole('link', { name: /LLDA/ }).getAttribute('href'), 'https://llda.gov.ph/presence-of-algal-bloom-in-selected-areas-of-laguna-de-bay/');
      await noOverflow();
      if (!process.env.PONDSENSE_BROWSER_SKIP_SCREENSHOTS && (width === 390 || width === 1440)) await section.screenshot({
        path: `${output}/monitoring-${width}.png`,
        style: '.farmer-topbar, .farmer-bottom-nav { visibility: hidden; }'
      });
    }
    await page.getByRole('button', { name: 'Filipino', exact: true }).click();
    await section.getByRole('heading', { name: 'Natunaw na Oxygen (DO)' }).waitFor();
    await section.getByText('Siyentipiko / Opisyal na Sanggunian', { exact: true }).first().waitFor();
    await noOverflow();
    await page.getByRole('button', { name: 'English', exact: true }).click();
    scenario = 'three-sensor';
    await page.goto(url);
    await section.getByRole('article', { name: 'pH', exact: true }).waitFor();
    assert.equal(await section.getByRole('article', { name: 'Dissolved Oxygen (DO)' }).count(), 0);
    await page.locator('.monitor-metric').filter({ has: page.getByRole('heading', { name: 'Dissolved oxygen', exact: true }) })
      .getByText('Missing', { exact: true }).waitFor();
    scenario = 'normal';
    await page.goto(url);
    await section.getByRole('heading', { name: 'Readings within the guidance range' }).waitFor();
    await section.getByText('Turbidity: No calibrated reading').waitFor();
    assert.equal(await section.getByRole('article').count(), 0);
    await section.getByText('Previous manual assessment', { exact: true }).click();
    await section.getByText('Based on a saved manual test, not the live sensor.').waitFor();

    const comparison = page.getByRole('complementary', { name: 'Preliminary fish comparison' });
    const analyze = comparison.getByRole('button', { name: 'Analyze', exact: true });
    const turbidity = page.locator('.monitor-metric').filter({ has: page.getByRole('heading', { name: 'Turbidity', exact: true }) });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 920 });
      scenario = 'fish-comparison';
      await page.goto(url);
      await turbidity.getByText('~22.50 NTU', { exact: true }).waitFor();
      await turbidity.getByText('Provisional: Safe', { exact: true }).waitFor();
      assert.deepEqual(await turbidity.locator(':scope > *').allTextContents(), ['Turbidity', '~22.50 NTU', 'Provisional: Safe']);
      assert.equal(await turbidity.getByText(/^(Safe|Warning|Critical)$/).count(), 0);
      assert.equal(await comparison.getByRole('heading', { level: 3 }).count(), 0);
      await analyze.focus();
      await page.keyboard.press('Enter');
      await comparison.getByRole('heading', { name: 'Bangus (Milkfish)', exact: true }).waitFor();
      assert.equal(await comparison.getByRole('heading', { level: 3 }).count(), 1);
      await comparison.getByText('2 of 2 measured values in range', { exact: true }).waitFor();
      await comparison.getByText(/Top fish are tied/).waitFor();
      await comparison.getByText('Measurements and ranges', { exact: true }).click();
      await comparison.getByText('Uncalibrated turbidity is excluded.', { exact: true }).waitFor();
      assert.equal(await page.getByText('Voltage-to-NTU calculator', { exact: true }).count(), 0);
      await noOverflow();
    }
    await page.getByRole('button', { name: 'Filipino', exact: true }).click();
    const translated = page.getByRole('complementary', { name: 'Paunang paghahambing ng isda' });
    await translated.getByRole('button', { name: 'Suriin', exact: true }).waitFor();
    await translated.getByText(/Tabla ang mga nanguna/).waitFor();
    await page.locator('.monitor-metric').filter({ has: page.getByRole('heading', { name: 'Labo ng tubig', exact: true }) })
      .getByText('Paunang: Ligtas', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'English', exact: true }).click();
    scenario = 'extrapolated';
    await page.goto(url);
    await turbidity.getByText('~61.79 NTU', { exact: true }).waitFor();
    await turbidity.getByText('Provisional: Warning', { exact: true }).waitFor();
    assert.equal(await turbidity.locator('strong').getAttribute('title'), 'Extrapolated · Live');
    scenario = 'estimate-critical';
    await page.goto(url);
    await turbidity.getByText('Provisional: Critical', { exact: true }).waitFor();
    assert.equal(await section.getByRole('article', { name: 'Turbidity' }).count(), 0);
    scenario = 'custom-rule';
    await page.goto(url);
    await turbidity.getByText('~22.50 NTU', { exact: true }).waitFor();
    await turbidity.getByText('Provisional: Warning', { exact: true }).waitFor();
    scenario = 'invalid-turbidity';
    await page.goto(url);
    await turbidity.getByText('Invalid result', { exact: true }).waitFor();
    assert.equal(await turbidity.getByText(/^Provisional:/).count(), 0);
    scenario = 'calibrated-safe';
    await page.goto(url);
    await turbidity.getByText('50.00 NTU', { exact: true }).waitFor();
    await turbidity.getByText('Provisional: Warning', { exact: true }).waitFor();
    scenario = 'calibrated-warning';
    await page.goto(url);
    await turbidity.getByText('134.00 NTU', { exact: true }).waitFor();
    await turbidity.getByText('Provisional: Critical', { exact: true }).waitFor();
    scenario = 'alerts';
    await page.goto(url);
    await turbidity.getByText('Provisional: Critical', { exact: true }).waitFor();
    await section.getByText('Turbidity: Not assessed', { exact: true }).waitFor();
    for (scenario of ['stale', 'missing']) {
      await page.goto(url);
      await section.getByText('No live sensor recommendation is available.').waitFor();
      assert.equal(await section.getByRole('article').count(), 0);
      if (scenario === 'stale') {
        assert.equal(await turbidity.locator('strong').getAttribute('title'), 'Extrapolated · Stale');
        await turbidity.getByText('Provisional: Warning', { exact: true }).waitFor();
        await comparison.getByText('Waiting for fresh sensor readings.').waitFor();
        assert.equal(await analyze.isEnabled(), false);
      } else assert.equal(await turbidity.getByText(/^Provisional:/).count(), 0);
    }
    const overview = page.getByRole('region', { name: 'Current measurements' });
    const deviceStatus = overview.locator('.monitor-summary-card').filter({ hasText: 'Device Status' });
    scenario = 'unassigned';
    await deviceStatus.getByText('Unassigned', { exact: true }).waitFor({ timeout: 12_000 });
    scenario = 'assigned-waiting';
    await deviceStatus.getByText('No upload yet', { exact: true }).waitFor({ timeout: 12_000 });
    scenario = 'assigned-live';
    await deviceStatus.getByText(/Test ESP32.*Online/).waitFor({ timeout: 12_000 });
    await overview.locator('.monitor-metric').filter({ has: page.getByRole('heading', { name: 'Dissolved oxygen', exact: true }) })
      .getByText('Missing', { exact: true }).waitFor();
    scenario = 'assigned-offline';
    await deviceStatus.getByText(/Test ESP32.*Offline/).waitFor({ timeout: 12_000 });
    scenario = 'unassigned';
    await deviceStatus.getByText('Unassigned', { exact: true }).waitFor({ timeout: 12_000 });
    assert.equal(await overview.getByText(/Test ESP32/).count(), 0);
    assert.deepEqual(writes, []);
    console.log('Passed 5 viewport widths, single fish analysis, turbidity badges, recommendation states, missing DO, and the shared hardware lifecycle without page reloads. No API writes.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
