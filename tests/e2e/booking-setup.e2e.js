// Browser tests for bookings phase 1: the photographer's booking setup in the Bookings tab.
const { chromium } = require('playwright');
const { BASE, OUT, start, ctx, ok, waitToast, db, editDb, synced, signIn, finish } = require('./harness');

// 1×1 PNG, used for the photo upload and as the "uploaded" photo the page then loads.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

module.exports = async function run() {
  await start();
  const browser = await chromium.launch();

  // ---- Local-only: no Bookings tab ----
  let { c, page } = await ctx(browser);
  await page.goto(BASE + 'app.html');
  ok(await page.isHidden('.tabbar [data-view=booking]'), 'local-only: no Bookings tab');
  await c.close();

  // ---- Signed in ----
  ({ c, page } = await ctx(browser, { cloud: true, mobile: true }));
  await c.route('https://fake.supabase.co/storage/**', (r) => r.fulfill({ contentType: 'image/png', body: PNG }));
  await page.goto(BASE + 'app.html');
  // Another photographer already uses "taken-name".
  await page.evaluate(() => localStorage.setItem('__fakedb', JSON.stringify({ invoices: [], reminder_log: [], profiles: [],
    booking_profiles: [{ user_id: '99999999-9999-4999-8999-999999999999', slug: 'taken-name', display_name: 'Someone' }] })));
  await signIn(page, 'a@x.com', { quick: true });
  await synced(page);
  ok(await page.isVisible('.tabbar [data-view=booking]'), 'Bookings tab appears when signed in');
  await page.click('.tabbar [data-view=settings]');
  await page.fill('[name=businessName]', 'Venkat Photos');
  await page.click('#settingsForm button[type=submit]');
  await page.click('.tabbar [data-view=booking]');

  ok((await page.locator('#bkChecklist li').count()) === 3, 'checklist shows 3 setup steps');
  await page.locator('label.switch').click();
  ok(!(await page.isChecked('#bkAccepting')) && await waitToast(page, /Finish the steps/), "can't accept bookings before setup is done");
  ok((await page.inputValue('#bkProfileForm [name=displayName]')) === 'Venkat Photos' && (await page.inputValue('#bkProfileForm [name=slug]')) === 'venkat-photos', 'name and link suggested from business name');
  ok((await page.locator('#bkWeek [data-open]:checked').count()) === 5, 'new photographers start with Monday to Friday');

  // Booking link validation.
  const slug = page.locator('#bkProfileForm [name=slug]');
  const saveProfile = () => page.click('#bkProfileForm button[type=submit]');
  await slug.fill('admin');
  await saveProfile();
  ok(/reserved/.test(await page.textContent('#bkProfileError')), 'reserved link rejected');
  await slug.fill('taken-name');
  await saveProfile();
  await page.waitForFunction(() => /taken/.test(document.querySelector('#bkProfileError').textContent));
  ok(true, 'link used by another photographer rejected');
  await slug.fill('Venkat Photos!!');
  await slug.blur();
  ok((await slug.inputValue()) === 'venkat-photos', 'link cleaned up as you type');
  await page.fill('#bkProfileForm [name=bio]', 'Wedding & family photographer in <b>Atlanta</b>.');
  await page.fill('#bkProfileForm [name=timeZone]', 'Mars/Base');
  await saveProfile();
  ok(/time zone/.test(await page.textContent('#bkProfileError')), 'invalid time zone rejected');
  await page.fill('#bkProfileForm [name=timeZone]', 'America/New_York');
  await saveProfile();
  ok(await waitToast(page, /Booking page created/), 'booking page created');
  await synced(page);
  let d = await db(page);
  let mine = d.booking_profiles.find((p) => p.user_id.startsWith('1111'));
  ok(mine && mine.slug === 'venkat-photos' && mine.time_zone === 'America/New_York' && mine.accepting === false, 'profile saved to the account');
  ok(/\/book\/venkat-photos$/.test(await page.textContent('#bkLink')), 'booking link shown: ' + await page.textContent('#bkLink'));

  // Photo upload.
  await page.setInputFiles('#bkPhotoInput', { name: 'me.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForFunction(() => !document.querySelector('#bkPhoto').hidden);
  await synced(page);
  d = await db(page);
  mine = d.booking_profiles.find((p) => p.user_id.startsWith('1111'));
  ok(/booking-photos\/11111111-[^/]+\/avatar-\d+\.jpg$/.test(mine.photo_url), 'photo uploaded into the photographer\'s folder: ' + mine.photo_url);

  // ---- Event types ----
  await page.click('#bkAddType');
  await page.selectOption('#etForm [name=preset]', 'portrait');
  ok((await page.inputValue('#etForm [name=name]')) === 'Portrait session' && (await page.inputValue('#etForm [name=durationMinutes]')) === '60', 'preset fills in the event type');
  await page.fill('#etForm [name=price]', '300');
  await page.check('#etForm [name=depositMode][value=optional]');
  await page.fill('#etForm [name=depositValue]', '25');
  ok(/pay \$75 now and \$225 later, or book without paying/.test(await page.textContent('#etDepositSummary')), 'advance summary: ' + await page.textContent('#etDepositSummary'));
  await page.selectOption('#etForm [name=depositType]', 'fixed');
  await page.fill('#etForm [name=depositValue]', '400');
  await page.click('#etForm button[type=submit]');
  ok(/more than the price/.test(await page.textContent('#etError')), 'advance above the price rejected');
  await page.fill('#etForm [name=depositValue]', '100');
  await page.fill('#etForm [name=instructions]', '**Wear** solid colours\n- Bring water\n<script>alert(1)</script>\n[Shot list](https://forms.example.com/s)');
  await page.click('#etForm [data-md-tab=preview]');
  const preview = page.locator('#etForm .md-preview');
  ok((await preview.locator('strong').count()) === 1 && (await preview.locator('li').count()) === 1 && (await preview.locator('script').count()) === 0 &&
    (await preview.locator('a[href="https://forms.example.com/s"]').count()) === 1, 'instructions preview: formatting and links, no scripts');
  await page.screenshot({ path: OUT + '/event-type-mobile.png' });
  await page.click('#etForm button[type=submit]');
  ok(await waitToast(page, /Event type added/), 'event type added');
  await synced(page);
  d = await db(page);
  const et = d.event_types[0];
  ok(et && et.name === 'Portrait session' && et.price === 300 && et.deposit_mode === 'optional' && et.deposit_type === 'fixed' && et.deposit_value === 100 && /\*\*Wear\*\*/.test(et.instructions), 'event type saved to the account');
  ok(/Optional advance \$100/.test(await page.textContent('#bkTypeList')), 'list shows the advance');
  await page.click('#bkTypeList [data-et-act=toggle]');
  await synced(page);
  ok((await db(page)).event_types[0].active === false && /Hidden/.test(await page.textContent('#bkTypeList')), 'event type can be hidden from clients');
  await page.click('#bkTypeList [data-et-act=toggle]');

  // ---- Weekly hours ----
  const sat = page.locator('.bk-day[data-day="6"]');
  await sat.locator('[data-open]').check();
  await sat.locator('[data-start]').fill('10:00');
  await sat.locator('[data-end]').fill('14:00');
  await sat.locator('[data-add]').click();
  await sat.locator('[data-start]').nth(1).fill('13:00');
  await sat.locator('[data-end]').nth(1).fill('16:00');
  await page.selectOption('#bkHoursForm [name=minNotice]', '2880');
  await page.fill('#bkHoursForm [name=maxPerDay]', '2');
  await page.click('#bkHoursForm button[type=submit]');
  ok(/Saturday: Time ranges on the same day overlap/.test(await page.textContent('#bkHoursError')), 'overlapping hours rejected');
  await sat.locator('[data-start]').nth(1).fill('15:00');
  await page.click('#bkHoursForm button[type=submit]');
  ok(await waitToast(page, /Availability saved/), 'availability saved');
  await synced(page);
  d = await db(page);
  mine = d.booking_profiles.find((p) => p.user_id.startsWith('1111'));
  ok(d.availability_rules.length === 7 && d.availability_rules.filter((h) => h.weekday === 6).length === 2, 'weekly hours saved (5 weekdays + 2 Saturday ranges)');
  ok(mine.min_notice_minutes === 2880 && mine.max_per_day === 2 && mine.max_days_ahead === 90, 'booking window saved');

  // ---- Days off ----
  await page.fill('#bkBlockedForm [name=startDate]', '2026-12-20');
  await page.fill('#bkBlockedForm [name=endDate]', '2026-12-10');
  await page.click('#bkBlockedForm button[type=submit]');
  ok(/on or after/.test(await page.textContent('#bkBlockedError')), 'backwards date range rejected');
  await page.fill('#bkBlockedForm [name=endDate]', '2027-01-02');
  await page.fill('#bkBlockedForm [name=note]', 'Holidays');
  await page.click('#bkBlockedForm button[type=submit]');
  await synced(page);
  ok((await db(page)).blocked_dates.length === 1 && /Holidays/.test(await page.textContent('#bkBlockedList')), 'days off saved');

  // ---- Policy and switching bookings on ----
  await page.fill('#bkPolicyForm [name=policy]', 'Advances are refundable up to **14 days** before.');
  await page.click('#bkPolicyForm button[type=submit]');
  await page.locator('label.switch').click();
  ok(await page.isChecked('#bkAccepting') && await waitToast(page, /Bookings are on/), 'bookings switched on once setup is complete');
  await synced(page);
  mine = (await db(page)).booking_profiles.find((p) => p.user_id.startsWith('1111'));
  ok(mine.accepting === true && /14 days/.test(mine.cancellation_policy), 'policy and on switch saved');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Bookings tab fits a phone screen');
  await page.screenshot({ path: OUT + '/booking-setup-mobile.png', fullPage: true });

  // ---- Offline edits queue and sync ----
  await page.evaluate(() => { localStorage.setItem('__offline', '1'); window.dispatchEvent(new Event('offline')); });
  await page.click('#bkTypeList [data-et-act=edit]');
  await page.fill('#etForm [name=name]', 'Portrait (offline edit)');
  await page.click('#etForm button[type=submit]');
  await page.waitForTimeout(500);
  ok((await db(page)).event_types[0].name === 'Portrait session', 'nothing sent while offline');
  await page.evaluate(() => { localStorage.removeItem('__offline'); window.dispatchEvent(new Event('online')); });
  await synced(page);
  ok((await db(page)).event_types[0].name === 'Portrait (offline edit)', 'offline edit synced after reconnecting');

  // ---- Changes from another device arrive ----
  await editDb(page, `d.event_types[0].name = 'Renamed elsewhere'; d.blocked_dates = [];`);
  await page.evaluate(() => SPCloud.sync());
  await synced(page);
  ok(/Renamed elsewhere/.test(await page.textContent('#bkTypeList')) && /No days off/.test(await page.textContent('#bkBlockedList')), 'edits from another device show up');

  // ---- A confirmed booking's invoice with a paid advance (created by the database trigger) ----
  await editDb(page, `d.invoices.push({ id: '0c0c0c0c-0000-4000-8000-000000000001', user_id: '11111111-1111-4111-8111-111111111111',
    client_name: 'Priya (booked online)', client_email: 'priya@example.com', shoot_type: 'Portrait session', number: 'BK-ABC123',
    amount: 300, amount_paid: 75, booking_id: 'b0000000-0000-4000-8000-000000000001', currency: 'USD', shoot_date: '2030-01-10',
    due_date: '2030-01-10', notes: 'Booked online.', paid: false, paid_date: null, auto_remind: false, reminder_schedule: null });`);
  await page.evaluate(() => SPCloud.sync());
  await synced(page);
  await page.click('.tabbar [data-view=invoices]');
  const bk = page.locator('#invoiceList .item', { hasText: 'Priya (booked online)' });
  ok(/\$225/.test(await bk.locator('.item-amount').textContent()) && /\$75 paid in advance/.test(await bk.textContent()), 'booking invoice shows the balance and the advance paid');
  await page.click('.tabbar [data-view=dashboard]');
  ok((await page.textContent('#statOutstanding')) === '$225', 'outstanding total counts only the balance: ' + await page.textContent('#statOutstanding'));
  await page.click('.tabbar [data-view=invoices]');
  await bk.locator('[data-act=pdf]').click();
  const sheet = await page.textContent('#docPreview');
  ok(/Paid in advance−\$75Balance due\$225/.test(sheet) && /DescriptionAmountPortrait sessionSession on/.test(sheet), 'PDF shows paid in advance and balance due');
  await page.click('#docClose');
  await bk.locator('[data-act=remind]').click();
  ok(/\$225 \(the balance after your advance of \$75\)/.test(await page.inputValue('#reminderBody')), 'reminder asks for the balance');
  await page.click('#reminderCancel');
  await page.click('.tabbar [data-view=booking]');

  // ---- Before the booking migration is applied, invoices still sync ----
  await page.evaluate(() => { window.__failTables = ['booking_profiles']; });
  await page.evaluate(() => SPCloud.sync());
  await synced(page);
  ok(/Renamed elsewhere/.test(await page.textContent('#bkTypeList')), 'missing booking tables don\'t break sync or wipe local setup');
  page.errors = page.errors.filter((e) => !/Booking setup not available/.test(e));
  ok(page.errors.length === 0, 'booking setup: no console errors ' + page.errors.join(' | '));
  await c.close();

  // Light theme screenshot of the event type dialog.
  ({ c, page } = await ctx(browser, { cloud: true, scheme: 'light' }));
  await page.goto(BASE + 'app.html');
  await signIn(page, 'b@x.com', { quick: true });
  await synced(page);
  await page.click('.tabbar [data-view=booking]');
  await page.screenshot({ path: OUT + '/booking-setup-light.png', fullPage: true });
  await c.close();

  await browser.close();
};

if (require.main === module) module.exports().then(() => process.exit(finish() ? 1 : 0), (e) => { console.error(e); process.exit(1); });
