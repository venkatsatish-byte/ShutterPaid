// A fake of the public booking Edge Functions for browser tests. It runs in Node and uses the
// real shared rule modules (slots, booking-api), with an in-memory database that mimics the
// database's overlap and daily-limit checks.
const path = require('path');
const shared = path.join(__dirname, '..', '..', 'supabase', 'functions', '_shared');
const SlotsApi = require(path.join(shared, 'slots-api.js'));
const Api = require(path.join(shared, 'booking-api.js'));
const crypto = require('crypto');

const NY = 'America/New_York';
const UID = '11111111-1111-4111-8111-111111111111';
const PORTRAIT = '0b6a3f1e-1111-4111-8111-111111111111';
const WEDDING = '0b6a3f1e-2222-4222-8222-222222222222';

function seed(overrides) {
  return Object.assign({
    profile: { user_id: UID, slug: 'venkat-photos', display_name: 'Venkat Photos', photo_url: '', bio: 'Portraits & weddings in New York.',
      time_zone: NY, accepting: true, min_notice_minutes: 120, max_days_ahead: 60, max_per_day: null,
      cancellation_policy: 'Free cancellation up to **24 hours** before.', allow_customer_cancel: true, allow_customer_reschedule: true, change_cutoff_hours: 24 },
    eventTypes: [
      { id: PORTRAIT, user_id: UID, name: 'Portrait session', description: 'One relaxed hour in the studio.', duration_minutes: 60, buffer_before: 0, buffer_after: 30,
        location_type: 'studio', location_details: '12 Main St, New York', price: 300, currency: 'USD', deposit_mode: 'optional', deposit_type: 'percent',
        deposit_value: 25, instructions: '**Wear** solid colours.\n- Bring water', cancellation_policy: '', active: true, sort_order: 0 },
      { id: WEDDING, user_id: UID, name: 'Wedding', description: 'Full day.', duration_minutes: 480, buffer_before: 60, buffer_after: 60,
        location_type: 'customer_address', location_details: '', price: 3000, currency: 'USD', deposit_mode: 'none', deposit_type: 'percent',
        deposit_value: 0, instructions: '', cancellation_policy: '', active: true, sort_order: 1 }
    ],
    hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_time: '09:00:00', end_time: '17:00:00' })),
    blocked: [],
    bookings: [],
    payments: [],
    calls: []
  }, overrides);
}

function json(route, status, body) {
  return route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
}

function fail(route, err) {
  if (err instanceof SlotsApi.ApiError) return json(route, err.status, { error: err.message, fields: err.fields });
  console.error(err);
  return json(route, 500, { error: 'Something went wrong. Please try again.' });
}

function activeRows(db) {
  return db.bookings.filter((b) => b.status === 'confirmed' || b.status === 'pending_payment');
}

// Mirrors create_booking()/reschedule_booking(): overlap (buffers included) and the daily limit.
function dbCheck(db, row, excludeId) {
  const bs = Date.parse(row.start_at) - row.buffer_before * 60000;
  const be = Date.parse(row.end_at) + row.buffer_after * 60000;
  if (activeRows(db).some((b) => b.id !== excludeId && bs < Date.parse(b.block_end) && be > Date.parse(b.block_start))) throw new Error('SLOT_TAKEN');
  if (db.profile.max_per_day) {
    const day = Api.dayBounds(Date.parse(row.start_at), db.profile.time_zone);
    const n = activeRows(db).filter((b) => b.id !== excludeId && Date.parse(b.start_at) >= day.start && Date.parse(b.start_at) < day.end).length;
    if (n >= db.profile.max_per_day) throw new Error('DAY_FULL');
  }
  return { block_start: new Date(bs).toISOString(), block_end: new Date(be).toISOString() };
}

async function install(rawContext, db, opts) {
  const base = 'https://fake.supabase.co/functions/v1/';
  // Every route answers CORS preflights like the real functions do.
  const context = {
    route: (match, handler) => rawContext.route(match, (route) => {
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
      }
      return handler(route);
    })
  };
  const now = () => (opts && opts.now ? opts.now() : Date.now());
  const slotCtx = () => ({ profileRow: db.profile, hourRows: db.hours, blockedRows: db.blocked, bookingRows: db.bookings, now: now() });

  await context.route((u) => u.href.startsWith(base + 'booking-page'), (route) => {
    db.calls.push('booking-page');
    try {
      const slug = new URL(route.request().url()).searchParams.get('slug');
      if (slug !== db.profile.slug) throw new SlotsApi.ApiError(404, 'We couldn\'t find that booking page.');
      json(route, 200, Api.publicPage(db.profile, db.eventTypes, { advancePaymentsAvailable: !!db.advances }));
    } catch (e) { fail(route, e); }
  });

  await context.route((u) => u.href.startsWith(base + 'get-available-slots'), (route) => {
    db.calls.push('get-available-slots');
    try {
      const params = SlotsApi.parseParams(Object.fromEntries(new URL(route.request().url()).searchParams));
      if (params.slug !== db.profile.slug) throw new SlotsApi.ApiError(404, 'We couldn\'t find that booking page.');
      const own = params.token ? db.bookings.find((b) => b.manage_token === params.token) : null;
      json(route, 200, SlotsApi.buildResponse(params, Object.assign(slotCtx(), {
        eventTypeRow: db.eventTypes.find((e) => e.id === params.eventTypeId), excludeBookingId: own ? own.id : null
      })));
    } catch (e) { fail(route, e); }
  });

  await context.route((u) => u.href.startsWith(base + 'create-booking'), async (route) => {
    db.calls.push('create-booking');
    try {
      const body = route.request().postDataJSON();
      if (body.slug !== db.profile.slug || !db.profile.accepting) throw new SlotsApi.ApiError(404, 'This photographer isn\'t taking bookings right now.');
      const eventTypeRow = db.eventTypes.find((e) => e.id === body.event_type_id && e.active);
      if (!eventTypeRow) throw new SlotsApi.ApiError(404, 'That event type isn\'t available.');
      const input = Api.parseBookingInput(body, eventTypeRow);
      const ctx = Object.assign(slotCtx(), { eventTypeRow, advancePaymentsAvailable: !!db.advances });
      const slot = Api.checkSlot(input.start, ctx);
      const row = Api.bookingRow(input, ctx, slot);
      if (opts && opts.beforeInsert) await opts.beforeInsert(row);
      let blocks;
      try { blocks = dbCheck(db, row); } catch (e) { throw Api.bookingError(e); }
      const created = Object.assign({ id: crypto.randomUUID(), manage_token: crypto.randomUUID(), cancel_reason: '' }, row, blocks);
      db.bookings.push(created);
      json(route, 201, { id: created.id, token: created.manage_token, status: created.status, manageUrl: 'https://app.example/book.html#manage=' + created.manage_token });
    } catch (e) { fail(route, e); }
  });

  await context.route((u) => u.href.startsWith(base + 'manage-booking'), async (route) => {
    const req = route.request();
    db.calls.push('manage-booking:' + req.method());
    const view = (b) => Api.manageView(b, { profileRow: db.profile, eventTypeRow: db.eventTypes.find((e) => e.id === b.event_type_id),
      paymentRows: db.payments.filter((p) => p.booking_id === b.id), otherRows: db.bookings.filter((o) => o.customer_email === b.customer_email), now: now() });
    try {
      if (req.method() === 'GET') {
        const token = new URL(req.url()).searchParams.get('token');
        const b = db.bookings.find((x) => x.manage_token === token);
        if (!b) throw new SlotsApi.ApiError(404, 'We couldn\'t find this booking. Please use the link from your confirmation email.');
        return json(route, 200, view(b));
      }
      const action = Api.parseManageAction(req.postDataJSON());
      const b = db.bookings.find((x) => x.manage_token === action.token);
      if (!b) throw new SlotsApi.ApiError(404, 'We couldn\'t find this booking.');
      const rules = Api.changeRules(b, db.profile, now());
      if (action.action === 'cancel') {
        if (!rules.canCancel) throw new SlotsApi.ApiError(409, rules.reason || 'This booking can\'t be cancelled online.');
        Object.assign(b, { status: 'cancelled', cancel_reason: action.reason ? 'Customer: ' + action.reason : 'Cancelled by customer' });
      } else {
        if (!rules.canReschedule) throw new SlotsApi.ApiError(409, rules.reason || 'This booking can\'t be rescheduled online.');
        const eventTypeRow = db.eventTypes.find((e) => e.id === b.event_type_id);
        const slot = Api.checkSlot(action.start, Object.assign(slotCtx(), { eventTypeRow, excludeBookingId: b.id }));
        const next = Object.assign({}, b, { start_at: new Date(slot.start).toISOString(), end_at: new Date(slot.end).toISOString() });
        let blocks;
        try { blocks = dbCheck(db, next, b.id); } catch (e) { throw Api.bookingError(e); }
        Object.assign(b, next, blocks);
      }
      json(route, 200, view(b));
    } catch (e) { fail(route, e); }
  });
}

module.exports = { seed, install, NY, UID, PORTRAIT, WEDDING };
