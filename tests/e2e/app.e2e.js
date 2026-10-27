// Browser tests for accounts, sync and app updates, against an in-page fake of Supabase.
// Needs Playwright with Chromium:  npm i -D playwright && npx playwright install chromium
// Run:  npm run test:e2e   (screenshots are written to tests/e2e/out/)
const { chromium, devices } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const PORT = 8090, BASE = 'http://localhost:' + PORT + '/';
const FAKE = fs.readFileSync(path.join(__dirname, 'fake-supabase.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
let swVersion = null; // when set, sw.js is served with this cache name to simulate a deploy

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, BASE).pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(file);
  if (p === '/sw.js' && swVersion) body = body.toString().replace(/const CACHE = '[^']+'/, "const CACHE = '" + swVersion + "'");
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(body);
});
const SP = OUT;
const CONFIG = 'window.SP_CONFIG={supabaseUrl:"https://fake.supabase.co",supabaseAnonKey:"anon"};';
let failures = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };

async function ctx(browser, { cloud, mobile, scheme } = {}) {
  const c = await browser.newContext(Object.assign({}, mobile ? devices['iPhone 13'] : {}, { colorScheme: scheme || 'dark', serviceWorkers: 'block' }));
  await c.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => {});
  await c.route('**/js/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: cloud ? CONFIG : 'window.SP_CONFIG={};' }));
  await c.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE }));
  const page = await c.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  return { c, page };
}
const toastText = (p) => p.locator('#toast').textContent();
const db = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('__fakedb') || '{}'));

async function signIn(page, email) {
  await page.click('#accountBtn');
  await page.fill('#authEmailInput', email);
  await page.click('#authEmailBtn');
  await page.fill('#authCodeInput', '000000');
  await page.click('#authCodeForm button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#authError').textContent.length > 0);
  ok(/didn.t work|invalid/i.test(await page.textContent('#authError')), 'wrong code shows an error');
  await page.fill('#authCodeInput', '123456');
  await page.click('#authCodeForm button[type=submit]');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch();

  // ---- A. Local-only mode still works exactly as before ----
  let { c, page } = await ctx(browser, { mobile: true });
  await page.goto(BASE + 'app.html');
  ok(await page.isHidden('#accountBtn'), 'local-only: no account button without Supabase config');
  ok(await page.isHidden('#accountPanel'), 'local-only: no account panel');
  // Seed a legacy (pre-UUID) invoice the way v1 stored it.
  await page.evaluate(() => localStorage.setItem('shutterpaid:data:v1', JSON.stringify({ invoices: [{ id: 'lq3x9k2abc', clientName: 'Legacy <b>Client</b>', clientEmail: '', shootType: 'Portrait', number: 'INV-0900', amount: 50, currency: 'USD', shootDate: '', dueDate: '2026-01-01', notes: '', paid: false, paidDate: '', reminders: [{ date: '2026-01-02', tone: 'friendly', channel: 'email' }], createdAt: '2025-12-01' }], settings: { ownerName: 'Alex Rivera', businessName: 'Rivera Photo', currency: 'USD', soonDays: 3, paymentLink: '', signature: '' } })));
  await page.reload();
  ok((await page.innerHTML('#reminderList')).includes('Legacy &lt;b&gt;Client&lt;/b&gt;'), 'user content is escaped');
  const legacyId = await page.evaluate(() => JSON.parse(localStorage.getItem('shutterpaid:data:v1')).invoices[0].id);
  ok(/^[0-9a-f-]{36}$/.test(legacyId), 'legacy id upgraded to UUID on load');
  await page.click('.tabbar [data-view=settings]');
  await page.click('#demoBtn');
  await page.click('[data-action=new-invoice]');
  await page.fill('[name=clientName]', 'Mobile Test');
  await page.fill('[name=amount]', '700');
  await page.click('#saveInvoiceBtn');
  await page.click('.tabbar [data-view=invoices]');
  ok((await page.locator('#invoiceList .item').count()) === 7, 'local-only: 7 invoices listed');
  await page.locator('#invoiceList .item', { hasText: 'Bloom Studio' }).locator('[data-act=remind]').click();
  await page.click('#reminderCopy');
  ok(await page.waitForFunction(() => /Copied/.test(document.querySelector('#toast').textContent), null, { timeout: 3000 }).then(() => true, () => false), 'manual reminder: copy works');
  await page.click('#reminderCancel');
  await page.locator('#invoiceList .item', { hasText: 'Mobile Test' }).locator('[data-act=paid]').click();
  const sw = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  ok(sw, 'mobile: no horizontal scroll');
  await page.screenshot({ path: SP + '/local-mobile.png', fullPage: true });
  ok(page.errors.length === 0, 'local-only: no console errors ' + page.errors.join(' | '));
  const deviceData = await page.evaluate(() => localStorage.getItem('shutterpaid:data:v1'));
  await c.close();

  // ---- B. Cloud mode: sign in, upload device data once, no duplicates ----
  ({ c, page } = await ctx(browser, { cloud: true, mobile: true, scheme: 'light' }));
  await page.goto(BASE + 'app.html');
  await page.evaluate((d) => localStorage.setItem('shutterpaid:data:v1', d), deviceData);
  await page.reload();
  ok(await page.isVisible('#accountBtn'), 'cloud: account button visible');
  ok((await page.textContent('#accountBtnLabel')) === 'Sign in', 'cloud: shows Sign in');
  await signIn(page, 'a@x.com');
  await page.waitForSelector('#uploadDialog[open]');
  ok(/7 invoices/.test(await page.textContent('#uploadText')), 'upload offer counts device invoices');
  await page.screenshot({ path: SP + '/upload-light.png' });
  await page.click('#uploadGo');
  await page.waitForSelector('#uploadDialog:not([open])', { state: 'attached' });
  await page.waitForFunction(() => SPCloud.info().status === 'synced' && SPCloud.info().pending === 0);
  let d = await db(page);
  ok(d.invoices.length === 7, 'uploaded 7 invoices to account (got ' + d.invoices.length + ')');
  ok(d.reminder_log.length === 2, 'uploaded reminder history (got ' + d.reminder_log.length + ')');
  ok(d.profiles[0].business_name === 'Rivera Photo' && d.profiles[0].time_zone, 'settings and time zone uploaded');
  ok(!(await page.evaluate(() => localStorage.getItem('shutterpaid:data:v1'))), 'device-only data moved after upload');
  ok(!!(await page.evaluate(() => localStorage.getItem('shutterpaid:data:v1:uploaded'))), 'a copy of device data is kept');

  // Reload: no second offer, data from account cache.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#accountBtn').dataset.status === 'synced');
  ok(await page.isHidden('#uploadDialog[open]').catch(() => true), 'no second upload offer');
  ok((await page.locator('#invoiceList .item').count()) === 7, 'account shows 7 invoices after reload');

  // ---- C. Offline: changes queue locally and sync when back online ----
  await page.evaluate(() => { localStorage.setItem('__offline', '1'); window.dispatchEvent(new Event('offline')); });
  await page.click('.tabbar [data-view=invoices]');
  await page.locator('#invoiceList .item', { hasText: 'Bloom Studio' }).locator('[data-act=paid]').click();
  await page.click('[data-action=new-invoice]');
  await page.fill('[name=clientName]', 'Offline Shoot');
  await page.fill('[name=amount]', '300');
  await page.click('#saveInvoiceBtn');
  await page.waitForTimeout(800);
  ok(['offline', 'error'].includes(await page.getAttribute('#accountBtn', 'data-status')), 'status shows offline');
  await page.click('.tabbar [data-view=settings]');
  ok(/2 changes waiting/.test(await page.textContent('#syncDetail')), 'pending count shown: ' + await page.textContent('#syncDetail'));
  await page.reload();
  await page.click('.tabbar [data-view=invoices]');
  ok((await page.locator('#invoiceList .item', { hasText: 'Offline Shoot' }).count()) === 1, 'offline change survives reload');
  d = await db(page);
  ok(d.invoices.length === 7, 'nothing reached the server while offline');
  await page.evaluate(() => { localStorage.removeItem('__offline'); window.dispatchEvent(new Event('online')); });
  await page.waitForFunction(() => document.querySelector('#accountBtn').dataset.status === 'synced');
  d = await db(page);
  ok(d.invoices.length === 8 && d.invoices.find((i) => i.client_name === 'Bloom Studio').paid === true, 'queued changes synced after reconnect');

  // Changes made on another device show up here.
  await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('__fakedb')); d.invoices = d.invoices.filter((i) => i.client_name !== 'Jordan Lee'); localStorage.setItem('__fakedb', JSON.stringify(d)); });
  await page.click('.tabbar [data-view=settings]');
  await page.click('#syncNowBtn');
  await page.waitForTimeout(500);
  await page.click('.tabbar [data-view=invoices]');
  ok((await page.locator('#invoiceList .item', { hasText: 'Jordan Lee' }).count()) === 0, 'deletion from another device is pulled');

  // Server rejects a bad row: dropped from the queue, user told.
  await page.evaluate(() => { const k = Object.keys(localStorage).find((k) => k.startsWith('shutterpaid:cache:')); const s = JSON.parse(localStorage.getItem(k)); s.invoices[0].currency = 'usd'; localStorage.setItem(k, JSON.stringify(s)); });
  await page.reload();
  await page.click('.tabbar [data-view=invoices]');
  await page.locator('#invoiceList .item').first().locator('[data-act=edit]').click();
  await page.evaluate(() => { document.querySelector('#invoiceForm [name=currency]').add(new Option('bad', 'usd')); document.querySelector('#invoiceForm [name=currency]').value = 'usd'; });
  await page.click('#saveInvoiceBtn');
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => /couldn.t be saved/.test(document.querySelector('#toast').textContent));
  ok(true, 'rejected change surfaces a message');
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('shutterpaid:outbox:11111111-1111-4111-8111-111111111111')).length === 0), 'rejected op does not block the queue');
  page.errors = page.errors.filter((e) => !/Sync rejected|Failed to load resource/.test(e));

  // ---- D. Sign out keeps account data off the device ----
  await page.click('.tabbar [data-view=settings]');
  await page.click('#signOutBtn');
  await page.waitForFunction(() => document.querySelector('#accountBtnLabel').textContent === 'Sign in');
  ok((await page.locator('#invoiceList .item').count()) === 0, 'signed out: device-only view is empty (data was uploaded)');
  ok(!(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('shutterpaid:cache:')))), 'account cache removed on sign-out');
  ok(page.errors.length === 0, 'cloud: no console errors ' + page.errors.join(' | '));

  // ---- E. Another device with the same invoices: dedup by fingerprint ----
  const dbSnapshot = await page.evaluate(() => localStorage.getItem('__fakedb'));
  await c.close();
  ({ c, page } = await ctx(browser, { cloud: true }));
  await page.goto(BASE + 'app.html');
  await page.evaluate(([dbs, dev]) => { localStorage.setItem('__fakedb', dbs); localStorage.setItem('shutterpaid:data:v1', dev); }, [dbSnapshot, deviceData]);
  await page.reload();
  await signIn(page, 'a@x.com');
  await page.waitForSelector('#uploadDialog[open]');
  await page.click('#uploadGo');
  await page.waitForSelector('#uploadDialog:not([open])', { state: 'attached' });
  await page.waitForFunction(() => SPCloud.info().status === 'synced' && SPCloud.info().pending === 0);
  const t = await toastText(page);
  d = await db(page);
  // Jordan Lee was deleted in the account, so it's the only one re-added; the rest are recognised.
  ok(d.invoices.length === 8, 'second device upload adds no duplicates (account has ' + d.invoices.length + ', toast: ' + t + ')');
  await page.screenshot({ path: SP + '/desktop-dark.png', fullPage: true });

  // ---- F. Another user sees none of it ----
  await page.evaluate(() => window.SPCloud.signOut());
  await page.waitForTimeout(200);
  await signIn(page, 'b@x.com');
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => document.querySelector('#accountBtn').dataset.status === 'synced');
  ok((await page.locator('#invoiceList .item').count()) === 0, 'user B sees no invoices from user A');
  await c.close();

  // ---- G. Service worker: new version shows a refresh prompt ----
  const swc = await browser.newContext();
  page = await swc.newPage();
  await page.goto(BASE + 'app.html');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  swVersion = 'shutterpaid-next';
  await page.reload();
  await page.waitForSelector('#updateBanner:not([hidden])', { timeout: 10000 });
  ok(true, 'update banner appears for a new service worker');
  await Promise.all([page.waitForEvent('load'), page.click('#updateBanner button')]);
  const keys = await page.evaluate(() => caches.keys());
  ok(keys.length === 1 && keys[0] === 'shutterpaid-next', 'refresh activates new version and clears old cache: ' + keys);
  await swc.close();

  await browser.close();
  server.close();
  console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
