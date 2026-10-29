// ShutterPaid slot calculation: which start times a customer can book. Pure, no DOM or network.
// Shared by the get-available-slots Edge Function (Deno), the tests (Node) and the booking page.
// The copy in supabase/functions/_shared/slots.js must stay identical (npm run sync-shared).
//
// Working hours are wall-clock times in the photographer's time zone. Each candidate start is
// converted to a real instant (UTC) with the zone's rules for that date, so daylight-saving
// changes are handled: a 9:00 start is 9:00 local on both sides of a change, times that don't
// exist (the skipped hour) are never offered, and repeated times use the first occurrence.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SPSlots = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MINUTE = 60 * 1000;
  const DAY_MS = 24 * 60 * MINUTE;
  const DEFAULT_STEP = 30; // minutes between offered start times
  const MAX_RANGE_DAYS = 62;

  // ---------- Time zone helpers ----------
  const fmtCache = {};
  function partsFormatter(tz) {
    if (!fmtCache[tz]) {
      fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
      });
    }
    return fmtCache[tz];
  }

  const WEEKDAY_NUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  // Wall-clock parts of an instant in a zone.
  function zoned(ms, tz) {
    const p = {};
    partsFormatter(tz).formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
    const hour = Number(p.hour) % 24;
    return {
      date: p.year + '-' + p.month + '-' + p.day,
      minutes: hour * 60 + Number(p.minute),
      time: String(hour).padStart(2, '0') + ':' + p.minute,
      weekday: WEEKDAY_NUM[p.weekday]
    };
  }

  // Offset of the zone from UTC at an instant, in minutes (e.g. -300 for New York in winter).
  function offsetMinutes(ms, tz) {
    const z = zoned(ms, tz);
    const [y, mo, d] = z.date.split('-').map(Number);
    const asUtc = Date.UTC(y, mo - 1, d, Math.floor(z.minutes / 60), z.minutes % 60);
    return Math.round((asUtc - Math.floor(ms / MINUTE) * MINUTE) / MINUTE);
  }

  // The instant when the clock in `tz` shows `dateISO` at `minutes` past midnight, or null if that
  // wall-clock time doesn't exist there (skipped by a daylight-saving change).
  function zonedToUtc(dateISO, minutes, tz) {
    const [y, mo, d] = dateISO.split('-').map(Number);
    const wall = Date.UTC(y, mo - 1, d, 0, minutes);
    // Try both offsets around the time; prefer the earlier instant when the time repeats.
    const candidates = [offsetMinutes(wall - DAY_MS / 2, tz), offsetMinutes(wall + DAY_MS / 2, tz), offsetMinutes(wall, tz)]
      .map((off) => wall - off * MINUTE)
      .filter((ms, i, all) => all.indexOf(ms) === i)
      .filter((ms) => { const z = zoned(ms, tz); return z.date === dateISO && z.minutes === minutes; })
      .sort((a, b) => a - b);
    return candidates.length ? candidates[0] : null;
  }

  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  function weekdayOf(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  function toMinutes(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
  }

  function validTimeZone(tz) {
    if (!tz || typeof tz !== 'string') return false;
    try {
      partsFormatter(tz);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------- Slots ----------
  /**
   * Open start times for one event type.
   * opts:
   *   profile   { timeZone, minNoticeMinutes, maxDaysAhead, maxPerDay }
   *   eventType { durationMinutes, bufferBefore, bufferAfter }
   *   hours     [{ weekday, start: 'HH:MM', end: 'HH:MM' }]  (photographer's wall clock)
   *   blocked   [{ startDate, endDate }]                     (photographer's dates, inclusive)
   *   bookings  [{ blockStart, blockEnd, startAt }]          active bookings, buffers included (ms or ISO)
   *   now       Date or ms
   *   from, to  instants bounding the search (ms or ISO); clipped to the booking window
   *   step      minutes between offered starts (default 30)
   * Returns [{ start, end }] in ms (UTC), sorted.
   */
  function availableSlots(opts) {
    const p = opts.profile;
    const et = opts.eventType;
    const tz = p.timeZone;
    if (!validTimeZone(tz)) return [];
    const now = +opts.now;
    const step = opts.step || DEFAULT_STEP;
    const dur = Number(et.durationMinutes) * MINUTE;
    const before = (Number(et.bufferBefore) || 0) * MINUTE;
    const after = (Number(et.bufferAfter) || 0) * MINUTE;

    // Booking window: from now + minimum notice to the end of the last bookable day.
    const earliest = now + (Number(p.minNoticeMinutes) || 0) * MINUTE;
    const lastDay = addDays(zoned(now, tz).date, Number(p.maxDaysAhead) || 0);
    const from = Math.max(+new Date(opts.from), earliest);
    const to = +new Date(opts.to);
    if (!(to > from)) return [];

    const busy = (opts.bookings || []).map((b) => ({ s: +new Date(b.blockStart), e: +new Date(b.blockEnd), day: zoned(+new Date(b.startAt), tz).date }));
    const perDay = {};
    busy.forEach((b) => { perDay[b.day] = (perDay[b.day] || 0) + 1; });
    const maxPerDay = Number(p.maxPerDay) || 0;
    const isBlocked = (day) => (opts.blocked || []).some((b) => day >= b.startDate && day <= b.endDate);

    const byDay = {};
    (opts.hours || []).forEach((h) => { (byDay[h.weekday] = byDay[h.weekday] || []).push(h); });

    const out = [];
    // Walk the photographer's calendar days that touch the search range.
    let day = zoned(from - DAY_MS, tz).date;
    const endDay = zoned(to + DAY_MS, tz).date;
    for (let guard = 0; day <= endDay && day <= lastDay && guard < MAX_RANGE_DAYS + 3; day = addDays(day, 1), guard++) {
      if (isBlocked(day)) continue;
      if (maxPerDay && (perDay[day] || 0) >= maxPerDay) continue;
      const ranges = byDay[weekdayOf(day)] || [];
      ranges.forEach((r) => {
        const open = toMinutes(r.start);
        const close = toMinutes(r.end);
        for (let m = open; m + Number(et.durationMinutes) <= close; m += step) {
          const start = zonedToUtc(day, m, tz);
          if (start === null) continue; // skipped by a daylight-saving change
          const end = start + dur;
          // The session must also end inside the range on the wall clock (matters on DST days).
          const endWall = zoned(end, tz);
          if (endWall.date !== day || endWall.minutes > close || endWall.minutes < m) continue;
          if (start < from || start >= to) continue;
          const bs = start - before;
          const be = end + after;
          if (busy.some((b) => bs < b.e && be > b.s)) continue;
          out.push({ start, end });
        }
      });
    }
    out.sort((a, b) => a.start - b.start);
    return out.filter((s, i) => i === 0 || s.start !== out[i - 1].start);
  }

  // Shape slots for a customer: their local date/time plus the photographer's, grouped by the
  // customer's date.
  function presentSlots(slots, customerTz, photographerTz) {
    const days = {};
    slots.forEach((s) => {
      const c = zoned(s.start, customerTz);
      const ph = zoned(s.start, photographerTz);
      (days[c.date] = days[c.date] || []).push({
        start: new Date(s.start).toISOString(),
        end: new Date(s.end).toISOString(),
        time: c.time,
        photographerDate: ph.date,
        photographerTime: ph.time
      });
    });
    return Object.keys(days).sort().map((date) => ({ date, slots: days[date] }));
  }

  return {
    DEFAULT_STEP, MAX_RANGE_DAYS,
    zoned, offsetMinutes, zonedToUtc, addDays, validTimeZone,
    availableSlots, presentSlots
  };
});
