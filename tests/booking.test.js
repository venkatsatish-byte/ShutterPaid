// Tests for the booking setup rules (js/booking.js) and the safe Markdown renderer (js/markdown.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../js/booking.js');
const M = require('../js/markdown.js');

test('slugify makes clean booking links', () => {
  assert.equal(B.slugify('Venkat Photos'), 'venkat-photos');
  assert.equal(B.slugify('  Rivera & Co. Photography!! '), 'rivera-and-co-photography');
  assert.equal(B.slugify('Zoë Café Studio'), 'zoe-cafe-studio');
  assert.equal(B.slugify('---'), '');
  assert.equal(B.slugify('a'.repeat(60)).length, 40);
  assert.ok(!B.slugify('x'.repeat(39) + ' y').endsWith('-'));
});

test('slugProblem enforces the same rules as the database', () => {
  assert.equal(B.slugProblem('venkat-photos'), null);
  assert.equal(B.slugProblem('ab'), 'Use at least 3 characters.');
  assert.match(B.slugProblem('Venkat'), /lowercase/);
  assert.match(B.slugProblem('a--b'), /single hyphens/);
  assert.match(B.slugProblem('-abc'), /single hyphens/);
  assert.match(B.slugProblem('admin'), /reserved/);
  assert.match(B.slugProblem(''), /Choose/);
});

test('depositAmount: fixed, percent, capped, none', () => {
  const et = (o) => B.newEventType(Object.assign({ price: 1200, depositMode: 'optional' }, o));
  assert.equal(B.depositAmount(et({ depositType: 'percent', depositValue: 25 })), 300);
  assert.equal(B.depositAmount(et({ depositType: 'percent', depositValue: 33.33, price: 99.99 })), 33.33);
  assert.equal(B.depositAmount(et({ depositType: 'fixed', depositValue: 150 })), 150);
  assert.equal(B.depositAmount(et({ depositType: 'fixed', depositValue: 5000 })), 1200);
  assert.equal(B.depositAmount(et({ depositMode: 'none', depositValue: 25 })), 0);
  assert.equal(B.depositAmount(null), 0);
});

test('eventTypeProblems', () => {
  assert.deepEqual(B.eventTypeProblems(B.newEventType({ name: 'Portrait' })), {});
  const p = B.eventTypeProblems(B.newEventType({ name: ' ', durationMinutes: 10, bufferAfter: -5, locationType: 'moon' }));
  assert.deepEqual(Object.keys(p).sort(), ['bufferAfter', 'durationMinutes', 'locationType', 'name']);
  assert.ok(B.eventTypeProblems(B.newEventType({ name: 'W', price: 0, depositMode: 'optional' })).depositValue);
  assert.ok(B.eventTypeProblems(B.newEventType({ name: 'W', price: 100, depositMode: 'optional', depositType: 'percent', depositValue: 120 })).depositValue);
  assert.ok(B.eventTypeProblems(B.newEventType({ name: 'W', price: 100, depositMode: 'optional', depositType: 'fixed', depositValue: 150 })).depositValue);
  assert.deepEqual(B.eventTypeProblems(B.newEventType({ name: 'W', price: 100, depositMode: 'optional', depositType: 'fixed', depositValue: 40 })), {});
  // Presets are valid as they are.
  Object.values(B.PRESETS).forEach((p) => assert.deepEqual(B.eventTypeProblems(B.newEventType(p)), {}, p.name));
});

test('hoursProblem catches bad and overlapping ranges', () => {
  assert.equal(B.hoursProblem([{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }]), null);
  assert.match(B.hoursProblem([{ start: '12:00', end: '09:00' }]), /after its start/);
  assert.match(B.hoursProblem([{ start: '09:00', end: '13:00' }, { start: '12:00', end: '17:00' }]), /overlap/);
  assert.match(B.hoursProblem([{ start: '', end: '17:00' }]), /start and end/);
  assert.equal(B.hoursProblem([{ start: '09:00', end: '12:00' }, { start: '12:00', end: '13:00' }]), null);
  assert.equal(B.fromMinutes(B.toMinutes('07:05')), '07:05');
  assert.equal(B.defaultHours().length, 5);
});

test('blockedProblem', () => {
  assert.equal(B.blockedProblem({ startDate: '2026-12-20', endDate: '2027-01-02' }), null);
  assert.match(B.blockedProblem({ startDate: '2026-12-20', endDate: '2026-12-19' }), /on or after/);
  assert.match(B.blockedProblem({ startDate: '', endDate: '2026-12-19' }), /first and last/);
});

test('row mapping round-trips', () => {
  const et = B.newEventType({ id: 'e1', name: 'Wedding', price: 2500, depositMode: 'optional', depositType: 'fixed', depositValue: 500, instructions: '**Bring** water' });
  assert.deepEqual(B.rowToEventType(B.eventTypeToRow(et, 'u1')), et);
  const prof = { slug: 'venkat-photos', displayName: 'Venkat', photoUrl: '', bio: 'Hi', timeZone: 'America/New_York', accepting: true, minNoticeMinutes: 1440, maxDaysAhead: 90, maxPerDay: '', cancellationPolicy: 'x' };
  assert.deepEqual(B.rowToProfile(B.profileToRow(prof, 'u1')), prof);
  assert.equal(B.profileToRow(Object.assign({}, prof, { maxPerDay: 2 }), 'u1').max_per_day, 2);
  assert.deepEqual(B.rowToHour({ id: 'h', weekday: 1, start_time: '09:00:00', end_time: '17:30:00' }), { id: 'h', weekday: 1, start: '09:00', end: '17:30' });
  const bl = { id: 'b', startDate: '2026-12-20', endDate: '2026-12-27', note: 'Holiday' };
  assert.deepEqual(B.rowToBlocked(B.blockedToRow(bl, 'u')), bl);
});

test('format helpers', () => {
  assert.equal(B.formatDuration(90), '1 h 30 min');
  assert.equal(B.formatDuration(45), '45 min');
  assert.equal(B.formatDuration(480), '8 h');
  assert.equal(B.formatNotice(1440), '1 day');
  assert.equal(B.formatNotice(2880), '2 days');
  assert.equal(B.formatNotice(120), '2 hours');
  assert.equal(B.formatNotice(0), 'No minimum notice');
});

test('markdown renders the supported subset', () => {
  const html = M.toHtml('# Before the day\n**Bring** water and *snacks*.\nSecond line\n\n- One\n- Two\n\n1. First\n2. Second\n\n[Shot list](https://forms.example.com/x) or https://maps.example.com/p.');
  assert.match(html, /<h3>Before the day<\/h3>/);
  assert.match(html, /<p><strong>Bring<\/strong> water and <em>snacks<\/em>\.<br>Second line<\/p>/);
  assert.match(html, /<ul><li>One<\/li><li>Two<\/li><\/ul>/);
  assert.match(html, /<ol><li>First<\/li><li>Second<\/li><\/ol>/);
  assert.match(html, /<a href="https:\/\/forms\.example\.com\/x" target="_blank" rel="noopener noreferrer">Shot list<\/a>/);
  assert.match(html, /<a href="https:\/\/maps\.example\.com\/p"[^>]*>https:\/\/maps\.example\.com\/p<\/a>\./);
});

test('markdown never lets markup or unsafe links through', () => {
  const evil = M.toHtml('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[click](javascript:alert(1))\n[x](https://a.example/"onmouseover="alert(1))\n[d](data:text/html,hi)');
  assert.ok(!/<script|<img|javascript:|data:text|onmouseover="/.test(evil), evil);
  assert.match(evil, /&lt;script&gt;/);
  assert.match(evil, /<p>[^]*click/);
  assert.equal(M.toHtml(''), '');
});

test('markdown to plain text', () => {
  assert.equal(M.toText('# Title\n**Bold** and *it*\n* item\n[Map](https://m.example)'), 'Title\nBold and it\n- item\nMap (https://m.example)');
});
