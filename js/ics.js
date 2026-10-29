// Calendar helpers: an .ics file (Apple Calendar, Outlook, most apps) and a Google Calendar link.
// Pure; shared by the booking page, the tests and (later) emails.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SPIcs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 20261102T140000Z
  function stamp(ms) {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  // RFC 5545 text escaping.
  function text(s) {
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }

  // Lines longer than 75 bytes are folded (continuation lines start with a space).
  function fold(line) {
    const bytes = (s) => new TextEncoder().encode(s).length;
    if (bytes(line) <= 75) return line;
    const out = [];
    let cur = '';
    for (const ch of line) {
      if (bytes(cur + ch) > (out.length ? 74 : 75)) {
        out.push(cur);
        cur = '';
      }
      cur += ch;
    }
    out.push(cur);
    return out.join('\r\n ');
  }

  /**
   * ev: { uid, start, end (ms or ISO), title, description, location, url, method?, sequence?, status? }
   * method 'CANCEL' + status 'CANCELLED' removes it from calendars that imported it.
   */
  function buildIcs(ev) {
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ShutterPaid//Bookings//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:' + (ev.method || 'PUBLISH'),
      'BEGIN:VEVENT',
      'UID:' + text(ev.uid),
      'DTSTAMP:' + stamp(ev.now || Date.now()),
      'DTSTART:' + stamp(+new Date(ev.start)),
      'DTEND:' + stamp(+new Date(ev.end)),
      'SEQUENCE:' + (ev.sequence || 0),
      'STATUS:' + (ev.status || 'CONFIRMED'),
      'SUMMARY:' + text(ev.title)
    ];
    if (ev.description) lines.push('DESCRIPTION:' + text(ev.description));
    if (ev.location) lines.push('LOCATION:' + text(ev.location));
    if (ev.url) lines.push('URL:' + text(ev.url));
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  function googleCalendarUrl(ev) {
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: ev.title,
      dates: stamp(+new Date(ev.start)) + '/' + stamp(+new Date(ev.end)),
      details: ev.description || '',
      location: ev.location || ''
    });
    return 'https://calendar.google.com/calendar/render?' + params.toString();
  }

  return { buildIcs, googleCalendarUrl, stamp };
});
