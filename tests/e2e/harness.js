// Shared setup for the browser tests: a static server for the repo, a fake Supabase, helpers.
const { devices } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const PORT = 8090, BASE = 'http://localhost:' + PORT + '/';
const FAKE = fs.readFileSync(path.join(__dirname, 'fake-supabase.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const state = { swVersion: null }; // when swVersion is set, sw.js is served with it to simulate a deploy

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, BASE).pathname);
  if (p.endsWith('/')) p += 'index.html';
  // Same redirect as vercel.json / netlify.toml: /book/<slug> -> book.html?p=<slug>.
  const short = /^\/book\/([^/]+)\/?$/.exec(p);
  if (short) { res.writeHead(302, { Location: '/book.html?p=' + encodeURIComponent(short[1]) }); return res.end(); }
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(file);
  if (p === '/sw.js' && state.swVersion) body = body.toString().replace(/const CACHE = '[^']+'/, "const CACHE = '" + state.swVersion + "'");
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(body);
});

function start() {
  fs.mkdirSync(OUT, { recursive: true });
  if (server.listening) return Promise.resolve();
  return new Promise((r) => server.listen(PORT, r));
}

const CONFIG = 'window.SP_CONFIG={supabaseUrl:"https://fake.supabase.co",supabaseAnonKey:"anon"};';
let failures = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };

async function ctx(browser, { cloud, mobile, scheme, config, timezoneId, small } = {}) {
  const c = await browser.newContext(Object.assign({}, mobile ? devices['iPhone 13'] : {}, small ? devices['iPhone SE'] : {},
    { colorScheme: scheme || 'dark', serviceWorkers: 'block' }, timezoneId ? { timezoneId } : {}));
  await c.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => {});
  await c.route('**/js/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: config ? 'window.SP_CONFIG=' + JSON.stringify(config) + ';' : cloud ? CONFIG : 'window.SP_CONFIG={};' }));
  await c.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE }));
  const page = await c.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  return { c, page };
}
const toastText = (p) => p.locator('#toast').textContent();
const waitToast = (p, re) => p.waitForFunction((src) => new RegExp(src).test(document.querySelector('#toast').textContent), re.source, { timeout: 5000 }).then(() => true, () => false);
const db = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('__fakedb') || '{}'));
const editDb = (p, fn) => p.evaluate((src) => { const d = JSON.parse(localStorage.getItem('__fakedb')); new Function('d', src)(d); localStorage.setItem('__fakedb', JSON.stringify(d)); }, fn);
const synced = (p) => p.waitForFunction(() => SPCloud.info().status === 'synced' && SPCloud.info().pending === 0);

async function signIn(page, email, opts) {
  await page.click('#accountBtn');
  await page.fill('#authEmailInput', email);
  await page.click('#authEmailBtn');
  if (!opts || !opts.quick) {
    await page.fill('#authCodeInput', '000000');
    await page.click('#authCodeForm button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#authError').textContent.length > 0);
    ok(/didn.t work|invalid/i.test(await page.textContent('#authError')), 'wrong code shows an error');
  }
  await page.fill('#authCodeInput', '123456');
  await page.click('#authCodeForm button[type=submit]');
}

function finish() {
  server.close();
  console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
  return failures;
}

module.exports = { BASE, OUT, state, start, ctx, ok, toastText, waitToast, db, editDb, synced, signIn, finish };
