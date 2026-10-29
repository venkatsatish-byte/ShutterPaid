// Booking emails (no I/O). Phase 3: the customer's confirmation with their manage link.
// Requires SPMarkdown (markdown.js) to be loaded first.
(function (root, factory) {
  const api = factory(root.SPMarkdown || (typeof require === 'function' ? require('./markdown.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SPBookingEmail = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  const esc = M.escape;

  function when(startISO, endISO, tz) {
    const opts = { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' };
    const start = new Date(startISO).toLocaleString('en-US', opts);
    const end = new Date(endISO).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    return start + ' – ' + end;
  }

  function money(amount, currency) {
    try {
      const n = Number(amount);
      return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: n % 1 ? 2 : 0 }).format(n);
    } catch (e) {
      return currency + ' ' + Number(amount).toFixed(2);
    }
  }

  /**
   * d: { customerName, photographerName, eventName, start, end, timeZone, location, price, currency,
   *      advancePaid, instructions (markdown), policy (markdown), manageUrl }
   */
  function confirmation(d) {
    const whenText = when(d.start, d.end, d.timeZone);
    const subject = 'Booked: ' + d.eventName + ' with ' + d.photographerName;
    const payLine = d.advancePaid > 0
      ? 'Paid in advance: ' + money(d.advancePaid, d.currency) + '. Balance: ' + money(Math.max(0, d.price - d.advancePaid), d.currency) + '.'
      : 'Price: ' + money(d.price, d.currency) + ', paid to ' + d.photographerName + ' later.';
    const text = [
      'Hi ' + d.customerName + ',',
      '',
      'Your booking with ' + d.photographerName + ' is confirmed.',
      '',
      d.eventName,
      whenText,
      d.location ? 'Where: ' + d.location : '',
      payLine,
      '',
      d.instructions ? 'Before your session:\n' + M.toText(d.instructions) + '\n' : '',
      'View, reschedule or cancel your booking: ' + d.manageUrl,
      d.policy ? '\nCancellation policy:\n' + M.toText(d.policy) : '',
      '',
      'Sent by ShutterPaid on behalf of ' + d.photographerName + '. Reply to this email to contact them.'
    ].filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n');

    const section = (title, body) => body
      ? '<h2 style="font-size:16px;margin:24px 0 8px">' + esc(title) + '</h2><div>' + body + '</div>'
      : '';
    const html = '<!doctype html><html><body style="margin:0;padding:24px;background:#f7f6fb;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a2e">' +
      '<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4e2ef;border-radius:12px;padding:24px;line-height:1.55;font-size:15px">' +
      '<p>Hi ' + esc(d.customerName) + ',</p>' +
      '<p>Your booking with <strong>' + esc(d.photographerName) + '</strong> is confirmed.</p>' +
      '<div style="border:1px solid #e4e2ef;border-radius:10px;padding:14px 16px;margin:16px 0">' +
        '<div style="font-weight:700;font-size:16px">' + esc(d.eventName) + '</div>' +
        '<div>' + esc(whenText) + '</div>' +
        (d.location ? '<div>' + esc(d.location) + '</div>' : '') +
        '<div style="color:#4a4b63;margin-top:6px">' + esc(payLine) + '</div>' +
      '</div>' +
      '<p><a href="' + esc(d.manageUrl) + '" style="display:inline-block;background:#e2366b;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:999px">View or change your booking</a></p>' +
      section('Before your session', d.instructions ? M.toHtml(d.instructions) : '') +
      section('Cancellation policy', d.policy ? M.toHtml(d.policy) : '') +
      '</div>' +
      '<p style="max-width:560px;margin:16px auto 0;font-size:12px;color:#64657d">Sent by ShutterPaid on behalf of ' + esc(d.photographerName) + '. Reply to this email to contact them.</p>' +
      '</body></html>';
    return { subject, text, html };
  }

  return { confirmation, when, money };
});
