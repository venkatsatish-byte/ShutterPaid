// Browser tests for automatic reminders: settings, per-invoice toggle, history, stop page.
const { chromium } = require('playwright');
const { BASE, OUT, start, ctx, ok, waitToast, db, editDb, synced, signIn, finish } = require('./harness');

module.exports = async function run() {
  await start();
  const browser = await chromium.launch();

  // ---- Local-only: no automatic reminder controls ----
  let { c, page } = await ctx(browser);
  await page.goto(BASE + 'app.html');
  await page.click('[data-action=new-invoice]');
  ok(await page.isHidden('#invoiceAuto'), 'local-only: no auto-reminder toggle in the invoice dialog');
  await page.click('#invoiceForm [value=cancel]');
  await page.click('.tabbar [data-view=settings]');
  ok(await page.isHidden('#autoPanel'), 'local-only: no reminder settings panel');
  // Manual reminders still work and use the shared copy.
  await page.click('#demoBtn');
  await page.click('.tabbar [data-view=dashboard]');
  await page.locator('#reminderList [data-act=remind]').first().click();
  ok(/Hi \w+,/.test(await page.inputValue('#reminderBody')), 'manual reminder text is filled in');
  await page.click('#reminderCancel');
  ok(page.errors.length === 0, 'local-only: no console errors ' + page.errors.join(' | '));
  await c.close();

  // ---- Signed in ----
  ({ c, page } = await ctx(browser, { cloud: true, mobile: true }));
  await page.goto(BASE + 'app.html');
  await signIn(page, 'a@x.com', { quick: true });
  await synced(page);
  // Automatic reminders are a Pro feature (plans are covered in billing.e2e.js).
  await editDb(page, `Object.assign(d.profiles.find((x) => x.id.startsWith('1111')), { plan: 'pro', plan_status: 'active' });`);
  await page.evaluate(() => SPCloud.sync());
  await synced(page);

  // Signed in, but no business name yet: the dialog says so after saving.
  await page.click('.tabbar [data-view=settings]');
  ok(await page.isVisible('#autoPanel'), 'reminder settings panel visible when signed in');
  ok((await page.locator('#defaultSchedule .sched-row').count()) === 4, 'default schedule has 4 steps');
  await page.fill('[name=ownerName]', 'Alex Rivera');
  await page.fill('[name=businessName]', 'Rivera & <b>Photo</b>');
  await page.click('#settingsForm button[type=submit]');

  // Edit the default schedule: drop the final notice, change the firm step to 10 days after.
  const rows = page.locator('#defaultSchedule .sched-row');
  await rows.nth(3).locator('[data-k=remove]').click();
  await rows.nth(2).locator('[data-k=days]').fill('10');
  await page.selectOption('#sendHourSelect', '8');
  await page.fill('#autoForm [name=timeZone]', 'Not/AZone');
  await page.click('#autoForm button[type=submit]');
  ok(await waitToast(page, /time zone/), 'invalid time zone is rejected');
  await page.fill('#autoForm [name=timeZone]', 'Asia/Kolkata');
  await page.fill('#autoForm [name=replyTo]', 'billing@rivera.example');
  await page.click('#autoForm button[type=submit]');
  await synced(page);
  let d = await db(page);
  const prof = d.profiles.find((p) => p.id.startsWith('1111'));
  ok(JSON.stringify(prof.reminder_schedule) === JSON.stringify([{ offset: -3, tone: 'friendly' }, { offset: 0, tone: 'friendly' }, { offset: 10, tone: 'firm' }]), 'default schedule saved to profile: ' + JSON.stringify(prof.reminder_schedule));
  ok(prof.send_hour === 8 && prof.time_zone === 'Asia/Kolkata' && prof.reply_to === 'billing@rivera.example', 'send hour, time zone and reply-to saved');
  await page.screenshot({ path: OUT + '/reminder-settings-mobile.png', fullPage: true });

  // New invoice with auto-reminders but no client email: blocked.
  const today = await page.evaluate(() => SPSchedule.localNow(new Date(), 'Asia/Kolkata').date);
  const due = await page.evaluate((t) => SPSchedule.addDays(t, 5), today);
  await page.click('[data-action=new-invoice]');
  ok(await page.isVisible('#invoiceAuto'), 'auto-reminder toggle shown when signed in');
  ok(/Friendly 3 days before, Friendly on the due date, Firm 10 days after/.test(await page.textContent('#autoRemindHint')), 'dialog shows the default schedule');
  await page.fill('[name=clientName]', 'Priya & Sam');
  await page.fill('[name=amount]', '2400');
  await page.fill('[name=dueDate]', due);
  await page.check('#autoRemindInput');
  await page.click('#saveInvoiceBtn');
  ok(await waitToast(page, /client.s email/), 'auto-reminders need a client email');
  ok(await page.isVisible('#invoiceDialog'), 'dialog stays open');
  await page.fill('[name=clientEmail]', 'priya@example.com');
  // Custom schedule for this invoice: just one firm reminder on the due date.
  await page.click('#customScheduleDetails summary');
  await page.check('#customScheduleInput');
  const inv = page.locator('#invoiceSchedule .sched-row');
  while ((await inv.count()) > 1) await inv.nth(1).locator('[data-k=remove]').click();
  await inv.nth(0).locator('[data-k=tone]').selectOption('firm');
  await inv.nth(0).locator('[data-k=when]').selectOption('on');
  ok(/Schedule: Firm on the due date\./.test(await page.textContent('#autoRemindHint')), 'hint follows the custom schedule');
  await page.click('#saveInvoiceBtn');
  await synced(page);
  d = await db(page);
  const row = d.invoices[0];
  ok(row.auto_remind === true && JSON.stringify(row.reminder_schedule) === '[{"offset":0,"tone":"firm"}]', 'invoice saved with auto-remind and custom schedule');
  await page.click('.tabbar [data-view=invoices]');
  const item = page.locator('#invoiceList .item').first();
  ok(/Next auto reminder: Firm, /.test(await item.locator('.item-auto').textContent()), 'invoice shows next auto reminder: ' + await item.locator('.item-auto').textContent());
  ok((await item.innerHTML()).includes('Priya &amp; Sam'), 'client name escaped in the list');

  // The server sends it: history shows it and the schedule is complete.
  await editDb(page, `d.reminder_log.push({ id: 'aaaaaaaa-0000-4000-8000-000000000001', user_id: d.invoices[0].user_id, invoice_id: d.invoices[0].id, sent_on: '${due}', sent_at: '${due}T03:00:00Z', tone: 'firm', channel: 'auto', status: 'sent', scheduled_for: '${due}', step_offset: 0 });
    d.reminder_log.push({ id: 'aaaaaaaa-0000-4000-8000-000000000002', user_id: d.invoices[0].user_id, invoice_id: d.invoices[0].id, sent_on: '${today}', sent_at: '${today}T03:00:00Z', tone: 'friendly', channel: 'auto', status: 'failed', scheduled_for: '${today}', step_offset: -5, error: 'Resend 422' });`);
  await page.evaluate(() => SPCloud.sync());
  await synced(page);
  ok(/all scheduled reminders sent/.test(await item.locator('.item-auto').textContent()), 'after the send, nothing more is scheduled');
  await item.locator('.history summary').click();
  const hist = await item.locator('.history').textContent();
  ok(/Reminder history \(2\)/.test(hist) && /Firm · sent automatically/.test(hist) && /automatic send failed/.test(hist), 'history lists automatic sends and failures');

  // The client stops reminders: the app shows it and the toggle is locked.
  await editDb(page, `d.invoices[0].reminders_stopped_at = '2026-03-18T10:00:00Z';`);
  await page.evaluate(() => SPCloud.sync());
  await synced(page);
  ok(/asked to stop/.test(await item.locator('.item-auto').textContent()), 'stopped by client is shown on the invoice');
  await item.locator('[data-act=edit]').click();
  ok(await page.isDisabled('#autoRemindInput'), 'toggle is locked after the client stops reminders');
  await page.click('#invoiceForm [value=cancel]');

  // Marking paid hides the auto status.
  await editDb(page, `d.invoices[0].reminders_stopped_at = null;`);
  await page.evaluate(() => SPCloud.sync());
  await synced(page);
  await item.locator('[data-act=paid]').click();
  await synced(page);
  ok((await item.locator('.item-auto').count()) === 0, 'paid invoice shows no auto reminder');
  ok((await db(page)).invoices[0].paid === true, 'paid synced (the scheduler skips paid invoices)');
  await page.screenshot({ path: OUT + '/invoices-auto-mobile.png', fullPage: true });
  ok(page.errors.length === 0, 'signed in: no console errors ' + page.errors.join(' | '));
  await c.close();

  // ---- Stop page for clients ----
  ({ c, page } = await ctx(browser, { cloud: true, scheme: 'light' }));
  let posted = null;
  await c.route('https://fake.supabase.co/functions/v1/stop-reminders', (r) => {
    posted = r.request().postDataJSON();
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, business: 'Rivera & <b>Photo</b>' }) });
  });
  await page.goto(BASE + 'stop.html?t=0b6a3f1e-1111-4111-8111-111111111111');
  ok(!page.url().includes('?t='), 'token removed from the address bar');
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.querySelector('#stopTitle').textContent === 'Reminders stopped');
  ok(posted && posted.token === '0b6a3f1e-1111-4111-8111-111111111111', 'stop page posts the token');
  ok((await page.textContent('#stopText')).startsWith('Rivera & <b>Photo</b> won’t send') && (await page.locator('#stopText b').count()) === 0, 'business name shown as text, not HTML');
  await page.screenshot({ path: OUT + '/stop-light.png' });
  await page.goto(BASE + 'stop.html');
  ok(/incomplete/.test(await page.textContent('#stopError')) && await page.isHidden('#stopBtn'), 'stop page without a token explains itself');
  await c.close();

  await browser.close();
};

if (require.main === module) module.exports().then(() => process.exit(finish() ? 1 : 0), (e) => { console.error(e); process.exit(1); });
