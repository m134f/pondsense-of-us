// Run against local Vite with PONDSENSE_PLAYWRIGHT pointing to a Playwright installation.
const { chromium } = require(process.env.PONDSENSE_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const output = 'outputs/manual-analysis-reference';
const widths = [320, 390, 768, 1024, 1440];
const values = { ph: 9, temperature: 35, dissolvedOxygen: 2, turbidity: 250 };

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({ serviceWorkers: 'block' });
    page.setDefaultTimeout(8_000);
    const button = name => page.getByRole('button', { name, exact: true });
    const comparison = page.getByRole('heading', { name: 'Fish suitability ranking', exact: true });
    const actions = page.getByRole('region', { name: 'Recommended actions', exact: true });
    let saveCount = 0;
    await page.route('**/api/**', async route => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (req.method() === 'POST') {
        assert.equal(path, '/api/readings');
        const input = req.postDataJSON();
        for (const [key, value] of Object.entries(values)) assert.equal(input[key], value);
        saveCount += 1;
        return route.fulfill({ json: { saved: true, session: { id: String(saveCount), inputMode: 'manual', timestamp: '11/23/2026, 8:00:00 AM', ...values, ammonia: null, bestFish: '', score: null } } });
      }
      const response = {
        '/api/session': { user: { id: 499, fullName: 'Test Owner', role: 'farmer', mustChangePassword: false }, fishpenAssignment: { id: 42, name: 'Test Fishpen', deviceId: 14 } },
        '/api/readings': { sessions: [] },
        '/api/sensors/latest': { telemetry: null },
        '/api/sensors/trend': { readings: [] }
      };
      return route.fulfill({ json: response[path] || {} });
    });
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('http://localhost:5175/analysis');
      for (const [key, value] of Object.entries(values)) await page.locator(`#manual-${key}`).fill(String(value));
      const beforeReview = saveCount;
      await button('Review measurements').click();
      assert.equal(saveCount, beforeReview);
      await page.getByRole('checkbox', { name: 'I have checked the measurements with warnings.' }).check();
      await button('Confirm and analyze').click();
      await page.getByText('4 of 4 measured', { exact: false }).waitFor();
      assert.equal(saveCount, beforeReview + 1);
      await page.evaluate(() => { window.scrollTo(0, 0); return document.fonts.ready; });
      const capture = lang => page.screenshot({
        path: `${output}/${lang}-${width}.png`, fullPage: true, animations: 'disabled',
        style: '.farmer-bottom-nav { visibility: hidden; }'
      });
      await capture('english');
      {
        const comparisonBox = await comparison.boundingBox();
        const actionsBox = await actions.boundingBox();
        assert.ok(comparisonBox.y < actionsBox.y, `ranking before actions at ${width}px`);
        if (width >= 970) assert.ok(comparisonBox.y < 900, 'desktop ranking is above the fold');
        if (width >= 970) {
          const summary = await page.getByRole('region', { name: /Water quality summary/ }).boundingBox();
          const form = await page.locator('form.manual-water-form').boundingBox();
          assert.equal(summary.y, form.y, 'form and summary align at the top');
          assert.ok(summary.width > form.width, 'summary column is wider');
          assert.ok(actionsBox.width >= summary.width + form.width, 'actions span both columns');
        }
        await page.getByText('No suitable fish identified from the measured parameters').waitFor();
        assert.equal(await page.getByText('0 of 4 measurements in range', { exact: true }).count(), 2);
        const headers = actions.getByRole('tab');
        assert.deepEqual(await headers.evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label'))), ['Dissolved Oxygen (DO), Critical', 'Turbidity, Critical', 'pH, Warning', 'Water Temperature, Warning']);
        const panel = actions.getByRole('tabpanel');
        assert.equal(await panel.count(), 1);
        assert.equal(await actions.getByRole('tab', { selected: true }).getAttribute('aria-label'), 'Dissolved Oxygen (DO), Critical');
        const oxygen = headers.first();
        await oxygen.focus();
        await page.keyboard.press('ArrowRight');
        const turbidity = headers.nth(1);
        assert.equal(await turbidity.getAttribute('aria-selected'), 'true');
        await page.getByText(/start manual aeration now/i).waitFor();
        await panel.getByText('References (2)').press('Enter');
        await actions.getByRole('link', { name: /USGS/ }).waitFor();
        await headers.last().click();
        assert.equal(await headers.last().getAttribute('aria-selected'), 'true');
        await headers.last().press('Home');
        assert.equal(await oxygen.getAttribute('aria-selected'), 'true');
        await panel.getByText('References (3)').press('Enter');
        await actions.getByRole('link', { name: /LLDA/ }).waitFor();
        await panel.getByText('References (3)').press('Space');
        await panel.getByText('Why does this matter?').press('Enter');
        await panel.getByText(/Manual Test in-range values/).waitFor();
        await panel.getByText('Why does this matter?').press('Space');
        const fish = page.locator('.manual-fish-row > summary').first();
        await fish.press('Enter');
        assert.equal(await page.locator('.manual-fish-row[open]').count(), 1);
        await page.locator('.manual-fish-row[open]').getByText('Outside range', { exact: false }).first().waitFor();
        await fish.press('Space');
        assert.equal(await page.locator('.manual-fish-row[open]').count(), 0);
        await fish.focus();
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.manual-fish-row + .manual-fish-row > summary')), true);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no overflow at ${width}px`);
        if (width <= 900) await button('More').click();
        await button('Filipino').click();
        if (width <= 900) await page.keyboard.press('Escape');
        await page.getByRole('heading', { name: 'Paunang ranggo ng mga isda' }).waitFor();
        await page.getByText('4 sa 4 nasukat', { exact: false }).waitFor();
        await page.getByRole('tab', { name: 'Natunaw na Oxygen (DO), Kritikal', selected: true }).waitFor();
        await page.getByText(/paandarin agad nang mano-mano/).first().waitFor();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no overflow in Filipino at ${width}px`);
        if (width === 390 || width === 1440) {
          await page.evaluate(() => window.scrollTo(0, 0));
          await capture('filipino');
        }
        if (width <= 900) await button('Iba pa').click();
        await button('English').click();
        if (width <= 900) await page.keyboard.press('Escape');
      }
      console.log(`Verified layout, tab controls, references, and language switching at ${width}px`);
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
