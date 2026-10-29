// ShutterPaid booking rules: pure functions with no DOM or network.
// Shared by the app (classic <script>, window.SPBooking), the public booking page and the tests,
// and later by the booking Edge Functions. Mirrors the checks in the booking_setup migration.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SPBooking = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LOCATION_TYPES = {
    studio: 'Studio',
    customer_address: "Customer's address",
    outdoor: 'Outdoor location',
    online: 'Online consultation'
  };
  // weekday numbers match JavaScript's Date#getDay and the database (0 = Sunday).
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  // Display order: Monday first.
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

  // Words that would clash with site pages or look official.
  const RESERVED_SLUGS = ['admin', 'api', 'app', 'book', 'booking', 'bookings', 'help', 'login', 'logout', 'manage',
    'privacy', 'terms', 'settings', 'signup', 'support', 'shutterpaid', 'stripe', 'www', 'static', 'assets', 'new'];

  // ---------- Booking address (slug) ----------
  function slugify(text) {
    return String(text || '')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '');
  }

  // Why a slug can't be used, or null if it's fine.
  function slugProblem(slug) {
    if (!slug) return 'Choose a booking link.';
    if (slug.length < 3) return 'Use at least 3 characters.';
    if (slug.length > 40) return 'Use 40 characters or fewer.';
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return 'Use lowercase letters, numbers and single hyphens only.';
    if (RESERVED_SLUGS.includes(slug)) return 'That link is reserved. Try adding your name or studio.';
    return null;
  }

  // ---------- Money ----------
  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  // The advance a customer may pay for an event type, or 0 when there's none.
  function depositAmount(et) {
    if (!et || et.depositMode === 'none' || !et.depositMode) return 0;
    const price = Number(et.price) || 0;
    const value = Number(et.depositValue) || 0;
    const amount = et.depositType === 'fixed' ? value : price * value / 100;
    return Math.max(0, Math.min(price, round2(amount)));
  }

  // ---------- Event types ----------
  function newEventType(overrides) {
    return Object.assign({
      id: '',
      name: '',
      description: '',
      durationMinutes: 60,
      bufferBefore: 0,
      bufferAfter: 0,
      locationType: 'studio',
      locationDetails: '',
      price: 0,
      currency: 'USD',
      depositMode: 'none',
      depositType: 'percent',
      depositValue: 25,
      instructions: '',
      cancellationPolicy: '',
      active: true,
      sortOrder: 0
    }, overrides);
  }

  // Starting points for common shoots. Photographers edit everything afterwards.
  const PRESETS = {
    wedding: {
      name: 'Wedding', durationMinutes: 480, bufferBefore: 60, bufferAfter: 60, locationType: 'customer_address',
      description: 'Full-day wedding coverage, from getting ready to the first dance.',
      instructions: '**Before the day**\n- Send your shot list and family photo list at least 2 weeks before.\n- Share the timeline and a contact person for the day.\n\n**On the day**\n- Plan 20 minutes for couple portraits.\n- Let the venue know a photographer will be there.'
    },
    portrait: {
      name: 'Portrait session', durationMinutes: 60, bufferAfter: 15, locationType: 'studio',
      description: 'A relaxed one-hour portrait session.',
      instructions: '**What to wear**\n- Solid colours photograph best; avoid big logos.\n- Bring a second outfit if you like.\n\n**Arrival**\n- Please arrive 10 minutes early.'
    },
    maternity: {
      name: 'Maternity', durationMinutes: 90, bufferAfter: 15, locationType: 'outdoor',
      description: 'Maternity photos, ideally between 28 and 34 weeks.',
      instructions: '**What to bring**\n- Comfortable shoes for walking to the location.\n- Water and a snack.\n- Any props, like scan photos or baby shoes.\n\n**Timing**\n- We meet about an hour before sunset for the best light.'
    },
    event: {
      name: 'Event coverage', durationMinutes: 180, bufferBefore: 30, bufferAfter: 30, locationType: 'customer_address',
      description: 'Coverage for parties, corporate events and celebrations.',
      instructions: '**Please share**\n- The address, parking details and an on-site contact.\n- The schedule and any must-have shots.'
    },
    consult: {
      name: 'Online consultation', durationMinutes: 30, locationType: 'online',
      description: 'A free video call to plan your shoot.',
      instructions: 'You will get the video call link by email before the call.'
    }
  };

  function eventTypeProblems(et) {
    const p = {};
    if (!String(et.name || '').trim()) p.name = 'Give the event type a name.';
    const d = Number(et.durationMinutes);
    if (!Number.isInteger(d) || d < 15 || d > 1440) p.durationMinutes = 'Duration must be between 15 minutes and 24 hours.';
    ['bufferBefore', 'bufferAfter'].forEach((k) => {
      const b = Number(et[k]);
      if (!Number.isInteger(b) || b < 0 || b > 480) p[k] = 'Buffer must be between 0 and 8 hours.';
    });
    if (!(Number(et.price) >= 0)) p.price = 'Enter a price of 0 or more.';
    if (!LOCATION_TYPES[et.locationType]) p.locationType = 'Choose a location type.';
    if (et.depositMode === 'optional') {
      const v = Number(et.depositValue);
      if (et.depositType === 'percent' && !(v > 0 && v <= 100)) p.depositValue = 'Enter a percentage between 1 and 100.';
      if (et.depositType === 'fixed' && !(v > 0)) p.depositValue = 'Enter an advance amount.';
      if (et.depositType === 'fixed' && v > Number(et.price)) p.depositValue = 'The advance can\'t be more than the price.';
      if (!(Number(et.price) > 0)) p.depositValue = 'Set a price before offering an advance.';
    }
    return p;
  }

  // ---------- Weekly hours ----------
  function toMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  }

  function fromMinutes(min) {
    return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  }

  // Problems with a day's intervals ([{start:'09:00', end:'17:00'}]), or null.
  function hoursProblem(intervals) {
    const list = intervals.map((i) => ({ s: toMinutes(i.start), e: toMinutes(i.end) }));
    if (list.some((i) => isNaN(i.s) || isNaN(i.e))) return 'Enter a start and end time.';
    if (list.some((i) => i.s >= i.e)) return 'Each end time must be after its start time.';
    list.sort((a, b) => a.s - b.s);
    for (let k = 1; k < list.length; k++) if (list[k].s < list[k - 1].e) return 'Time ranges on the same day overlap.';
    return null;
  }

  // Default hours: Monday to Friday, 9am to 5pm.
  function defaultHours() {
    return [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));
  }

  function blockedProblem(b) {
    if (!b.startDate || !b.endDate) return 'Choose the first and last day.';
    if (b.endDate < b.startDate) return 'The last day must be on or after the first day.';
    return null;
  }

  // ---------- Row mapping (app objects <-> Postgres rows) ----------
  function profileToRow(p, userId) {
    return {
      user_id: userId,
      slug: p.slug,
      display_name: p.displayName || '',
      photo_url: p.photoUrl || '',
      bio: p.bio || '',
      time_zone: p.timeZone || 'UTC',
      accepting: !!p.accepting,
      min_notice_minutes: Number(p.minNoticeMinutes) || 0,
      max_days_ahead: Number(p.maxDaysAhead) || 90,
      max_per_day: p.maxPerDay ? Number(p.maxPerDay) : null,
      cancellation_policy: p.cancellationPolicy || '',
      allow_customer_cancel: p.allowCancel !== false,
      allow_customer_reschedule: p.allowReschedule !== false,
      change_cutoff_hours: p.changeCutoffHours == null || p.changeCutoffHours === '' ? 24 : Number(p.changeCutoffHours)
    };
  }

  function rowToProfile(r) {
    return {
      slug: r.slug,
      displayName: r.display_name || '',
      photoUrl: r.photo_url || '',
      bio: r.bio || '',
      timeZone: r.time_zone || 'UTC',
      accepting: !!r.accepting,
      minNoticeMinutes: r.min_notice_minutes,
      maxDaysAhead: r.max_days_ahead,
      maxPerDay: r.max_per_day == null ? '' : r.max_per_day,
      cancellationPolicy: r.cancellation_policy || '',
      // Customer changes from their booking link (defaults match the database).
      allowCancel: r.allow_customer_cancel !== false,
      allowReschedule: r.allow_customer_reschedule !== false,
      changeCutoffHours: r.change_cutoff_hours == null ? 24 : r.change_cutoff_hours
    };
  }

  function eventTypeToRow(et, userId) {
    return {
      id: et.id,
      user_id: userId,
      name: String(et.name).trim(),
      description: et.description || '',
      duration_minutes: Number(et.durationMinutes),
      buffer_before: Number(et.bufferBefore) || 0,
      buffer_after: Number(et.bufferAfter) || 0,
      location_type: et.locationType,
      location_details: et.locationDetails || '',
      price: round2(et.price),
      currency: et.currency || 'USD',
      deposit_mode: et.depositMode === 'optional' ? 'optional' : 'none',
      deposit_type: et.depositType === 'fixed' ? 'fixed' : 'percent',
      deposit_value: round2(et.depositValue),
      instructions: et.instructions || '',
      cancellation_policy: et.cancellationPolicy || '',
      active: !!et.active,
      sort_order: Number(et.sortOrder) || 0
    };
  }

  function rowToEventType(r) {
    return newEventType({
      id: r.id,
      name: r.name,
      description: r.description || '',
      durationMinutes: r.duration_minutes,
      bufferBefore: r.buffer_before,
      bufferAfter: r.buffer_after,
      locationType: r.location_type,
      locationDetails: r.location_details || '',
      price: Number(r.price),
      currency: r.currency,
      depositMode: r.deposit_mode,
      depositType: r.deposit_type,
      depositValue: Number(r.deposit_value),
      instructions: r.instructions || '',
      cancellationPolicy: r.cancellation_policy || '',
      active: !!r.active,
      sortOrder: r.sort_order || 0
    });
  }

  function hourToRow(h, userId) {
    return { id: h.id, user_id: userId, weekday: h.weekday, start_time: h.start, end_time: h.end };
  }

  function rowToHour(r) {
    return { id: r.id, weekday: r.weekday, start: String(r.start_time).slice(0, 5), end: String(r.end_time).slice(0, 5) };
  }

  function blockedToRow(b, userId) {
    return { id: b.id, user_id: userId, start_date: b.startDate, end_date: b.endDate, note: b.note || '' };
  }

  function rowToBlocked(r) {
    return { id: r.id, startDate: r.start_date, endDate: r.end_date, note: r.note || '' };
  }

  // ---------- Display helpers ----------
  function formatDuration(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (!h) return m + ' min';
    return h + ' h' + (m ? ' ' + m + ' min' : '');
  }

  function formatNotice(min) {
    if (!min) return 'No minimum notice';
    if (min % 1440 === 0) return (min / 1440) + ' day' + (min === 1440 ? '' : 's');
    if (min % 60 === 0) return (min / 60) + ' hour' + (min === 60 ? '' : 's');
    return min + ' minutes';
  }

  return {
    LOCATION_TYPES, WEEKDAYS, WEEK_ORDER, RESERVED_SLUGS, PRESETS,
    slugify, slugProblem, round2, depositAmount, newEventType, eventTypeProblems,
    toMinutes, fromMinutes, hoursProblem, defaultHours, blockedProblem,
    profileToRow, rowToProfile, eventTypeToRow, rowToEventType, hourToRow, rowToHour, blockedToRow, rowToBlocked,
    formatDuration, formatNotice
  };
});
