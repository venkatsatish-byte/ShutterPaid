// Tests for slot calculation (js/slots.js): time zones, daylight saving, buffers, notice, limits.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/slots.js');

const NY = 'America/New_York';
const iso = (ms) => new Date(ms).toISOString();
const base = (o) => Object.assign({
  profile: { timeZone: NY, minNoticeMinutes: 0, maxDaysAhead: 90, maxPerDay: '' },
  eventType: { durationMinutes: 60, bufferBefore: 0, bufferAfter: 0 },
  hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '12:00' })),
  blocked: [],
  bookings: [],
  now: Date.parse('2026-06-01T00:00:00Z'),
  from: '2026-06-02T04:00:00Z', // midnight in New York (EDT, UTC-4)
  to: '2026-06-03T04:00:00Z',
  step: 60
}, o);
const starts = (o) => S.availableSlots(base(o)).map((s) => iso(s.start));

test('time zone helpers', () => {
  assert.equal(S.zonedToUtc('2026-06-02', 9 * 60, NY), Date.parse('2026-06-02T13:00:00Z'));
  assert.equal(S.zonedToUtc('2026-01-15', 9 * 60, NY), Date.parse('2026-01-15T14:00:00Z'));
  assert.equal(S.zonedToUtc('2026-06-02', 9 * 60, 'Asia/Kolkata'), Date.parse('2026-06-02T03:30:00Z'));
  assert.deepEqual(S.zoned(Date.parse('2026-06-02T13:00:00Z'), NY), { date: '2026-06-02', minutes: 540, time: '09:00', weekday: 2 });
  assert.equal(S.offsetMinutes(Date.parse('2026-01-15T12:00:00Z'), NY), -300);
  assert.equal(S.offsetMinutes(Date.parse('2026-06-15T12:00:00Z'), 'Asia/Kolkata'), 330);
  assert.equal(S.validTimeZone('Mars/Base'), false);
});

test('slots follow working hours in the photographer\'s time zone', () => {
  assert.deepEqual(starts(), ['2026-06-02T13:00:00.000Z', '2026-06-02T14:00:00.000Z', '2026-06-02T15:00:00.000Z']);
  // 30-minute steps, 90-minute session in a 9–12 window: 9:00, 9:30, 10:00, 10:30.
  assert.equal(starts({ step: 30, eventType: { durationMinutes: 90 } }).length, 4);
  // A session longer than the window never fits.
  assert.deepEqual(starts({ eventType: { durationMinutes: 240 } }), []);
  // Several ranges in a day.
  assert.equal(starts({ hours: [{ weekday: 2, start: '09:00', end: '10:00' }, { weekday: 2, start: '14:00', end: '16:00' }] }).length, 3);
  // Closed days have nothing (2026-06-02 is a Tuesday).
  assert.deepEqual(starts({ hours: [{ weekday: 3, start: '09:00', end: '12:00' }] }), []);
});

test('spring forward: 9:00 stays 9:00 local, and the skipped hour is never offered', () => {
  // US clocks go forward on 2026-03-08 at 02:00 (02:00–02:59 doesn't exist).
  const o = { from: '2026-03-07T05:00:00Z', to: '2026-03-09T04:00:00Z', now: Date.parse('2026-03-01T00:00:00Z') };
  const s = starts(Object.assign({ hours: [6, 0].map((weekday) => ({ weekday, start: '09:00', end: '10:00' })) }, o));
  assert.deepEqual(s, ['2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z']); // EST then EDT
  // Hours 01:00–04:00 that night: 01:00 EST is offered (an hour later the clock reads 03:00),
  // 02:00 doesn't exist, and 03:00 EDT is offered.
  const night = starts(Object.assign({ hours: [{ weekday: 0, start: '01:00', end: '04:00' }] }, o));
  assert.deepEqual(night, ['2026-03-08T06:00:00.000Z', '2026-03-08T07:00:00.000Z']);
  assert.equal(S.zonedToUtc('2026-03-08', 150, NY), null); // 02:30 doesn't exist
});

test('fall back: repeated hour uses the first occurrence, no duplicates', () => {
  // US clocks go back on 2026-11-01 at 02:00 (01:00–01:59 happens twice).
  const o = { from: '2026-11-01T04:00:00Z', to: '2026-11-02T05:00:00Z', now: Date.parse('2026-10-25T00:00:00Z'), hours: [{ weekday: 0, start: '00:00', end: '03:00' }] };
  const s = starts(o);
  assert.deepEqual(s, ['2026-11-01T04:00:00.000Z', '2026-11-01T05:00:00.000Z', '2026-11-01T07:00:00.000Z']);
  assert.equal(new Set(s).size, s.length);
  assert.equal(S.zonedToUtc('2026-11-01', 90, NY), Date.parse('2026-11-01T05:30:00Z')); // first 01:30 (EDT)
});

test('Europe changes on a different weekend', () => {
  const o = {
    profile: { timeZone: 'Europe/London', minNoticeMinutes: 0, maxDaysAhead: 90 },
    hours: [6, 0].map((weekday) => ({ weekday, start: '10:00', end: '11:00' })),
    from: '2026-03-28T00:00:00Z', to: '2026-03-30T00:00:00Z', now: Date.parse('2026-03-20T00:00:00Z')
  };
  assert.deepEqual(starts(o), ['2026-03-28T10:00:00.000Z', '2026-03-29T09:00:00.000Z']); // GMT then BST
});

test('existing bookings and buffers', () => {
  const booking = { startAt: '2026-06-02T14:00:00Z', blockStart: '2026-06-02T14:00:00Z', blockEnd: '2026-06-02T15:00:00Z' };
  assert.deepEqual(starts({ bookings: [booking] }), ['2026-06-02T13:00:00.000Z', '2026-06-02T15:00:00.000Z']);
  // The new event's own 30-minute buffers make 9:00 and 11:00 collide with a 10:00 booking too.
  assert.deepEqual(starts({ bookings: [booking], eventType: { durationMinutes: 60, bufferBefore: 30, bufferAfter: 30 } }), []);
  // An existing booking's buffer blocks the neighbouring slot.
  // 10:00–11:00 booking with a 30-minute buffer after: busy 10:00–11:30, so of the 30-minute steps
  // (9:00 ... 11:00) only 9:00 is left.
  const withBuffer = Object.assign({}, booking, { blockEnd: '2026-06-02T15:30:00Z' });
  assert.deepEqual(starts({ bookings: [withBuffer], step: 30 }), ['2026-06-02T13:00:00.000Z']);
  // Touching edges are fine: a 9:00–10:00 slot next to a 10:00 booking.
  assert.ok(starts({ bookings: [booking] }).includes('2026-06-02T13:00:00.000Z'));
});

test('minimum notice and maximum days ahead', () => {
  const now = Date.parse('2026-06-02T13:30:00Z'); // 09:30 in New York
  assert.deepEqual(starts({ now }), ['2026-06-02T14:00:00.000Z', '2026-06-02T15:00:00.000Z']);
  // 90 minutes from 09:30 is 11:00: the 11:00 start is just allowed; 2 hours (11:30) rules it out.
  assert.deepEqual(starts({ now, profile: { timeZone: NY, minNoticeMinutes: 90, maxDaysAhead: 90 } }), ['2026-06-02T15:00:00.000Z']);
  assert.deepEqual(starts({ now, profile: { timeZone: NY, minNoticeMinutes: 120, maxDaysAhead: 90 } }), []);
  assert.deepEqual(starts({ now, profile: { timeZone: NY, minNoticeMinutes: 1440, maxDaysAhead: 90 } }), []);
  // Max days ahead counts calendar days in the photographer's zone from today.
  const far = { from: '2026-06-02T04:00:00Z', to: '2026-06-06T04:00:00Z', now: Date.parse('2026-06-01T16:00:00Z') };
  const days = (n) => new Set(starts(Object.assign({ profile: { timeZone: NY, minNoticeMinutes: 0, maxDaysAhead: n } }, far)).map((s) => s.slice(0, 10))).size;
  assert.equal(days(2), 2); // June 2 and 3
  assert.equal(days(30), 4);
});

test('days off and max bookings per day', () => {
  assert.deepEqual(starts({ blocked: [{ startDate: '2026-06-01', endDate: '2026-06-02' }] }), []);
  assert.equal(starts({ blocked: [{ startDate: '2026-06-03', endDate: '2026-06-10' }] }).length, 3);
  const morning = { startAt: '2026-06-02T13:00:00Z', blockStart: '2026-06-02T13:00:00Z', blockEnd: '2026-06-02T14:00:00Z' };
  assert.equal(starts({ bookings: [morning], profile: { timeZone: NY, minNoticeMinutes: 0, maxDaysAhead: 90, maxPerDay: 2 } }).length, 2);
  assert.deepEqual(starts({ bookings: [morning], profile: { timeZone: NY, minNoticeMinutes: 0, maxDaysAhead: 90, maxPerDay: 1 } }), []);
});

test('presentSlots groups by the customer\'s date and shows both times', () => {
  const slots = S.availableSlots(base({ hours: [{ weekday: 2, start: '20:00', end: '22:00' }], to: '2026-06-03T04:00:00Z' }));
  // 20:00 and 21:00 in New York are 05:30 and 06:30 the next day in Kolkata.
  const days = S.presentSlots(slots, 'Asia/Kolkata', NY);
  assert.deepEqual(days.map((d) => d.date), ['2026-06-03']);
  assert.deepEqual(days[0].slots.map((s) => [s.time, s.photographerDate, s.photographerTime]), [['05:30', '2026-06-02', '20:00'], ['06:30', '2026-06-02', '21:00']]);
  assert.equal(days[0].slots[0].start, '2026-06-03T00:00:00.000Z');
});

test('bad input gives no slots instead of an error', () => {
  assert.deepEqual(starts({ profile: { timeZone: 'Mars/Base', minNoticeMinutes: 0, maxDaysAhead: 30 } }), []);
  assert.deepEqual(starts({ from: '2026-06-03T00:00:00Z', to: '2026-06-02T00:00:00Z' }), []);
  assert.deepEqual(starts({ hours: [] }), []);
});

// ---------- get-available-slots (request checks and response) ----------
const A = require('../supabase/functions/_shared/slots-api.js');
const ET_ID = '0b6a3f1e-1111-4111-8111-111111111111';
const profileRow = { user_id: 'u1', slug: 'venkat-photos', display_name: 'Venkat', photo_url: '', bio: '', time_zone: NY, accepting: true, min_notice_minutes: 0, max_days_ahead: 30, max_per_day: null, cancellation_policy: '' };
const etRow = { id: ET_ID, user_id: 'u1', name: 'Portrait', description: '', duration_minutes: 60, buffer_before: 0, buffer_after: 0, location_type: 'studio', location_details: '', price: 300, currency: 'USD', deposit_mode: 'optional', deposit_type: 'percent', deposit_value: 25, instructions: '', cancellation_policy: '', active: true, sort_order: 0 };
const hourRows = [{ weekday: 2, start_time: '09:00:00', end_time: '11:00:00' }];
const q = (o) => Object.assign({ slug: 'venkat-photos', event_type_id: ET_ID, from: '2026-06-02', to: '2026-06-02', tz: NY }, o);

test('get-available-slots: parameters are checked', () => {
  assert.equal(A.parseParams(q()).tz, NY);
  assert.equal(A.parseParams(q({ tz: 'Nope/Zone' })).tz, 'UTC');
  assert.equal(A.parseParams(q({ slug: 'Venkat-Photos' })).slug, 'venkat-photos');
  for (const bad of [{ slug: '../x' }, { event_type_id: 'x' }, { from: 'June' }, { from: '2026-06-03', to: '2026-06-02' }, { to: '2026-09-30' }]) {
    assert.throws(() => A.parseParams(q(bad)), (e) => e.status === 400, JSON.stringify(bad));
  }
});

test('get-available-slots: response for the customer', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const res = A.buildResponse(A.parseParams(q({ tz: 'Europe/London' })), { profileRow, eventTypeRow: etRow, hourRows, blockedRows: [], bookingRows: [], now });
  assert.equal(res.eventType.depositAmount, 75);
  assert.equal(res.photographerTimeZone, NY);
  assert.equal(res.customerTimeZone, 'Europe/London');
  assert.deepEqual(res.days.map((d) => [d.date, d.slots.map((s) => s.time + '/' + s.photographerTime)]), [['2026-06-02', ['14:00/09:00', '14:30/09:30', '15:00/10:00']]]);
  // now is still May 31 in New York, so 30 days ahead is June 30.
  assert.equal(res.lastBookableDate, '2026-06-30');
});

test('get-available-slots: holds, expired holds and availability', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const hold = (expires) => ({ status: 'pending_payment', expires_at: expires, start_at: '2026-06-02T13:00:00Z', block_start: '2026-06-02T13:00:00Z', block_end: '2026-06-02T14:00:00Z' });
  const times = (rows) => A.buildResponse(A.parseParams(q()), { profileRow, eventTypeRow: etRow, hourRows, bookingRows: rows, now }).days.flatMap((d) => d.slots.map((s) => s.time));
  assert.deepEqual(times([hold('2026-06-01T00:05:00Z')]), ['10:00']); // live hold blocks 9:00 and 9:30
  assert.deepEqual(times([hold('2026-05-31T23:55:00Z')]), ['09:00', '09:30', '10:00']); // expired hold doesn't
  assert.throws(() => A.buildResponse(A.parseParams(q()), { profileRow: Object.assign({}, profileRow, { accepting: false }), eventTypeRow: etRow, now }), (e) => e.status === 404);
  assert.throws(() => A.buildResponse(A.parseParams(q()), { profileRow, eventTypeRow: Object.assign({}, etRow, { active: false }), now }), (e) => e.status === 404);
  assert.throws(() => A.buildResponse(A.parseParams(q()), { profileRow, eventTypeRow: Object.assign({}, etRow, { user_id: 'someone-else' }), now }), (e) => e.status === 404);
});
