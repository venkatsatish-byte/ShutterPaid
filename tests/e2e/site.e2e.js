// Browser tests for the public site: legal pages, footer, SEO tags, beta sign-up and analytics.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { BASE, OUT, start, ctx, ok, synced, signIn, finish } = require('./harness');

const ROOT = path.join(__dirname, '..', '..');
const CLOUD = { supabaseUrl: 'https://fake.supabase.co', supabaseAnonKey: 'anon', plausibleDomain: 'shutterpaid.test' };

// Record analytics calls instead of loading Plausible.
async function withAnalytics(c) {
  await c.route('https://plausible.io/**', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  // Events are kept in sessionStorage so they survive navigations (e.g. to and from checkout).
  await c.addInitScript(() => {
    const read = () => JSON.parse(sessionStorage.getItem('__events') || '[]');
    Object.defineProperty(window, '__events', { get: read });
    window.plausible = function (name, opts) {
      sessionStorage.setItem('__events', JSON.stringify(read().concat([name + (opts && opts.props ? ' ' + JSON.stringify(opts.props) : '')])));
    };
  });
}

module.exports = async function run() {
  await start();
  const browser = await chromium.launch();

  // ---- Static files ----
  ok(fs.existsSync(path.join(ROOT, 'robots.txt')) && /Sitemap: .*sitemap\.xml/.test(fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8')), 'robots.txt points to the sitemap');
  ok(/<urlset/.test(fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8')), 'sitemap.xml exists');
  const png = fs.readFileSync(path.join(ROOT, 'og-image.png'));
  ok(png.readUInt32BE(16) === 1200 && png.readUInt32BE(20) === 630, 'share image is 1200×630');

  // ---- Landing page without Supabase (GitHub Pages) ----
  let { c, page } = await ctx(browser, { mobile: true });
  await page.goto(BASE + 'index.html');
  const meta = async (sel) => page.getAttribute(sel, 'content');
  ok(/og-image\.png$/.test(await meta('meta[property="og:image"]')) && await meta('meta[name="twitter:card"]') === 'summary_large_image', 'Open Graph and Twitter tags present');
  ok(!!(await page.getAttribute('link[rel=canonical]', 'href')), 'canonical link present');
  ok(await page.isHidden('#beta'), 'beta form hidden without Supabase');
  ok(!/stays on your device\. Export/.test(await page.textContent('#features')), 'old "data stays on your device" claim removed');
  ok(/Automatic reminders/.test(await page.textContent('#features')), 'features mention automatic reminders');
  for (const href of ['privacy.html', 'terms.html']) ok(await page.locator('.site-footer a[href="' + href + '"]').count() === 1, 'footer links to ' + href);
  ok(await page.locator('.site-footer a[href^="mailto:"]').count() === 1, 'footer has a support email');
  ok(page.errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, 'landing: no script errors ' + page.errors.join(' | '));
  for (const f of ['privacy.html', 'terms.html']) {
    await page.goto(BASE + f);
    ok(/Draft for legal review/.test(await page.textContent('.draft-banner')), f + ' is clearly marked as a draft');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), f + ' fits a phone screen');
  }
  await page.screenshot({ path: OUT + '/terms-mobile.png' });
  await c.close();

  // ---- Landing page with Supabase + analytics: beta sign-up ----
  ({ c, page } = await ctx(browser, { config: CLOUD, scheme: 'light' }));
  await withAnalytics(c);
  const posts = [];
  let reply = 201;
  await c.route('https://fake.supabase.co/rest/v1/beta_signups', (r) => {
    posts.push({ body: r.request().postDataJSON(), headers: r.request().headers() });
    r.fulfill({ status: reply, body: '' });
  });
  await page.goto(BASE + 'index.html#beta');
  ok(await page.isVisible('#beta'), 'beta form shown when Supabase is configured');
  await page.fill('#betaEmail', 'nope');
  await page.click('#betaForm button');
  ok(/valid email/.test(await page.textContent('#betaStatus')) && posts.length === 0, 'invalid email rejected in the browser');
  await page.fill('#betaEmail', 'alex@studio.com');
  await page.click('#betaForm button');
  await page.waitForFunction(() => /on the list/.test(document.querySelector('#betaStatus').textContent));
  ok(posts.length === 1 && posts[0].body.email === 'alex@studio.com' && posts[0].headers.apikey === 'anon', 'email saved to beta_signups with the anon key');
  ok((await page.evaluate(() => window.__events)).includes('Beta signup'), 'Beta signup event tracked');
  reply = 409;
  await page.fill('#betaEmail', 'alex@studio.com');
  await page.click('#betaForm button');
  await page.waitForFunction(() => document.querySelector('#betaStatus').textContent && !document.querySelector('#betaForm button').disabled);
  ok(/on the list/.test(await page.textContent('#betaStatus')), 'already on the list gets the same thanks');
  // Bots filling the hidden field are ignored.
  await page.evaluate(() => { document.querySelector('[name=website]').value = 'spam'; });
  await page.fill('#betaEmail', 'bot@spam.com');
  await page.click('#betaForm button');
  ok(posts.length === 2, 'honeypot submission not sent');
  await page.locator('#beta').screenshot({ path: OUT + '/beta-light.png' });
  ok(await page.evaluate(() => !!document.querySelector('script[src*="plausible.io"][data-domain="shutterpaid.test"]')), 'Plausible loads with the configured domain');
  await c.close();

  // ---- App: sign-up and upgrade events ----
  ({ c, page } = await ctx(browser, { cloud: true, config: CLOUD }));
  await withAnalytics(c);
  await page.goto(BASE + 'app.html');
  await signIn(page, 'new@x.com', { quick: true });
  await synced(page);
  ok((await page.evaluate(() => window.__events)).filter((e) => e === 'Signup').length === 1, 'Signup tracked once for a new account');
  await page.reload();
  await synced(page);
  ok((await page.evaluate(() => window.__events)).filter((e) => e === 'Signup').length === 1, 'Signup not tracked again on reload');
  await page.evaluate((base) => { window.__functionUrls = { 'create-checkout': base + 'app.html?checkout=success' }; }, BASE);
  await page.click('.tabbar [data-view=settings]');
  await page.click('#planUpgradeBtn');
  await Promise.all([page.waitForURL(/checkout=success/), page.click('#upgradeGo')]);
  await page.waitForFunction(() => window.__events.includes('Upgrade'));
  ok((await page.evaluate(() => window.__events)).includes('Upgrade started {"interval":"month"}'), 'Upgrade started tracked with the interval');
  ok(true, 'Upgrade tracked after returning from checkout');
  ok(await page.locator('#view-settings .footer-links a[href="privacy.html"]').count() === 1, 'app links to the privacy policy');
  await c.close();

  await browser.close();
};

if (require.main === module) module.exports().then(() => process.exit(finish() ? 1 : 0), (e) => { console.error(e); process.exit(1); });
