// Browser tests for plans: Free limits, upgrade flow, billing portal, and Pro features unlocking.
const { chromium } = require('playwright');
const { BASE, OUT, start, ctx, ok, waitToast, db, editDb, synced, signIn, finish } = require('./harness');

async function addInvoice(page, name, opts) {
  await page.click('[data-action=new-invoice]');
  if (opts && opts.expectUpgrade) return;
  await page.fill('[name=clientName]', name);
  await page.fill('[name=clientEmail]', 'client@example.com');
  await page.fill('[name=amount]', '100');
  await page.click('#saveInvoiceBtn');
}

module.exports = async function run() {
  await start();
  const browser = await chromium.launch();

  // ---- Landing page pricing ----
  let { c, page } = await ctx(browser, { mobile: true });
  await page.goto(BASE + 'index.html#pricing');
  ok((await page.textContent('#proPrice')).startsWith('$9'), 'pricing shows $9/month');
  await page.click('[data-interval=year]');
  ok((await page.textContent('#proPrice')).startsWith('$90'), 'pricing switches to $90/year');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'pricing fits a phone screen');
  await page.locator('#pricing').screenshot({ path: OUT + '/pricing-mobile.png' });
  await c.close();

  // ---- Local-only: no limits, no plan UI ----
  ({ c, page } = await ctx(browser));
  await page.goto(BASE + 'app.html');
  for (let i = 1; i <= 6; i++) await addInvoice(page, 'Local ' + i);
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('shutterpaid:data:v1')).invoices.length) === 6, 'local-only saved 6 invoices');
  ok(await page.isHidden('#planNote'), 'local-only: no plan note');
  await c.close();

  // ---- Free account ----
  ({ c, page } = await ctx(browser, { cloud: true, mobile: true }));
  await page.goto(BASE + 'app.html');
  await signIn(page, 'a@x.com', { quick: true });
  await synced(page);
  ok(/Free plan: 0 of 5 active invoices/.test(await page.textContent('#planNote')), 'dashboard shows free usage');
  for (let i = 1; i <= 5; i++) await addInvoice(page, 'Client ' + i);
  await synced(page);
  ok(/5 of 5/.test(await page.textContent('#planNote')), 'usage reaches 5 of 5');
  await addInvoice(page, 'Sixth', { expectUpgrade: true });
  ok(await page.isVisible('#upgradeDialog'), 'sixth invoice opens the upgrade dialog');
  ok(/5 active \(unpaid\) invoices/.test(await page.textContent('#upgradeReason')), 'dialog explains the limit');
  ok((await page.textContent('#upgradeGo')) === 'Start free trial' && await page.isVisible('#upgradeTrialNote'), 'first upgrade offers the free trial');
  await page.screenshot({ path: OUT + '/upgrade-mobile.png' });
  await page.click('#upgradeClose');

  // Auto-reminders are Pro-only.
  await page.click('.tabbar [data-view=invoices]');
  await page.locator('#invoiceList .item').first().locator('[data-act=edit]').click();
  ok(await page.isDisabled('#autoRemindInput') && await page.isVisible('#autoUpsell'), 'auto-reminder toggle locked with a Pro upsell');
  await page.click('#autoUpsell [data-upgrade]');
  ok(/email your clients for you/.test(await page.textContent('#upgradeReason')), 'upsell opens upgrade dialog');
  await page.click('#upgradeClose');
  await page.click('#invoiceForm [value=cancel]');

  // Paying one frees a slot.
  await page.locator('#invoiceList .item').first().locator('[data-act=paid]').click();
  await addInvoice(page, 'Fits now');
  await synced(page);
  ok((await db(page)).invoices.filter((i) => !i.paid).length === 5, 'marking one paid lets another in');
  // Marking a paid invoice unpaid at the limit is blocked too.
  await page.locator('#invoiceList .item', { hasText: 'Client 1' }).locator('[data-act=unpaid]').click();
  ok(await page.isVisible('#upgradeDialog'), 'mark unpaid at the limit opens the upgrade dialog');
  await page.click('#upgradeClose');

  // A change the server refuses because of the limit (e.g. from a second device) is kept, not lost.
  await page.evaluate(() => {
    const u = SPCloud.user();
    const row = { id: SPCore.uuid(), user_id: u.id, client_name: 'Other device', client_email: '', shoot_type: 'Other', number: '', amount: 1, currency: 'USD', shoot_date: null, due_date: '2026-12-01', notes: '', paid: false, paid_date: null, auto_remind: false, reminder_schedule: null };
    SPCloud.enqueue({ table: 'invoices', op: 'upsert', id: row.id, row });
  });
  ok(await waitToast(page, /Free plan syncs 5 active invoices/), 'limit rejection explained');
  ok(await page.evaluate(() => SPCloud.parkedCount()) === 1, 'refused change is set aside, not dropped');

  // Settings → plan panel.
  await page.click('.tabbar [data-view=settings]');
  ok(await page.isVisible('#planPanel') && /Free plan/.test(await page.textContent('#planName')), 'plan panel shows Free');
  ok(await page.isHidden('#planManageBtn'), 'no Manage billing before any purchase');

  // ---- Upgrade ----
  await page.evaluate((base) => { window.__functionUrls = { 'create-checkout': base + 'app.html?checkout=success' }; }, BASE);
  await page.click('#planUpgradeBtn');
  await page.check('#upgradeDialog [name=interval][value=year]');
  await Promise.all([page.waitForURL(/checkout=success/), page.click('#upgradeGo')]);
  ok(true, 'checkout redirect followed');
  // Stripe's webhook marks the account Pro (simulated here).
  await editDb(page, `const p = d.profiles.find((x) => x.id.startsWith('1111'));
    Object.assign(p, { plan: 'pro', plan_status: 'trialing', plan_interval: 'year', trial_used: true, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1',
      trial_ends_at: new Date(Date.now() + 14 * 864e5).toISOString(), current_period_end: new Date(Date.now() + 14 * 864e5).toISOString() });`);
  ok(await waitToast(page, /Setting up Pro|on ShutterPaid Pro/), 'return from checkout acknowledged');
  await page.waitForFunction(() => /on ShutterPaid Pro/.test(document.querySelector('#toast').textContent), null, { timeout: 15000 });
  ok(!page.url().includes('checkout='), 'checkout parameter removed from the address bar');
  await synced(page);
  ok(await page.evaluate(() => SPCloud.parkedCount()) === 0, 'set-aside change sent after upgrading');
  ok((await db(page)).invoices.some((i) => i.client_name === 'Other device'), 'set-aside invoice reached the account');
  ok(await page.isHidden('#planNote'), 'no usage limit shown on Pro');
  await page.click('.tabbar [data-view=settings]');
  ok(/ShutterPaid Pro/.test(await page.textContent('#planName')) && /Free trial until/.test(await page.textContent('#planDetail')), 'plan panel shows the Pro trial: ' + await page.textContent('#planDetail'));
  ok(await page.isVisible('#planManageBtn') && await page.isHidden('#planUpgradeBtn'), 'Manage billing shown on Pro');
  await page.screenshot({ path: OUT + '/plan-pro-mobile.png', fullPage: true });

  // Pro: unlimited invoices and auto-reminders.
  await addInvoice(page, 'Seventh');
  await synced(page);
  ok((await db(page)).invoices.filter((i) => !i.paid).length === 7, 'Pro saves more than 5 active invoices');
  await page.click('.tabbar [data-view=invoices]');
  await page.locator('#invoiceList .item', { hasText: 'Seventh' }).locator('[data-act=edit]').click();
  ok(!(await page.isDisabled('#autoRemindInput')) && await page.isHidden('#autoUpsell'), 'auto-reminders unlocked on Pro');
  await page.check('#autoRemindInput');
  await page.click('#saveInvoiceBtn');
  await synced(page);
  ok((await db(page)).invoices.find((i) => i.client_name === 'Seventh').auto_remind === true, 'Pro can turn on auto-reminders');

  // Manage billing opens the portal.
  await page.evaluate((base) => { window.__functionUrls = { 'billing-portal': base + 'index.html?portal=1' }; }, BASE);
  await page.click('.tabbar [data-view=settings]');
  await Promise.all([page.waitForURL(/portal=1/), page.click('#planManageBtn')]);
  ok(true, 'Manage billing opens the Stripe portal');

  // ---- Downgrade: subscription ends ----
  await page.goto(BASE + 'app.html');
  await editDb(page, `const p = d.profiles.find((x) => x.id.startsWith('1111')); Object.assign(p, { plan: 'free', plan_status: 'canceled' });`);
  await page.evaluate(() => SPCloud.sync());
  await synced(page);
  await page.click('.tabbar [data-view=invoices]');
  ok(/paused: they need ShutterPaid Pro/.test(await page.locator('#invoiceList .item', { hasText: 'Seventh' }).locator('.item-auto').textContent()), 'after downgrade, auto-reminders show as paused');
  ok(/Free plan: 5 of 5/.test(await page.textContent('#planNote')) || /of 5/.test(await page.textContent('#planNote')), 'free usage shown again');
  const listed = await page.locator('#invoiceList .item').count();
  ok(listed === 8 && listed === (await db(page)).invoices.length, 'nothing lost on downgrade (' + listed + ' invoices)');
  ok(page.errors.length === 0, 'billing: no console errors ' + page.errors.join(' | '));
  await c.close();

  // ---- Signed out → landing "Try Pro" → sign in → upgrade dialog ----
  ({ c, page } = await ctx(browser, { cloud: true }));
  await page.goto(BASE + 'app.html#upgrade');
  ok(await page.isVisible('#upgradeDialog') && (await page.textContent('#upgradeGo')) === 'Sign in to continue', 'signed-out upgrade asks to sign in');
  await page.click('#upgradeGo');
  await page.fill('#authEmailInput', 'b@x.com');
  await page.click('#authEmailBtn');
  await page.fill('#authCodeInput', '123456');
  await page.click('#authCodeForm button[type=submit]');
  await page.waitForSelector('#upgradeDialog[open]');
  ok((await page.textContent('#upgradeGo')) === 'Start free trial', 'after sign-in the upgrade dialog comes back');
  await c.close();

  await browser.close();
};

if (require.main === module) module.exports().then(() => process.exit(finish() ? 1 : 0), (e) => { console.error(e); process.exit(1); });
