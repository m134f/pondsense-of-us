// Run with Vite on port 5175 and PONDSENSE_PLAYWRIGHT pointing to a Playwright installation.
const { chromium } = require(process.env.PONDSENSE_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, serviceWorkers: 'block' });
    const url = 'http://localhost:5175/dashboard';
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
      const latest = scenario === 'missing' ? null : {
        id: 44, deviceId: 14, deviceName: 'Test ESP32', sampledAt: timestamp, recordedAt: timestamp,
        receivedAt: new Date().toISOString(), rawValue: 2200, voltage: 2.5,
        ph: scenario === 'normal' ? 7.2 : 5, temperatureC: scenario === 'normal' ? 27 : 35,
        // The production endpoint does not supply DO; only this isolated browser fixture does.
        dissolvedOxygen: scenario === 'alerts' ? 2.4 : null,
        turbidityNtu: scenario === 'normal' ? null : 210
      };
      const responses = {
        '/api/session': { user: { id: 499, fullName: 'Test Owner', role: 'farmer', mustChangePassword: false }, fishpenAssignment: pen },
        '/api/sensors/latest': { telemetry: latest },
        '/api/sensors/trend': { readings: latest ? [latest] : [] },
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
      assert.deepEqual(await section.locator('article h3').allTextContents(), ['pH', 'Dissolved Oxygen (DO)', 'Water Temperature', 'Turbidity']);
      const oxygen = section.getByRole('article', { name: 'Dissolved Oxygen (DO)' });
      await oxygen.getByText(/do not wait for fish to gasp/i).waitFor();
      const disclosure = oxygen.getByText('Why am I seeing this?', { exact: true });
      await disclosure.focus();
      await page.keyboard.press('Enter');
      await oxygen.getByText(/Application guidance range/).waitFor();
      assert.equal(await oxygen.getByRole('link', { name: /LLDA/ }).getAttribute('href'), 'https://llda.gov.ph/presence-of-algal-bloom-in-selected-areas-of-laguna-de-bay/');
      await noOverflow();
      if (width === 390 || width === 1440) await section.screenshot({
        path: `${output}/monitoring-${width}.png`,
        style: '.farmer-topbar, .farmer-bottom-nav { visibility: hidden; }'
      });
    }
    await page.getByRole('button', { name: 'Filipino', exact: true }).click();
    await section.getByRole('heading', { name: 'Natunaw na Oxygen (DO)' }).waitFor();
    await section.getByText('Siyentipiko / Opisyal na Sanggunian', { exact: true }).first().waitFor();
    await noOverflow();
    await page.getByRole('button', { name: 'English', exact: true }).click();
    scenario = 'normal';
    await page.goto(url);
    await section.getByRole('heading', { name: 'Readings within the guidance range' }).waitFor();
    await section.getByText('Turbidity: No calibrated reading').waitFor();
    assert.equal(await section.getByRole('article').count(), 0);
    await section.getByText('Previous manual assessment', { exact: true }).click();
    await section.getByText('Based on a saved manual test, not the live sensor.').waitFor();
    for (scenario of ['stale', 'missing']) {
      await page.goto(url);
      await section.getByText('No live sensor recommendation is available.').waitFor();
      assert.equal(await section.getByRole('article').count(), 0);
    }
    assert.deepEqual(writes, []);
    console.log('Passed 5 viewport widths, keyboard disclosure, sources, language switch, simultaneous severities, normal, stale, and missing. No API writes.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
