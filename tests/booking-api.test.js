// Tests for the public booking functions' rules, calendar files and the confirmation email.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../supabase/functions/_shared/booking-api.js');
const I = require('../js/ics.js');
const E = require('../supabase/functions/_shared/booking-email.js');

const NY = 'America/New_York';
const ET = '0b6a3f1e-1111-4111-8111-111111111111';
const profileRow = { user_id: 'u1', slug: 'venkat-photos', display_name: 'Venkat', photo_url: '', bio: 'Hi', time_zone: NY, accepting: true,
  min_notice_minutes: 60, max_days_ahead: 30, max_per_day: null, cancellation_policy: 'Refundable up to 7 days before.',
  allow_customer_cancel: true, allow_customer_reschedule: true, change_cutoff_hours: 24 };
const etRow = { id: ET, user_id: 'u1', name: 'Portrait', description: 'One hour', duration_minutes: 60, buffer_before: 0, buffer_after: 30,
  location_type: 'studio', location_details: '12 Main St', price: 300, currency: 'USD', deposit_mode: 'optional', deposit_type: 'percent',
  deposit_value: 25, instructions: '**Bring** water', cancellation_policy: '', active: true, sort_order: 0 };
const hourRows = [{ weekday: 2, start_time: '09:00:00', end_time: '12:00:00' }];
const now = Date.parse('2026-06-01T12:00:00Z');
const ctx = (o) => Object.assign({ profileRow, eventTypeRow: etRow, hourRows, blockedRows: [], bookingRows: [], now, advancePaymentsAvailable: false }, o);
const input = (o) => Object.assign({ slug: 'venkat-photos', event_type_id: ET, start: '2026-06-02T13:00:00.000Z', name: '  Priya   Shah ', email: 'Priya@Example.com',
  phone: '+1 555 0100', address: '', notes: 'Golden hour please', accept_policy: true, tz: 'Europe/London' }, o);

test('publicPage shows only bookable event types and hides advances until payments work', () => {
  const page = A.publicPage(profileRow, [etRow, Object.assign({}, etRow, { id: 'x', active: false }), Object.assign({}, etRow, { id: 'y', user_id: 'other' })], {});
  assert.equal(page.eventTypes.length, 1);
  assert.equal(page.eventTypes[0].advanceAmount, 0);
  assert.equal(page.eventTypes[0].cancellationPolicy, 'Refundable up to 7 days before.');
  assert.equal(A.publicPage(profileRow, [etRow], { advancePaymentsAvailable: true }).eventTypes[0].advanceAmount, 75);
  assert.ok(!('user_id' in page) && !('instructions' in page.eventTypes[0]), 'no private fields');
  assert.throws(() => A.publicPage(Object.assign({}, profileRow, { accepting: false }), [etRow]), (e) => e.status === 404);
});

test('parseBookingInput cleans and validates customer details', () => {
  const v = A.parseBookingInput(input(), etRow);
  assert.equal(v.name, 'Priya Shah');
  assert.equal(v.email, 'priya@example.com');
  assert.equal(v.timeZone, 'Europe/London');
  assert.equal(v.payAdvance, false);
  const err = (o, et) => { try { A.parseBookingInput(input(o), et || etRow); } catch (e) { return e; } return null; };
  assert.deepEqual(Object.keys(err({ name: '', email: 'nope', phone: 'call me', accept_policy: false }).fields).sort(), ['accept_policy', 'email', 'name', 'phone']);
  assert.ok(err({ address: '' }, Object.assign({}, etRow, { location_type: 'customer_address' })).fields.address);
  assert.equal(err({ website: 'http://spam' }).status, 400); // honeypot
  assert.equal(err({ start: 'tomorrow' }).status, 400);
  assert.equal(err({ accept_policy: 'yes' }).fields.accept_policy, 'Please accept the cancellation policy.');
});

test('checkSlot accepts only real open slots', () => {
  const start = Date.parse('2026-06-02T13:00:00Z'); // 9:00 New York
  assert.deepEqual(A.checkSlot(start, ctx()), { start, end: start + 3600000 });
  for (const bad of ['2026-06-02T13:10:00Z', '2026-06-02T12:00:00Z', '2026-06-03T13:00:00Z', '2026-08-04T13:00:00Z']) {
    assert.throws(() => A.checkSlot(Date.parse(bad), ctx()), (e) => e.status === 409, bad);
  }
  const taken = { id: 'b1', status: 'confirmed', start_at: '2026-06-02T13:00:00Z', block_start: '2026-06-02T13:00:00Z', block_end: '2026-06-02T14:30:00Z' };
  assert.throws(() => A.checkSlot(start, ctx({ bookingRows: [taken] })), (e) => e.status === 409);
  // Rescheduling the same booking: it doesn't block itself.
  assert.ok(A.checkSlot(start, ctx({ bookingRows: [taken], excludeBookingId: 'b1' })));
  // Within the minimum notice.
  assert.throws(() => A.checkSlot(start, ctx({ now: Date.parse('2026-06-02T12:30:00Z') })), (e) => e.status === 409);
});

test('bookingRow: server-side price and advance, hold only when paying', () => {
  const v = A.parseBookingInput(input(), etRow);
  const slot = A.checkSlot(v.start, ctx());
  const row = A.bookingRow(v, ctx(), slot);
  assert.equal(row.status, 'confirmed');
  assert.equal(row.price, 300);
  assert.equal(row.deposit_amount, 0);
  assert.equal(row.expires_at, null);
  assert.equal(row.buffer_after, 30);
  assert.equal(row.end_at, '2026-06-02T14:00:00.000Z');
  assert.throws(() => A.bookingRow(Object.assign({}, v, { payAdvance: true }), ctx(), slot), (e) => e.status === 409);
  const held = A.bookingRow(Object.assign({}, v, { payAdvance: true }), ctx({ advancePaymentsAvailable: true }), slot);
  assert.equal(held.status, 'pending_payment');
  assert.equal(held.deposit_amount, 75);
  assert.equal(held.expires_at, new Date(now + 10 * 60000).toISOString());
});

test('dayBounds and errors', () => {
  const d = A.dayBounds(Date.parse('2026-06-02T13:00:00Z'), NY);
  assert.deepEqual([d.day, new Date(d.start).toISOString(), new Date(d.end).toISOString()], ['2026-06-02', '2026-06-02T04:00:00.000Z', '2026-06-03T04:00:00.000Z']);
  assert.equal(A.bookingError({ message: 'SLOT_TAKEN' }).status, 409);
  assert.match(A.bookingError({ message: 'DAY_FULL' }).message, /filled up/);
  assert.equal(A.bookingError({ message: 'other' }), null);
});

test('change rules: cutoff, settings and status', () => {
  const b = { status: 'confirmed', start_at: '2026-06-05T13:00:00Z' };
  assert.deepEqual([A.changeRules(b, profileRow, now).canCancel, A.changeRules(b, profileRow, now).canReschedule], [true, true]);
  const late = A.changeRules(b, profileRow, Date.parse('2026-06-04T14:00:00Z'));
  assert.equal(late.canCancel, false);
  assert.match(late.reason, /close 24 hours before/);
  assert.equal(A.changeRules(b, Object.assign({}, profileRow, { allow_customer_reschedule: false }), now).canReschedule, false);
  assert.equal(A.changeRules(Object.assign({}, b, { status: 'cancelled' }), profileRow, now).canCancel, false);
});

test('manage view: payments, policy, instructions and other bookings', () => {
  const b = { id: 'b1', status: 'confirmed', event_name: 'Portrait', event_type_id: ET, start_at: '2026-06-05T13:00:00Z', end_at: '2026-06-05T14:00:00Z',
    customer_name: 'Priya', customer_email: 'p@x.com', customer_phone: '', event_address: '', notes: '', price: 300, currency: 'USD', manage_token: 't1' };
  const v = A.manageView(b, { profileRow, eventTypeRow: etRow, now,
    paymentRows: [{ status: 'partially_refunded', amount: 75, amount_refunded: 25 }],
    otherRows: [b, Object.assign({}, b, { id: 'b2', manage_token: 't2', start_at: '2026-06-20T13:00:00Z', end_at: '2026-06-20T14:00:00Z' }),
      Object.assign({}, b, { id: 'b3', status: 'cancelled', manage_token: 't3' })] });
  assert.deepEqual(v.payment, { price: 300, currency: 'USD', advancePaid: 50, refunded: 25, balance: 250, status: 'advance_paid' });
  assert.equal(v.instructions, '**Bring** water');
  assert.equal(v.cancellationPolicy, 'Refundable up to 7 days before.');
  assert.deepEqual(v.others.map((o) => o.token), ['t2']);
  assert.equal(v.location.details, '12 Main St');
  assert.equal(A.parseManageAction({ token: 'b0000000-0000-4000-8000-000000000001', action: 'cancel', reason: ' Sick ' }).reason, 'Sick');
  assert.throws(() => A.parseManageAction({ token: 'nope', action: 'cancel' }), (e) => e.status === 400);
  assert.throws(() => A.parseManageAction({ token: 'b0000000-0000-4000-8000-000000000001', action: 'delete' }), (e) => e.status === 400);
});

test('ics file: escaping, folding, UTC times', () => {
  const ics = I.buildIcs({ uid: 'b1@shutterpaid', start: '2026-06-02T13:00:00Z', end: '2026-06-02T14:00:00Z', now: Date.parse('2026-06-01T00:00:00Z'),
    title: 'Portrait, with Venkat; studio', description: 'Line one\nLine two ' + 'x'.repeat(100), location: '12 Main St', url: 'https://app.example/book.html#manage=t' });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20260602T130000Z\r\nDTEND:20260602T140000Z/);
  assert.match(ics, /SUMMARY:Portrait\\, with Venkat\; studio/);
  assert.match(ics, /DESCRIPTION:Line one\\nLine two/);
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'lines folded to 75 bytes');
  assert.match(ics, /END:VCALENDAR\r\n$/);
  const g = new URL(I.googleCalendarUrl({ title: 'Portrait', start: '2026-06-02T13:00:00Z', end: '2026-06-02T14:00:00Z', location: 'Studio' }));
  assert.equal(g.searchParams.get('dates'), '20260602T130000Z/20260602T140000Z');
  assert.equal(g.searchParams.get('text'), 'Portrait');
});

test('confirmation email: details, manage link, safe instructions', () => {
  const m = E.confirmation({ customerName: 'Priya <b>', photographerName: 'Venkat & Co', eventName: 'Portrait', start: '2026-06-02T13:00:00Z', end: '2026-06-02T14:00:00Z',
    timeZone: NY, location: 'Studio · 12 Main St', price: 300, currency: 'USD', advancePaid: 0, instructions: '**Bring** water\n<script>x</script>',
    policy: 'Refundable up to 7 days before.', manageUrl: 'https://app.example/book.html#manage=abc' });
  assert.equal(m.subject, 'Booked: Portrait with Venkat & Co');
  assert.match(m.text, /Tuesday, June 2, 2026 at 9:00 AM – 10:00 AM EDT/);
  assert.match(m.text, /View, reschedule or cancel your booking: https:\/\/app\.example\/book\.html#manage=abc/);
  assert.match(m.text, /Price: \$300, paid to Venkat & Co later\./);
  assert.ok(m.html.includes('Priya &lt;b&gt;') && m.html.includes('<strong>Bring</strong>') && !m.html.includes('<script>'));
  assert.match(E.confirmation({ customerName: 'P', photographerName: 'V', eventName: 'E', start: '2026-06-02T13:00:00Z', end: '2026-06-02T14:00:00Z', timeZone: NY,
    price: 300, currency: 'USD', advancePaid: 75, manageUrl: 'u' }).text, /Paid in advance: \$75\. Balance: \$225\./);
});
