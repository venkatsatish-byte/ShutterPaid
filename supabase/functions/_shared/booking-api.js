// Rules for the public booking Edge Functions (no I/O), so they can be tested in Node and reused by
// the browser tests' fake backend. Requires SPSlots, SPBooking and SPSlotsApi to be loaded first.
(function (root, factory) {
  const req = (m) => (typeof require === 'function' ? require(m) : null);
  const api = factory(
    root.SPSlots || req('./slots.js'),
    root.SPBooking || req('./booking.js'),
    root.SPSlotsApi || req('./slots-api.js')
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SPBookingApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (S, B, SlotsApi) {
  'use strict';

  const ApiError = SlotsApi.ApiError;
  const HOLD_MINUTES = 10;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function isUuid(v) {
    return typeof v === 'string' && UUID.test(v);
  }

  function fieldError(fields) {
    const e = new ApiError(400, 'Please check the highlighted fields.');
    e.fields = fields;
    return e;
  }

  // ---------- Booking page ----------
  // What a visitor may see about a photographer: no ids of other tables, no private notes.
  function publicPage(profileRow, eventTypeRows, opts) {
    if (!profileRow || !profileRow.accepting) throw new ApiError(404, 'This photographer isn\'t taking bookings right now.');
    const p = B.rowToProfile(profileRow);
    const advancesOn = !!(opts && opts.advancePaymentsAvailable);
    const types = (eventTypeRows || [])
      .filter((r) => r.active && r.user_id === profileRow.user_id)
      .map(B.rowToEventType)
      .sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name))
      .map((et) => {
        const deposit = advancesOn ? B.depositAmount(et) : 0;
        return {
          id: et.id,
          name: et.name,
          description: et.description,
          durationMinutes: et.durationMinutes,
          locationType: et.locationType,
          locationLabel: B.LOCATION_TYPES[et.locationType],
          locationDetails: et.locationDetails,
          price: et.price,
          currency: et.currency,
          // An advance is offered only when the photographer can actually receive it online.
          advanceAmount: deposit,
          cancellationPolicy: et.cancellationPolicy || p.cancellationPolicy,
          needsAddress: et.locationType === 'customer_address'
        };
      });
    return {
      slug: p.slug,
      displayName: p.displayName,
      photoUrl: p.photoUrl,
      bio: p.bio,
      timeZone: p.timeZone,
      cancellationPolicy: p.cancellationPolicy,
      eventTypes: types
    };
  }

  // ---------- Creating a booking ----------
  function clean(v, max) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  }

  // Validate what the customer sent. Never trusts prices or advances from the browser.
  function parseBookingInput(body, eventType) {
    const b = body || {};
    const fields = {};
    if (b.website) throw new ApiError(400, 'Something went wrong. Please try again.'); // honeypot filled in: a bot
    if (!isUuid(b.event_type_id)) throw new ApiError(400, 'Choose an event type.');
    const start = Date.parse(b.start);
    if (!b.start || isNaN(start)) throw new ApiError(400, 'Choose a time.');
    const name = clean(b.name, 120);
    const email = clean(b.email, 320).toLowerCase();
    const phone = clean(b.phone, 40);
    const address = String(b.address == null ? '' : b.address).trim().slice(0, 500);
    const notes = String(b.notes == null ? '' : b.notes).trim().slice(0, 2000);
    if (!name) fields.name = 'Enter your name.';
    if (!EMAIL.test(email)) fields.email = 'Enter a valid email address.';
    if (phone && !/^[0-9+()\-.\s]{6,40}$/.test(phone)) fields.phone = 'Enter a valid phone number, or leave it blank.';
    if (eventType && eventType.location_type === 'customer_address' && !address) fields.address = 'Enter the address for the shoot.';
    if (b.accept_policy !== true) fields.accept_policy = 'Please accept the cancellation policy.';
    if (Object.keys(fields).length) throw fieldError(fields);
    return {
      slug: String(b.slug || '').toLowerCase(),
      eventTypeId: b.event_type_id,
      start,
      name,
      email,
      phone,
      address,
      notes,
      timeZone: S.validTimeZone(b.tz) ? b.tz : '',
      payAdvance: b.pay_advance === true
    };
  }

  // The photographer's calendar day around an instant, as UTC bounds (for the daily limit).
  function dayBounds(ms, tz) {
    const day = S.zoned(ms, tz).date;
    const startOf = (d) => {
      for (let m = 0; m < 180; m += 30) {
        const t = S.zonedToUtc(d, m, tz);
        if (t !== null) return t;
      }
      return Date.parse(d + 'T00:00:00Z');
    };
    return { day, start: startOf(day), end: startOf(S.addDays(day, 1)) };
  }

  // Is this exact start time still bookable? Uses the same rules as the slot list, so customers
  // can't book outside working hours, inside the notice period or over another booking.
  function checkSlot(start, ctx) {
    const profile = B.rowToProfile(ctx.profileRow);
    const eventType = B.rowToEventType(ctx.eventTypeRow);
    const now = +ctx.now;
    const bookings = (ctx.bookingRows || [])
      .filter((b) => b.id !== ctx.excludeBookingId)
      .filter((b) => b.status === 'confirmed' || (b.status === 'pending_payment' && Date.parse(b.expires_at) > now))
      .map((b) => ({ startAt: b.start_at, blockStart: b.block_start, blockEnd: b.block_end }));
    const slots = S.availableSlots({
      profile,
      eventType,
      hours: (ctx.hourRows || []).map(B.rowToHour),
      blocked: (ctx.blockedRows || []).map(B.rowToBlocked),
      bookings,
      now,
      from: start - 60000,
      to: start + 60000
    });
    const slot = slots.find((s) => s.start === start);
    if (!slot) throw new ApiError(409, 'Sorry, that time was just taken or is no longer available. Please choose another time.');
    return slot;
  }

  // The row create_booking() inserts. Price and advance come from the event type on the server.
  function bookingRow(input, ctx, slot) {
    const et = B.rowToEventType(ctx.eventTypeRow);
    const advance = ctx.advancePaymentsAvailable ? B.depositAmount(et) : 0;
    if (input.payAdvance && !(advance > 0)) {
      throw new ApiError(409, 'Paying an advance online isn\'t available for this booking. You can book without paying now.');
    }
    const now = +ctx.now;
    return {
      photographer_id: ctx.profileRow.user_id,
      event_type_id: et.id,
      event_name: et.name,
      price: et.price,
      currency: et.currency,
      buffer_before: et.bufferBefore,
      buffer_after: et.bufferAfter,
      customer_name: input.name,
      customer_email: input.email,
      customer_phone: input.phone,
      customer_time_zone: input.timeZone,
      event_address: input.address,
      notes: input.notes,
      start_at: new Date(slot.start).toISOString(),
      end_at: new Date(slot.end).toISOString(),
      // Bookings without an advance are confirmed straight away. With an advance, the slot is held
      // while the customer pays; payment confirms it, otherwise it's released.
      status: input.payAdvance ? 'pending_payment' : 'confirmed',
      deposit_choice: input.payAdvance ? 'paid' : 'none',
      deposit_amount: input.payAdvance ? advance : 0,
      expires_at: input.payAdvance ? new Date(now + HOLD_MINUTES * 60000).toISOString() : null
    };
  }

  // Map database errors from create_booking/reschedule_booking to customer messages.
  function bookingError(err) {
    const m = String((err && err.message) || '');
    if (/SLOT_TAKEN/.test(m)) return new ApiError(409, 'Sorry, someone just booked that time. Please choose another time.');
    if (/DAY_FULL/.test(m)) return new ApiError(409, 'That day just filled up. Please choose another day.');
    if (/NOT_CHANGEABLE|NOT_FOUND/.test(m)) return new ApiError(409, 'This booking can no longer be changed.');
    return null;
  }

  // ---------- Managing a booking ----------
  function changeRules(bookingRow, profileRow, now) {
    const p = profileRow || {};
    const cutoffHours = p.change_cutoff_hours == null ? 24 : p.change_cutoff_hours;
    const before = Date.parse(bookingRow.start_at) - cutoffHours * 3600000;
    const open = bookingRow.status === 'confirmed' && +now < before;
    const late = bookingRow.status === 'confirmed' && +now >= before && +now < Date.parse(bookingRow.start_at);
    const reason = bookingRow.status !== 'confirmed'
      ? (bookingRow.status === 'pending_payment' ? 'Your booking isn\'t confirmed yet.' : 'This booking can\'t be changed any more.')
      : late ? 'Online changes close ' + cutoffHours + ' hours before your session. Please contact the photographer.' : '';
    return {
      canCancel: open && p.allow_customer_cancel !== false,
      canReschedule: open && p.allow_customer_reschedule !== false,
      cutoffHours,
      changeDeadline: new Date(before).toISOString(),
      reason
    };
  }

  function paymentSummary(bookingRow, paymentRows) {
    const paid = (paymentRows || []).filter((p) => p.status === 'paid' || p.status === 'partially_refunded' || p.status === 'refunded');
    const amountPaid = paid.reduce((t, p) => t + Number(p.amount) - Number(p.amount_refunded || 0), 0);
    const refunded = paid.reduce((t, p) => t + Number(p.amount_refunded || 0), 0);
    const price = Number(bookingRow.price);
    return {
      price,
      currency: bookingRow.currency,
      advancePaid: B.round2(amountPaid),
      refunded: B.round2(refunded),
      balance: B.round2(Math.max(0, price - amountPaid)),
      status: bookingRow.status === 'pending_payment' ? 'awaiting_payment'
        : amountPaid > 0 ? 'advance_paid' : refunded > 0 ? 'refunded' : 'pay_later'
    };
  }

  // What the customer sees on their "manage my booking" page.
  function manageView(bookingRow, ctx) {
    const profile = ctx.profileRow ? B.rowToProfile(ctx.profileRow) : { displayName: '', timeZone: 'UTC', cancellationPolicy: '' };
    const et = ctx.eventTypeRow ? B.rowToEventType(ctx.eventTypeRow) : null;
    return {
      booking: {
        id: bookingRow.id,
        status: bookingRow.status,
        eventName: bookingRow.event_name,
        eventTypeId: bookingRow.event_type_id,
        start: bookingRow.start_at,
        end: bookingRow.end_at,
        customerName: bookingRow.customer_name,
        customerEmail: bookingRow.customer_email,
        customerPhone: bookingRow.customer_phone,
        eventAddress: bookingRow.event_address,
        notes: bookingRow.notes,
        cancelReason: bookingRow.status === 'cancelled' ? bookingRow.cancel_reason : '',
        expiresAt: bookingRow.status === 'pending_payment' ? bookingRow.expires_at : null
      },
      photographer: {
        slug: profile.slug, displayName: profile.displayName, photoUrl: profile.photoUrl, timeZone: profile.timeZone
      },
      location: et ? { type: et.locationType, label: B.LOCATION_TYPES[et.locationType], details: et.locationDetails } : null,
      instructions: et ? et.instructions : '',
      cancellationPolicy: (et && et.cancellationPolicy) || profile.cancellationPolicy,
      payment: paymentSummary(bookingRow, ctx.paymentRows),
      rules: changeRules(bookingRow, ctx.profileRow, ctx.now),
      // The same customer's other upcoming bookings with this photographer (each with its own link).
      others: (ctx.otherRows || [])
        .filter((o) => o.id !== bookingRow.id && (o.status === 'confirmed' || o.status === 'pending_payment') && Date.parse(o.end_at) > +ctx.now)
        .map((o) => ({ eventName: o.event_name, start: o.start_at, status: o.status, token: o.manage_token }))
    };
  }

  function parseManageAction(body) {
    const b = body || {};
    if (!isUuid(b.token)) throw new ApiError(400, 'This link is incomplete.');
    if (b.action === 'cancel') return { token: b.token, action: 'cancel', reason: clean(b.reason, 500) };
    if (b.action === 'reschedule') {
      const start = Date.parse(b.start);
      if (!b.start || isNaN(start)) throw new ApiError(400, 'Choose a new time.');
      return { token: b.token, action: 'reschedule', start };
    }
    throw new ApiError(400, 'Unknown action.');
  }

  return {
    ApiError, HOLD_MINUTES, isUuid,
    publicPage, parseBookingInput, dayBounds, checkSlot, bookingRow, bookingError,
    changeRules, paymentSummary, manageView, parseManageAction
  };
});
