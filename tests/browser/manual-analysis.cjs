// Run with Vite on port 5175 and PONDSENSE_PLAYWRIGHT pointing to a Playwright installation.
const { chromium } = require(process.env.PONDSENSE_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
    const saved = new Map();
    const posts = [];
    let loseResponse = true;
    await page.route('**/api/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (req.method() !== 'GET') {
        posts.push({ path, body: req.postDataJSON() });
        assert.equal(path, '/api/readings', 'manual test must not call other write endpoints');
        const { manualSaveTime, ...values } = posts.at(-1).body;
        const key = JSON.stringify([manualSaveTime, values]);
        if (!saved.has(key)) saved.set(key, { id: String(saved.size + 1), inputMode: 'manual', timestamp: '11/22/2026, 8:00:00 AM', ph: null, temperature: null, dissolvedOxygen: null, turbidity: null, ammonia: null, bestFish: '', score: null, ...values });
        if (loseResponse) { loseResponse = false; return route.abort(); }
        return route.fulfill({ json: { saved: true, session: saved.get(key) } });
      }
      const responses = {
        '/api/session': { user: { id: 499, fullName: 'Test Owner', role: 'farmer', mustChangePassword: false }, fishpenAssignment: { id: 42, name: 'Test Fishpen', deviceId: 14 } },
        '/api/readings': { sessions: [...saved.values()] },
        '/api/sensors/latest': { telemetry: null },
        '/api/sensors/trend': { readings: [] }
      };
      return route.fulfill({ json: responses[path] ?? {} });
    });
    const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const button = name => page.getByRole('button', { name, exact: true });
    const field = pattern => page.getByRole('textbox', { name: pattern });
    const review = async () => {
      await button('Review measurements').click();
      await page.getByText('Review the measurements above before continuing.').waitFor();
      const warnings = page.getByRole('checkbox', { name: 'I have checked the measurements with warnings.' });
      if (await warnings.count()) await warnings.check();
    };
    await page.goto('http://localhost:5175/analysis');
    await field(/^pH$/).fill('7.2');
    await button('Clear').click();
    assert.equal(await field(/^pH$/).inputValue(), '');
    assert.equal(posts.length, 0);
    await field(/^pH$/).fill('15');
    await button('Review measurements').click();
    await page.getByText(/Enter a number between 0 - 14/).waitFor();
    await field(/^pH$/).fill('9');
    await field(/^Temperature/).fill('35');
    await review();
    assert.equal(posts.length, 0);
    await page.locator('form').filter({ hasText: 'Manual water analysis' }).evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await page.getByText('Could not confirm the save. Please try again.').waitFor();
    assert.equal(posts.length, 1);
    await button('Confirm and analyze').click();
    await page.getByText('2 of 4 measured').waitFor();
    assert.deepEqual(posts[0], posts[1]);
    assert.equal(saved.size, 1);
    assert.equal(Object.hasOwn(posts[1].body, 'dissolvedOxygen'), false);
    assert.equal(Object.hasOwn(posts[1].body, 'turbidity'), false);
    await page.getByText('No suitable fish identified from the measured parameters').waitFor();
    assert.equal(await page.getByText('0 of 2 measurements in range').count(), 2);
    assert.equal(await page.getByText(/Top measured fit/).count(), 0);
    const phAction = page.getByRole('article', { name: 'pH' });
    await phAction.getByText('Why does this matter?').press('Enter');
    await page.getByText(/Manual Test in-range values/).first().waitFor();
    await noOverflow();
    await button('Start another test').click();
    assert.equal(await field(/^pH$/).inputValue(), '');
    await field(/^pH$/).fill('7.2');
    await field(/^Temperature/).fill('27');
    await field(/^Dissolved Oxygen/).fill('0');
    await field(/^Calibrated Turbidity/).fill('210');
    await review();
    assert.equal(posts.length, 2);
    await button('Confirm and analyze').click();
    await page.getByText('4 of 4 measured').waitFor();
    assert.equal(posts[2].body.dissolvedOxygen, 0);
    assert.equal(posts[2].body.turbidity, 210);
    const oxygenAction = page.getByRole('article', { name: 'Dissolved Oxygen (DO)' });
    await oxygenAction.getByText('References (3)').press('Enter');
    await oxygenAction.getByRole('link', { name: /LLDA/ }).waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });
    await button('Filipino').click();
    await page.getByText('4 sa 4 nasukat').waitFor();
    await noOverflow();
    await button('English').click();
    await button('Monitoring').click();
    await page.getByText('No live sensor recommendation is available.').waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Water quality summary' }).count(), 0);
    assert.equal(posts.length, 3);
    console.log('Passed manual test at mobile/desktop widths with review-only validation, duplicate submission guard, lost-response retry, missing/zero values, no-match ranking, sources, Filipino, and Monitoring separation.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
