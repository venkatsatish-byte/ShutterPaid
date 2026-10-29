// Request checking and response shaping for get-available-slots (no I/O), so it can be tested in
// Node. Requires SPSlots (slots.js) and SPBooking (booking.js) to be loaded first.
(function (root, factory) {
  const api = factory(
    root.SPSlots || (typeof require === 'function' ? require('./slots.js') : null),
    root.SPBooking || (typeof require === 'function' ? require('./booking.js') : null)
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SPSlotsApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (S, B) {
  'use strict';

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  // Validate query parameters. Dates are calendar days in the customer's time zone, inclusive.
  function parseParams(q) {
    const slug = String(q.slug || '').toLowerCase();
    if (slug.length > 40 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new ApiError(400, 'Invalid booking link.');
    if (!UUID.test(q.event_type_id || '')) throw new ApiError(400, 'Choose an event type.');
    const tz = q.tz && S.validTimeZone(q.tz) ? q.tz : 'UTC';
    if (!DATE.test(q.from || '') || !DATE.test(q.to || '') || q.to < q.from) throw new ApiError(400, 'Choose a date range.');
    const span = (Date.parse(q.to) - Date.parse(q.from)) / 86400000 + 1;
    if (span > S.MAX_RANGE_DAYS) throw new ApiError(400, 'Ask for at most ' + S.MAX_RANGE_DAYS + ' days at a time.');
    // A manage token (for rescheduling) is optional.
    const token = q.token && UUID.test(q.token) ? q.token : null;
    return { slug, eventTypeId: q.event_type_id, tz, from: q.from, to: q.to, token };
  }

  // Midnight at the start of a customer-local date, as an instant (works on DST days too).
  function startOfDay(dateISO, tz) {
    for (let m = 0; m < 180; m += 30) {
      const ms = S.zonedToUtc(dateISO, m, tz);
      if (ms !== null) return ms;
    }
    return Date.parse(dateISO + 'T00:00:00Z');
  }

  // The instants to search, padded by a day for loading bookings that affect the edges.
  function searchWindow(params) {
    const from = startOfDay(params.from, params.tz);
    const to = startOfDay(S.addDays(params.to, 1), params.tz);
    return { from, to, loadFrom: from - 86400000, loadTo: to + 86400000 };
  }

  /**
   * data: { profileRow, eventTypeRow, hourRows, blockedRows, bookingRows, now }
   * Rows come straight from the database (service role).
   */
  function buildResponse(params, data) {
    const p = data.profileRow;
    if (!p || !p.accepting) throw new ApiError(404, 'This photographer isn\'t taking bookings right now.');
    const et = data.eventTypeRow;
    if (!et || !et.active || et.user_id !== p.user_id) throw new ApiError(404, 'That event type isn\'t available.');
    const profile = B.rowToProfile(p);
    const eventType = B.rowToEventType(et);
    const now = +data.now;
    const win = searchWindow(params);
    // Holds whose 10 minutes ran out no longer block anything, even before the cleanup job runs.
    const bookings = (data.bookingRows || [])
      // When a customer reschedules, their own booking doesn't block the new time.
      .filter((b) => !data.excludeBookingId || b.id !== data.excludeBookingId)
      .filter((b) => b.status === 'confirmed' || (b.status === 'pending_payment' && Date.parse(b.expires_at) > now))
      .map((b) => ({ startAt: b.start_at, blockStart: b.block_start, blockEnd: b.block_end }));
    const slots = S.availableSlots({
      profile,
      eventType,
      hours: (data.hourRows || []).map(B.rowToHour),
      blocked: (data.blockedRows || []).map(B.rowToBlocked),
      bookings,
      now,
      from: win.from,
      to: win.to
    });
    const days = S.presentSlots(slots, params.tz, profile.timeZone);
    const lastDay = S.addDays(S.zoned(now, profile.timeZone).date, profile.maxDaysAhead);
    return {
      photographer: { displayName: profile.displayName, photoUrl: profile.photoUrl, timeZone: profile.timeZone },
      eventType: {
        id: eventType.id, name: eventType.name, durationMinutes: eventType.durationMinutes,
        price: eventType.price, currency: eventType.currency, locationType: eventType.locationType,
        depositMode: eventType.depositMode, depositAmount: B.depositAmount(eventType)
      },
      customerTimeZone: params.tz,
      photographerTimeZone: profile.timeZone,
      from: params.from,
      to: params.to,
      // Customers can't book after this day (photographer's calendar); the page greys out days beyond it.
      lastBookableDate: lastDay,
      days
    };
  }

  return { ApiError, parseParams, searchWindow, buildResponse };
});
