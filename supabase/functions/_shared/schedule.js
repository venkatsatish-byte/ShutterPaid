// ShutterPaid reminder schedule and email copy. Pure functions, no DOM or network.
// Shared by the app (classic <script>, window.SPSchedule), the tests (require) and the
// send-reminders Edge Function (Deno). The copy in supabase/functions/_shared/schedule.js must stay
// identical: run `npm run sync-shared` after editing this file (a test checks they match).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SPSchedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TONES = ['friendly', 'firm', 'final'];
  const TONE_LABELS = { friendly: 'Friendly', firm: 'Firm', final: 'Final notice' };

  // offset = days relative to the due date (negative = before).
  const DEFAULT_SCHEDULE = [
    { offset: -3, tone: 'friendly' },
    { offset: 0, tone: 'friendly' },
    { offset: 7, tone: 'firm' },
    { offset: 21, tone: 'final' }
  ];
  const DEFAULT_SEND_HOUR = 9;
  // If a run is missed (outage, job paused), a step can still go out this many days late.
  const GRACE_DAYS = 3;
  const MAX_STEPS = 8;

  // ---------- Dates (yyyy-mm-dd strings, calendar arithmetic in UTC to avoid DST issues) ----------
  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return t.toISOString().slice(0, 10);
  }

  function daysBetween(fromISO, toISO) {
    const a = fromISO.split('-').map(Number);
    const b = toISO.split('-').map(Number);
    return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
  }

  function validTimeZone(tz) {
    if (!tz) return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch (e) {
      return false;
    }
  }

  // The calendar date and hour at `now` in time zone `tz` (falls back to UTC).
  function localNow(now, tz) {
    const zone = validTimeZone(tz) ? tz : 'UTC';
    const parts = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(now).forEach((p) => { parts[p.type] = p.value; });
    return { date: parts.year + '-' + parts.month + '-' + parts.day, hour: Number(parts.hour) % 24, timeZone: zone };
  }

  // ---------- Schedule ----------
  // Clean up a user-supplied schedule: valid tones, whole-day offsets within range, one step per day,
  // sorted by date. Returns the default schedule if nothing valid is left.
  function normalizeSchedule(steps, fallback) {
    const seen = new Set();
    const out = (Array.isArray(steps) ? steps : [])
      .map((s) => ({ offset: Math.round(Number(s && s.offset)), tone: s && s.tone }))
      .filter((s) => Number.isFinite(s.offset) && s.offset >= -60 && s.offset <= 365 && TONES.includes(s.tone))
      .filter((s) => !seen.has(s.offset) && seen.add(s.offset))
      .sort((a, b) => a.offset - b.offset)
      .slice(0, MAX_STEPS);
    return out.length ? out : (fallback === undefined ? DEFAULT_SCHEDULE.slice() : fallback);
  }

  function scheduleFor(invoice, profileSchedule) {
    return normalizeSchedule(invoice.reminderSchedule || profileSchedule);
  }

  function stepDate(dueDate, step) {
    return addDays(dueDate, step.offset);
  }

  // Unique key of one scheduled send. reminder_log has a unique index on the same pair, which is
  // what makes sending idempotent.
  function stepKey(dueDate, step) {
    return stepDate(dueDate, step) + '|' + step.offset;
  }

  function autoActive(invoice) {
    return !!(invoice.autoRemind && !invoice.paid && !invoice.remindersStoppedAt && invoice.clientEmail);
  }

  // The one step (if any) that should be sent today. Only the most recent due step is sent, so
  // turning auto-reminders on for an old invoice never sends a burst of catch-up emails.
  // `sentKeys` holds stepKey()s already in reminder_log for this invoice.
  function dueStep(invoice, schedule, today, sentKeys) {
    if (!autoActive(invoice)) return null;
    const sent = sentKeys || new Set();
    let best = null;
    schedule.forEach((step) => {
      const date = stepDate(invoice.dueDate, step);
      const late = daysBetween(date, today);
      if (late < 0 || late > GRACE_DAYS) return;
      if (!best || date > best.date) best = { step, date, key: stepKey(invoice.dueDate, step) };
    });
    if (!best || sent.has(best.key)) return null;
    // A step that's already been superseded by a later sent step is never sent.
    const later = schedule.some((s) => stepDate(invoice.dueDate, s) > best.date && sent.has(stepKey(invoice.dueDate, s)));
    return later ? null : best;
  }

  // The next upcoming send for display in the app (today counts if it hasn't gone out yet).
  function nextStep(invoice, schedule, today, sentKeys) {
    if (!autoActive(invoice)) return null;
    const sent = sentKeys || new Set();
    const now = dueStep(invoice, schedule, today, sent);
    if (now) return now;
    for (const step of schedule) {
      const date = stepDate(invoice.dueDate, step);
      if (date > today && !sent.has(stepKey(invoice.dueDate, step))) return { step, date, key: stepKey(invoice.dueDate, step) };
    }
    return null;
  }

  function describeStep(step) {
    const n = Math.abs(step.offset);
    const when = step.offset === 0 ? 'on the due date'
      : n + ' day' + (n === 1 ? '' : 's') + (step.offset < 0 ? ' before' : ' after');
    return TONE_LABELS[step.tone] + ' ' + when;
  }

  // ---------- Email copy ----------
  function formatMoney(amount, currency, locale) {
    const n = Number(amount || 0);
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency', currency: currency || 'USD',
        minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: n % 1 === 0 ? 0 : 2
      }).format(n);
    } catch (e) {
      return (currency || '') + ' ' + n.toFixed(2);
    }
  }

  function formatDate(iso, locale) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }

  // Subject and plain-text body of a reminder, in one of three tones.
  function buildReminder(inv, s, tone, today, locale) {
    const first = (inv.clientName || '').split(/\s|&/)[0] || 'there';
    const amount = formatMoney(inv.amount, inv.currency || s.currency, locale);
    const ref = inv.number ? ' (' + inv.number + ')' : '';
    const shoot = inv.shootType ? inv.shootType.toLowerCase() + ' session' : 'session';
    const due = formatDate(inv.dueDate, locale);
    const n = daysBetween(today, inv.dueDate);
    // The invoice's own Stripe payment link wins over the general payment link from Settings.
    const link = inv.paymentUrl || s.paymentLink;
    const pay = link ? '\n\nYou can pay quickly and securely here:\n' + link : '';
    const sig = '\n\n' + (s.signature || [s.ownerName, s.businessName].filter(Boolean).join('\n') || 'Thank you!');
    const biz = s.businessName ? ' from ' + s.businessName : '';
    const dueText = n > 0 ? 'is due on ' + due : n === 0 ? 'is due today' : 'was due on ' + due;

    if (tone === 'firm') {
      return {
        subject: 'Payment overdue: invoice' + ref + ' for ' + amount,
        body: 'Hi ' + first + ',\n\n' +
          'I\'m following up on the invoice' + ref + ' for your ' + shoot + '. The balance of ' + amount + ' ' + dueText +
          ', and I haven\'t received payment yet.\n\n' +
          'Please arrange payment within the next 7 days. If you\'ve already sent it, please let me know so I can update my records.' +
          pay + sig
      };
    }
    if (tone === 'final') {
      return {
        subject: 'Final notice: invoice' + ref + ' for ' + amount,
        body: 'Hi ' + first + ',\n\n' +
          'This is a final reminder that the invoice' + ref + ' for your ' + shoot + ', totalling ' + amount + ', ' + dueText +
          ' and is still unpaid.\n\n' +
          'Please settle the balance within 5 business days. After that I may need to apply late fees or take further steps, as set out in our agreement. ' +
          'I\'d much rather sort this out together, so please reply if anything is holding up the payment.' +
          pay + sig
      };
    }
    return {
      subject: 'Friendly reminder: invoice' + ref + biz,
      body: 'Hi ' + first + ',\n\n' +
        'I hope you\'re loving your photos! 📸 Just a friendly reminder that the invoice' + ref + ' for your ' + shoot +
        ' (' + amount + ') ' + dueText + '.' + pay +
        '\n\nIf you\'ve already paid, thank you, and please ignore this note.' + sig
    };
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function linkify(escaped) {
    return escaped.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => '<a href="' + u + '">' + u + '</a>');
  }

  function senderName(s) {
    // Display names go in an email header: keep them to one plain line.
    return String(s.ownerName || s.businessName || 'Your photographer').replace(/[\r\n"<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  // A complete automatic reminder email: the same copy as a manual reminder plus a footer naming
  // the business and a link that stops reminders for this invoice.
  function buildEmail(inv, s, tone, today, stopUrl, locale) {
    const r = buildReminder(inv, s, tone, today, locale);
    const business = s.businessName || s.ownerName;
    const footerText = 'Sent on behalf of ' + business + ' by ShutterPaid. ' +
      'Don\'t want reminders about this invoice? Stop them here: ' + stopUrl;
    const text = r.body + '\n\n--\n' + footerText;
    const html = '<!doctype html><html><body style="margin:0;padding:24px;background:#f7f6fb;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a2e">' +
      '<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4e2ef;border-radius:12px;padding:24px;line-height:1.55;font-size:15px">' +
      linkify(escapeHtml(r.body)).replace(/\n/g, '<br>') +
      '</div>' +
      '<p style="max-width:560px;margin:16px auto 0;font-size:12px;color:#64657d;line-height:1.5">' +
      'Sent on behalf of <strong>' + escapeHtml(business) + '</strong> by ShutterPaid. ' +
      'Don\'t want reminders about this invoice? <a href="' + escapeHtml(stopUrl) + '" style="color:#64657d">Stop reminders</a>.' +
      '</p></body></html>';
    return { subject: r.subject, text, html, fromName: senderName(s) };
  }

  return {
    TONES, TONE_LABELS, DEFAULT_SCHEDULE, DEFAULT_SEND_HOUR, GRACE_DAYS, MAX_STEPS,
    addDays, daysBetween, validTimeZone, localNow,
    normalizeSchedule, scheduleFor, stepDate, stepKey, autoActive, dueStep, nextStep, describeStep,
    formatMoney, formatDate, buildReminder, buildEmail, escapeHtml, senderName
  };
});
