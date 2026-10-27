// Browser tests for phase 5: CSV export, PDF invoices, Stripe Connect and per-invoice payment links.
const { chromium } = require('playwright');
const fs = require('fs');
const { BASE, OUT, start, ctx, ok, waitToast, db, editDb, synced, signIn, finish } = require('./harness');

async function stubPrint(page) {
  await page.evaluate(() => {
    window.__printed = [];
    window.print = () => {
      window.__printed.push({ title: document.title, printing: document.body.classList.contains('printing'), html: document.querySelector('#printRoot').innerHTML });
      window.dispatchEvent(new Event('afterprint'));
    };
  });
}

module.exports = async function run() {
  await start();
  const browser = await chromium.launch();

  // ---- Local-only: CSV and PDF work without an account ----
  let { c, page } = await ctx(browser, { mobile: true });
  await page.goto(BASE + 'app.html');
  await page.click('.tabbar [data-view=settings]');
  await page.fill('[name=businessName]', 'Rivera Photo');
  await page.fill('[name=businessAddress]', '12 Main St\nAustin, TX');
  await page.click('#settingsForm button[type=submit]');
  await page.click('[data-action=new-invoice]');
  await page.fill('[name=clientName]', '=HYPERLINK("x") <b>Bold</b>');
  await page.fill('[name=clientEmail]', 'client@example.com');
  await page.fill('[name=amount]', '1250.5');
  await page.selectOption('#invoiceForm [name=currency]', 'INR');
  await page.click('#saveInvoiceBtn');
  await page.click('.tabbar [data-view=invoices]');
  ok(await page.isHidden('#payPanel'), 'local-only: no Stripe panel');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#csvBtn')]);
  ok(/^shutterpaid-invoices-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename()), 'CSV file name: ' + dl.suggestedFilename());
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  ok(csv.charCodeAt(0) === 0xfeff, 'CSV starts with a BOM for Excel');
  ok(/Invoice #,Client,Client email/.test(csv) && /"'=HYPERLINK\(""x""\) <b>Bold<\/b>"/.test(csv) && /1250\.50,INR/.test(csv), 'CSV has the invoice, with the formula neutralised');

  await page.locator('#invoiceList .item').first().locator('[data-act=pdf]').click();
  ok(await page.isVisible('#docDialog'), 'PDF preview opens');
  const sheet = page.locator('#docPreview .invoice-sheet');
  const text = await sheet.textContent();
  ok(/Rivera Photo/.test(text) && /12 Main St/.test(text) && /Bill to/.test(text) && /₹1,250\.50/.test(text), 'invoice shows business, address, client and ₹ amount');
  ok((await sheet.locator('b').count()) === 0 && /<b>Bold<\/b>/.test(text), 'client name is escaped on the invoice');
  await page.screenshot({ path: OUT + '/invoice-preview-mobile.png' });
  await stubPrint(page);
  await page.click('#docPrint');
  const printed = await page.evaluate(() => window.__printed);
  ok(printed.length === 1 && printed[0].printing && /^Invoice - INV-1001 - /.test(printed[0].title) && /invoice-sheet/.test(printed[0].html), 'Save as PDF prints only the invoice, titled for the file name: ' + (printed[0] && printed[0].title));
  ok(!(await page.evaluate(() => document.body.classList.contains('printing'))) && (await page.title()) === 'ShutterPaid', 'page restored after printing');
  ok(page.errors.length === 0, 'local-only: no console errors ' + page.errors.join(' | '));
  await c.close();

  // ---- Signed in: connect Stripe ----
  ({ c, page } = await ctx(browser, { cloud: true }));
  await page.goto(BASE + 'app.html');
  await signIn(page, 'a@x.com', { quick: true });
  await synced(page);
  await page.click('.tabbar [data-view=settings]');
  ok(await page.isVisible('#payPanel') && (await page.textContent('#connectBtn')) === 'Connect Stripe', 'Stripe panel offers Connect Stripe');
  await page.fill('[name=businessName]', 'Rivera Photo');
  await page.fill('[name=businessAddress]', '405 Example Way');
  await page.click('#settingsForm button[type=submit]');
  await synced(page);
  ok((await db(page)).profiles[0].business_address === '405 Example Way', 'business details saved to the account');

  await page.evaluate((base) => {
    window.__functionResults = { 'stripe-connect': (b) => b.action === 'start' ? { url: base + 'app.html?connect=return' } : { connected: true, chargesEnabled: true } };
  }, BASE);
  await Promise.all([page.waitForURL(/connect=return/), page.click('#connectBtn')]);
  // Stripe onboarding finished; the server records the connected account.
  await editDb(page, `Object.assign(d.profiles[0], { stripe_connect_account_id: 'acct_1', connect_charges_enabled: true });`);
  await page.evaluate(() => { window.__functionResults = { 'stripe-connect': { connected: true, chargesEnabled: true } }; });
  ok(await waitToast(page, /Stripe connected/), 'return from Stripe confirms the connection');
  await page.waitForFunction(() => !location.search.includes('connect='));
  await synced(page);
  await page.waitForFunction(() => document.querySelector('#connectBtn').hidden);
  ok(/Stripe is connected/.test(await page.textContent('#payDetail')) && await page.isVisible('#stripeDashBtn'), 'panel shows Stripe connected');

  // ---- Payment link goes into reminders and the PDF ----
  await page.click('[data-action=new-invoice]');
  await page.fill('[name=clientName]', 'Priya & Sam');
  await page.fill('[name=clientEmail]', 'priya@example.com');
  await page.fill('[name=amount]', '2400');
  await page.click('#saveInvoiceBtn');
  await synced(page);
  await page.evaluate(() => {
    window.__linkCalls = [];
    window.__functionResults = {
      'payment-link': (b) => {
        window.__linkCalls.push(b.action);
        const d = JSON.parse(localStorage.getItem('__fakedb'));
        const inv = d.invoices.find((i) => i.id === b.invoiceId);
        if (b.action === 'retire') { inv.payment_url = null; localStorage.setItem('__fakedb', JSON.stringify(d)); return { url: null, reason: 'retired' }; }
        inv.payment_url = 'https://buy.stripe.com/test_priya';
        localStorage.setItem('__fakedb', JSON.stringify(d));
        return { url: inv.payment_url };
      }
    };
  });
  await page.click('.tabbar [data-view=invoices]');
  const item = page.locator('#invoiceList .item', { hasText: 'Priya & Sam' });
  await item.locator('[data-act=remind]').click();
  await page.waitForFunction(() => /buy\.stripe\.com\/test_priya/.test(document.querySelector('#reminderBody').value), null, { timeout: 15000 });
  ok(true, 'reminder text gets the invoice payment link');
  await page.click('#reminderCancel');
  await item.locator('[data-act=pdf]').click();
  await page.waitForFunction(() => /Pay online/.test(document.querySelector('#docPreview').textContent));
  ok(/buy\.stripe\.com\/test_priya/.test(await page.textContent('#docPreview')), 'PDF invoice shows the payment link');
  await page.click('#docClose');
  await synced(page);
  ok((await page.evaluate(() => SPCloud.info().status)) === 'synced', 'link kept after the next sync');

  // Client pays online: the webhook marks it paid.
  await editDb(page, `const i = d.invoices.find((x) => x.client_name === 'Priya & Sam'); Object.assign(i, { paid: true, paid_date: '2026-10-27', paid_via: 'stripe', payment_url: null });`);
  await page.evaluate(() => SPCloud.sync());
  await synced(page);
  ok(/Paid .* online 💳/.test(await item.locator('.item-meta').textContent()), 'invoice paid online shows as paid via Stripe');

  // Marking another invoice paid by hand turns its link off.
  await page.click('[data-action=new-invoice]');
  await page.fill('[name=clientName]', 'Bloom Studio');
  await page.fill('[name=amount]', '850');
  await page.click('#saveInvoiceBtn');
  await synced(page);
  const bloom = page.locator('#invoiceList .item', { hasText: 'Bloom Studio' });
  await bloom.locator('[data-act=pdf]').click();
  await page.waitForFunction(() => /Pay online/.test(document.querySelector('#docPreview').textContent));
  await page.click('#docClose');
  await bloom.locator('[data-act=paid]').click();
  await page.waitForFunction(() => window.__linkCalls.includes('retire'));
  ok(true, 'manual "Mark paid" retires the payment link');
  await page.screenshot({ path: OUT + '/payments-desktop.png', fullPage: true });
  ok(page.errors.length === 0, 'payments: no console errors ' + page.errors.join(' | '));
  await c.close();

  await browser.close();
};

if (require.main === module) module.exports().then(() => process.exit(finish() ? 1 : 0), (e) => { console.error(e); process.exit(1); });
