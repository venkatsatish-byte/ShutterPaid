// Browser tests for the public booking page (book.html): booking, confirmation, calendar files,
// managing (reschedule, cancel), conflicts and accessibility basics. Uses a fake of the booking
// Edge Functions built on the real shared rules (fake-booking-backend.js).
const { chromium } = require('playwright');
const fs = require('fs');
const { BASE, OUT, start, ctx, ok, finish } = require('./harness');
const Fake = require('./fake-booking-backend');

const CLOUD = { supabaseUrl: 'https://fake.supabase.co', supabaseAnonKey: 'anon' };

async function open(browser, db, opts) {
  const o = Object.assign({ config: CLOUD, mobile: true, timezoneId: 'Europe/London' }, opts);
  const { c, page } = await ctx(browser, o);
  await Fake.install(c, db, o.backend);
  return { c, page };
}

// Picks the first open time at least `daysAhead` days out (so it's outside the 24-hour change cutoff).
async function pickFirstSlot(page, daysAhead) {
  await page.waitForSelector('#calGrid .book-day.open');
  const min = new Date(Date.now() + (daysAhead || 0) * 86400000).toISOString().slice(0, 10);
  for (let i = 0; i < 3; i++) {
    const dates = await page.$$eval('#calGrid .book-day.open', (els) => els.map((e) => e.dataset.date));
    const pick = dates.find((d) => d >= min);
    if (pick) { await page.click('#calGrid .book-day[data-date="' + pick + '"]'); break; }
    await page.click('#calNext');
    await page.waitForSelector('#calGrid .book-day.open');
  }
  await page.waitForSelector('#timeList .book-time');
  const label = (await page.locator('#timeList .book-time').first().textContent()).trim();
  const startIso = await page.locator('#timeList .book-time').first().getAttribute('data-start');
  await page.locator('#timeList .book-time').first().click();
  return { label, startIso };
}

async function fillDetails(page, o) {
  const d = Object.assign({ name: 'Priya Shah', email: 'priya@example.com', phone: '+44 20 7946 0000', notes: 'Golden hour if possible' }, o);
  await page.fill('#fName', d.name);
  await page.fill('#fEmail', d.email);
  await page.fill('#fPhone', d.phone);
  if (d.address) await page.fill('#fAddress', d.address);
  await page.fill('#fNotes', d.notes);
  await page.check('#fAccept');
  await page.click('#detailsForm [type=submit]');
}

module.exports = async function run() {
  await start();
  const browser = await chromium.launch();

  // ---- Full booking on a phone, customer in London, photographer in New York ----
  const db = Fake.seed();
  let { c, page } = await open(browser, db);
  await page.goto(BASE + 'book/venkat-photos');
  await page.waitForSelector('#typeList .book-type');
  ok((await page.textContent('#whoName')) === 'Venkat Photos', 'photographer shown from /book/<slug>');
  ok((await page.locator('#typeList .book-type').count()) === 2, 'both bookable event types listed');
  ok(!/advance/i.test(await page.textContent('#typeList')), 'no advance offered while online payments aren\'t set up');
  await page.screenshot({ path: OUT + '/book-step1-mobile.png', fullPage: true });

  await page.locator('#typeList .book-type', { hasText: 'Portrait' }).click();
  await page.waitForSelector('#calGrid .book-day.open');
  ok(/Times are in Europe\/London \(your time zone\)\. The photographer is in America\/New York\./.test(await page.textContent('#tzLabel')), 'time zone labelled: ' + await page.textContent('#tzLabel'));
  ok((await page.locator('#calGrid .book-day[aria-disabled="true"]').count()) > 0, 'days without times are greyed out');
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'stepTitle'), 'focus moves to the step heading');
  // Keyboard: Tab reaches one day, arrows move between days.
  const first = page.locator('#calGrid .book-day[tabindex="0"]');
  await first.focus();
  const before = await first.getAttribute('data-date');
  await page.keyboard.press('ArrowRight');
  const after = await page.evaluate(() => document.activeElement.dataset.date);
  ok(after > before, 'arrow keys move through the calendar');
  const { label, startIso } = await pickFirstSlot(page, 3);
  ok(/for the photographer/.test(await page.locator('#chosenTime').textContent()) === false, 'chosen time shown');
  const londonTime = await page.evaluate((iso) => new Date(iso).toLocaleTimeString(undefined, { timeZone: 'Europe/London', hour: 'numeric', minute: '2-digit' }), startIso);
  const nyHour = Number(new Date(startIso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  ok(nyHour >= 9 && nyHour < 17, 'offered time is within the photographer\'s hours (' + nyHour + ':00 in New York)');
  ok(label.includes('for the photographer'), 'each time also shows the photographer\'s time: ' + label);
  await page.screenshot({ path: OUT + '/book-step2-mobile.png', fullPage: true });

  // Details: validation.
  await page.click('#detailsForm [type=submit]');
  ok(/Enter your name/.test(await page.textContent('#fNameErr')) && (await page.getAttribute('#fName', 'aria-invalid')) === 'true', 'missing name flagged on the field');
  ok(/accept the cancellation policy/.test(await page.textContent('#fAcceptErr')), 'policy must be accepted');
  ok(/24 hours/.test(await page.textContent('#policyBox')) && (await page.locator('#policyBox strong').count()) === 1, 'policy shown with formatting');
  await page.fill('#fEmail', 'not-an-email');
  await fillDetails(page, { email: 'nope' });
  ok(/valid email/.test(await page.textContent('#fEmailErr')), 'invalid email flagged');
  await fillDetails(page);
  ok(/Nothing to pay now/.test(await page.textContent('#payNote')) && await page.isHidden('#payChoice'), 'no payment choice without online advances');
  ok(/Portrait session/.test(await page.textContent('#review')) && /\$300/.test(await page.textContent('#review')), 'review shows the session and price');
  await page.click('#confirmBtn');
  await page.waitForFunction(() => /You're booked/.test(document.querySelector('#doneTitle').textContent));
  ok(true, 'booking confirmed');
  ok(/#manage=[0-9a-f-]{36}$/.test(page.url()), 'address now holds the manage link');
  const booked = db.bookings[0];
  ok(booked && booked.status === 'confirmed' && booked.price === 300 && booked.deposit_amount === 0 && booked.customer_email === 'priya@example.com' && booked.customer_time_zone === 'Europe/London', 'booking stored with server-side price');
  ok(booked.start_at === new Date(startIso).toISOString(), 'stored start matches the chosen time');
  const summary = await page.textContent('#doneSummary');
  ok(summary.includes(londonTime) && summary.includes('Europe/London'), 'confirmation shows the time in London: ' + londonTime);
  ok((await page.locator('#instructions strong').count()) === 1 && /Bring water/.test(await page.textContent('#instructions')), 'event instructions shown');
  ok(/#manage=/.test(await page.textContent('#manageLink')), 'manage link shown');
  const gcal = new URL(await page.getAttribute('#gcalLink', 'href'));
  ok(gcal.hostname === 'calendar.google.com' && gcal.searchParams.get('dates').startsWith(new Date(startIso).toISOString().replace(/[-:]/g, '').slice(0, 15)), 'Google Calendar link has the right time');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#icsBtn')]);
  const ics = fs.readFileSync(await dl.path(), 'utf8');
  ok(/\.ics$/.test(dl.suggestedFilename()) && ics.includes('DTSTART:' + new Date(startIso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')) && /SUMMARY:Portrait session with Venkat Photos/.test(ics), 'calendar file downloads with the right time');
  await page.screenshot({ path: OUT + '/book-done-mobile.png', fullPage: true });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'confirmation fits a phone screen');
  ok(page.errors.length === 0, 'booking: no console errors ' + page.errors.join(' | '));
  const manageHref = page.url();
  await c.close();

  // ---- The booked time is no longer offered ----
  ({ c, page } = await open(browser, db));
  await page.goto(BASE + 'book.html?p=venkat-photos');
  await page.locator('#typeList .book-type', { hasText: 'Portrait' }).click();
  await page.waitForSelector('#calGrid .book-day.open');
  const date = new Date(startIso).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const dayBtn = page.locator('#calGrid .book-day[data-date="' + date + '"]');
  if (!(await dayBtn.count())) { await page.click('#calNext'); await page.waitForSelector('#calGrid .book-day[data-date="' + date + '"]'); }
  if ((await dayBtn.getAttribute('aria-disabled')) !== 'true') {
    await dayBtn.click();
    ok((await page.locator('#timeList [data-start="' + new Date(startIso).toISOString() + '"]').count()) === 0, 'the booked time (and its buffer) is gone for the next customer');
  } else ok(true, 'the booked day is now full');
  await c.close();

  // ---- Two customers, same slot: the second is told and sent back to pick again ----
  const db2 = Fake.seed();
  let racePage;
  ({ c, page: racePage } = await open(browser, db2, { backend: { beforeInsert: async (row) => {
    // Someone else books the same time while this customer is on the review step.
    if (!db2.bookings.length) db2.bookings.push(Object.assign({ id: 'other', status: 'confirmed', manage_token: 'x', customer_email: 'other@x.com' }, row,
      { block_start: row.start_at, block_end: row.end_at }));
  } } }));
  await racePage.goto(BASE + 'book.html?p=venkat-photos');
  await racePage.locator('#typeList .book-type', { hasText: 'Portrait' }).click();
  await pickFirstSlot(racePage);
  await fillDetails(racePage, { email: 'second@example.com' });
  await racePage.click('#confirmBtn');
  await racePage.waitForFunction(() => /someone just booked that time/i.test(document.querySelector('#flowError').textContent));
  ok((await racePage.textContent('#stepTitle')) === 'Choose a date and time', 'double booking refused; customer is back at the calendar with a message');
  ok(db2.bookings.length === 1, 'only one booking was stored');
  await c.close();

  // ---- Manage: reschedule, then cancel ----
  ({ c, page } = await open(browser, db, { timezoneId: 'America/New_York' }));
  await page.goto(manageHref);
  await page.waitForFunction(() => document.querySelector('#doneTitle').textContent === 'Your booking');
  ok(/Confirmed/.test(await page.textContent('#doneSummary')) && /Portrait session/.test(await page.textContent('#doneSummary')), 'manage page shows the booking');
  ok(/You can change this booking online until/.test(await page.textContent('#manageRule')), 'change deadline shown');
  // The harness accepts the "Move your booking to …?" confirmation.
  await page.click('#rescheduleBtn');
  await page.waitForSelector('#calGrid .book-day.open');
  ok((await page.textContent('#stepTitle')) === 'Choose a new date and time', 'reschedule opens the calendar');
  const later = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
  const laterDay = (await page.$$eval('#calGrid .book-day.open', (els) => els.map((e) => e.dataset.date))).find((d) => d >= later);
  if (laterDay) await page.click('#calGrid .book-day[data-date="' + laterDay + '"]');
  else { await page.click('#calNext'); await page.waitForSelector('#calGrid .book-day.open'); await page.locator('#calGrid .book-day.open').first().click(); }
  const newStart = await page.locator('#timeList .book-time').first().getAttribute('data-start');
  await page.locator('#timeList .book-time').first().click();
  await page.waitForFunction(() => document.querySelector('#doneTitle').textContent === 'Your booking has moved');
  ok(db.bookings[0].start_at === new Date(newStart).toISOString() && db.bookings[0].status === 'confirmed', 'booking moved to the new time');
  await page.click('#cancelBtn');
  await page.fill('#cancelReason', 'Moving abroad');
  await page.click('#cancelForm [type=submit]');
  await page.waitForFunction(() => /cancelled/.test(document.querySelector('#doneTitle').textContent));
  ok(db.bookings[0].status === 'cancelled' && /Moving abroad/.test(db.bookings[0].cancel_reason), 'booking cancelled with the reason');
  ok(await page.isHidden('#manageActions') && await page.isHidden('#calButtons'), 'no more changes or calendar buttons after cancelling');
  await c.close();

  // ---- Too close to the session: no online changes ----
  const db3 = Fake.seed();
  const soon = Date.now() + 3 * 3600000;
  db3.bookings.push({ id: 'b-soon', status: 'confirmed', manage_token: '0f0f0f0f-0000-4000-8000-000000000001', event_type_id: Fake.PORTRAIT, event_name: 'Portrait session',
    start_at: new Date(soon).toISOString(), end_at: new Date(soon + 3600000).toISOString(), block_start: new Date(soon).toISOString(), block_end: new Date(soon + 5400000).toISOString(),
    price: 300, currency: 'USD', customer_name: 'Sam', customer_email: 'sam@example.com', customer_phone: '', event_address: '', notes: '', cancel_reason: '' });
  ({ c, page } = await open(browser, db3));
  await page.goto(BASE + 'book.html#manage=0f0f0f0f-0000-4000-8000-000000000001');
  await page.waitForFunction(() => document.querySelector('#doneTitle').textContent === 'Your booking');
  ok(await page.isHidden('#cancelBtn') && await page.isHidden('#rescheduleBtn') && /close 24 hours before/.test(await page.textContent('#manageRule')), 'inside the cutoff: changes closed, reason shown');
  await c.close();

  // ---- Edge cases ----
  ({ c, page } = await open(browser, Fake.seed({ profile: Object.assign(Fake.seed().profile, { accepting: false }) })));
  await page.goto(BASE + 'book/venkat-photos');
  await page.waitForFunction(() => /isn't taking bookings/.test(document.querySelector('#bookStatus').textContent));
  ok(true, 'photographer not taking bookings: clear message');
  await page.goto(BASE + 'book/nobody-here');
  await page.waitForFunction(() => /couldn't find that booking page/.test(document.querySelector('#bookStatus').textContent));
  ok(true, 'unknown booking link: clear message');
  await c.close();

  // Bots filling the hidden field are refused by the server.
  const db4 = Fake.seed();
  ({ c, page } = await open(browser, db4, { mobile: false }));
  await page.goto(BASE + 'book.html?p=venkat-photos');
  await page.locator('#typeList .book-type', { hasText: 'Wedding' }).click();
  await pickFirstSlot(page);
  await page.click('#detailsForm [type=submit]');
  ok(/address/.test(await page.textContent('#fAddressErr')), 'address required for shoots at the customer\'s address');
  await page.evaluate(() => { document.querySelector('[name=website]').value = 'http://spam.example'; });
  await fillDetails(page, { address: '1 Park Ave, New York' });
  await page.click('#confirmBtn');
  await page.waitForFunction(() => document.querySelector('#flowError').textContent.length > 0);
  ok(db4.bookings.length === 0, 'honeypot submission not booked');
  await c.close();

  // ---- Accessibility basics and small screens ----
  ({ c, page } = await open(browser, Fake.seed(), { small: true, mobile: false, scheme: 'light' }));
  await page.goto(BASE + 'book/venkat-photos');
  await page.locator('#typeList .book-type', { hasText: 'Portrait' }).click();
  await page.waitForSelector('#calGrid .book-day.open');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'calendar fits a 320px screen');
  const unlabeled = await page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]):not([name=website]), select, textarea')]
    .filter((el) => !(el.labels && el.labels.length) && !el.getAttribute('aria-label')).map((el) => el.id || el.name));
  ok(unlabeled.length === 0, 'every form field has a label ' + unlabeled.join(','));
  const unnamedButtons = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => !b.hidden && !(b.textContent.trim() || b.getAttribute('aria-label'))).length);
  ok(unnamedButtons === 0, 'every button has a name');
  await page.screenshot({ path: OUT + '/book-calendar-320-light.png', fullPage: true });
  await c.close();

  await browser.close();
};

if (require.main === module) module.exports().then(() => process.exit(finish() ? 1 : 0), (e) => { console.error(e); process.exit(1); });
