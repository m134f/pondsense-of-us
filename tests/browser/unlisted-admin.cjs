const assert = require('node:assert/strict');
const config = require('../../vercel.json');
const { chromium } = require(process.env.PONDSENSE_PLAYWRIGHT || 'playwright');

const base = process.env.PONDSENSE_BROWSER_URL || 'http://localhost:5175';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const robots = 'noindex, nofollow';
const header = config.headers.find(rule => rule.source === '/admin/:path*');
assert.ok(header?.headers.some(({ key, value }) => key === 'X-Robots-Tag' && value === robots));
const farmer = { id: 2, fullName: 'Fixture Farmer', phone: '+639111111111', role: 'farmer', mustChangePassword: false };
const session = { user: farmer, fishpenAssignment: { id: 1, name: 'Fixture Fishpen', deviceId: null } };
const challenge = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

async function check(channel, viewport, mobile = false) {
  const browser = await chromium.launch({ channel });
  try {
    const page = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
    let farmerLoggedIn = false;
    let rejectedStatus = 401;
    let verifyRequests = 0;
    let optionsRequests = 0;
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const json = (body, status = 200) => route.fulfill({ status, json: body });
      switch (path) {
        case '/api/admin/session': return json({ message: 'Admin session required.' }, rejectedStatus);
        case '/api/admin/login': {
          const { preparePasskey } = route.request().postDataJSON();
          return json({ token: 'fixture-only', webauthnRequired: true, ...(preparePasskey ? { options: { challenge, rpId: new URL(base).hostname, userVerification: 'required' } } : {}) });
        }
        case '/api/admin/security/authenticate/options':
          ++optionsRequests;
          return json({ options: { challenge, rpId: new URL(base).hostname, userVerification: 'required' } });
        case '/api/admin/security/enroll/request': return json({ requested: true });
        case '/api/admin/security/enroll/options':
          ++optionsRequests;
          return json({ options: { challenge, rp: { id: new URL(base).hostname, name: 'Fixture' }, user: { id: 'AQ', name: 'fixture', displayName: 'Fixture' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] } });
        case '/api/admin/security/authenticate/verify':
        case '/api/admin/security/enroll/verify':
          ++verifyRequests;
          return json({ verified: false }, 400);
        case '/api/login':
          farmerLoggedIn = true;
          return json({ user: farmer });
        case '/api/session':
          return farmerLoggedIn ? json(session) : json({ message: 'Sign in required.' }, 401);
        default: return json({});
      }
    });
    await page.addInitScript(() => {
      const reject = async () => { throw new DOMException('Fixture passkey denied', 'NotAllowedError'); };
      Object.defineProperties(navigator.credentials, { get: { value: reject }, create: { value: reject } });
    });
    const go = path => page.goto(base + path);
    const adminLogin = page.getByRole('heading', { name: 'Admin Login' });
    const noIndex = page.locator('head meta[name="robots"]');
    const noAdminOnFarmer = async () => {
      assert.equal(await noIndex.count(), 0);
      assert.equal(await page.locator('a[href^="/admin"], a[href*="/admin/login"]').count(), 0);
      assert.equal(await page.getByText('Admin Login', { exact: true }).count(), 0);
    };
    const fillAdminLogin = async () => {
      await page.getByLabel('Admin password').fill('fixture-password');
      await page.getByLabel('Admin PIN').fill('0000');
    };

    assert.equal((await go('/admin/login')).status(), 200);
    await adminLogin.waitFor();
    await noIndex.waitFor({ state: 'attached' });
    assert.equal(await noIndex.getAttribute('content'), robots);
    const card = await page.locator('.admin-access-card').boundingBox();
    assert.ok(card && card.x >= 0 && card.x + card.width <= viewport.width + 1);
    await fillAdminLogin();
    await page.getByRole('button', { name: 'Login to Admin' }).click();
    await page.getByRole('alert').filter({ hasText: 'Use an enrolled passkey' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Verify this authorized device' }).count(), 0);
    assert.equal(await page.getByText('Set up or recover a passkey', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /passkey setup|request enrollment/i }).count(), 0);
    await go('/admin/passkeys/enroll');
    await page.getByRole('heading', { name: 'Set up an admin passkey' }).waitFor();
    assert.equal(await noIndex.getAttribute('content'), robots);
    await fillAdminLogin();
    await page.getByRole('button', { name: 'Continue to passkey setup' }).click();
    await page.getByRole('button', { name: 'Request device approval' }).click();
    await page.getByRole('button', { name: 'Continue after approval' }).click();
    await page.getByRole('alert').filter({ hasText: 'A synced passkey needs separate approval' }).waitFor();
    assert.equal(optionsRequests, 1);
    assert.equal(verifyRequests, 0);
    assert.equal(new URL(page.url()).pathname, '/admin/passkeys/enroll');

    await page.getByRole('button', { name: 'Back to admin login' }).click();
    await page.getByRole('button', { name: 'Farmer Login' }).click();
    await page.getByRole('heading', { name: 'Login', exact: true }).waitFor();
    await noAdminOnFarmer();
    await page.goBack();
    await adminLogin.waitFor();
    await noIndex.waitFor({ state: 'attached' });
    assert.equal(await noIndex.getAttribute('content'), robots);

    if (!mobile) {
      for (const path of ['/admin', '/admin/dashboard', '/admin/users', '/admin/devices', '/admin/thresholds', '/admin/passkeys']) {
        await go(path);
        await adminLogin.waitFor();
        assert.equal(new URL(page.url()).pathname, '/admin/login');
        assert.equal(await noIndex.getAttribute('content'), robots);
      }
      const sitemap = await page.request.get(base + '/sitemap.xml');
      assert.doesNotMatch(await sitemap.text(), /<(?:urlset|sitemapindex)\b/i);
      await go('/');
      await page.getByRole('heading', { name: 'Login', exact: true }).waitFor();
      await noAdminOnFarmer();
      await page.getByLabel('Mobile number').fill('09111111111');
      await page.getByLabel('Password', { exact: true }).fill('fixture-password');
      await page.getByRole('button', { name: 'Login', exact: true }).click();
      await page.waitForURL('**/dashboard');
      await page.getByRole('heading', { name: 'Water Monitoring' }).waitFor();
      await noAdminOnFarmer();
      rejectedStatus = 403;
      await go('/admin/passkeys');
      await adminLogin.waitFor();
      assert.equal(new URL(page.url()).pathname, '/admin/login');
    }
    console.log(`PASS ${channel} ${viewport.width}x${viewport.height}${mobile ? ' mobile emulation' : ''}`);
  } finally {
    await browser.close();
  }
}

(async () => {
  await check('chrome', { width: 1440, height: 900 });
  await check('msedge', { width: 1440, height: 900 });
  await check('chrome', { width: 390, height: 844 }, true);
  await check('chrome', { width: 360, height: 800 }, true);
})().catch(error => { console.error(error); process.exitCode = 1; });
