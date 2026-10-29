// Tests for the reminder scheduler, email copy and the send-reminders run (with fake I/O).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../js/schedule.js');
const { runReminders } = require('../supabase/functions/_shared/reminders.js');

const DUE = '2026-03-20';
const inv = (o) => Object.assign({ id: 'inv-1', clientName: 'Priya & Sam', clientEmail: 'priya@example.com', shootType: 'Wedding', number: 'INV-1001', amount: 2400, currency: 'USD', dueDate: DUE, paid: false, autoRemind: true }, o);
const sched = S.DEFAULT_SCHEDULE;

test('Edge Function copies of shared modules are identical to js/', () => {
  for (const f of ['schedule', 'slots', 'booking', 'markdown']) {
    const a = fs.readFileSync(path.join(__dirname, '../js/' + f + '.js'), 'utf8');
    const b = fs.readFileSync(path.join(__dirname, '../supabase/functions/_shared/' + f + '.js'), 'utf8');
    assert.equal(a, b, f + '.js differs: run npm run sync-shared');
  }
});

test('normalizeSchedule cleans user input', () => {
  assert.deepEqual(S.normalizeSchedule([{ offset: 7, tone: 'firm' }, { offset: '-3', tone: 'friendly' }, { offset: 7, tone: 'final' }, { offset: 2, tone: 'rude' }, { offset: 999, tone: 'firm' }]),
    [{ offset: -3, tone: 'friendly' }, { offset: 7, tone: 'firm' }]);
  assert.deepEqual(S.normalizeSchedule([]), sched);
  assert.deepEqual(S.normalizeSchedule(null), sched);
  assert.equal(S.normalizeSchedule(Array.from({ length: 20 }, (_, i) => ({ offset: i, tone: 'firm' }))).length, S.MAX_STEPS);
});

test('scheduleFor prefers the invoice schedule', () => {
  assert.deepEqual(S.scheduleFor(inv({ reminderSchedule: [{ offset: 1, tone: 'firm' }] }), sched), [{ offset: 1, tone: 'firm' }]);
  assert.deepEqual(S.scheduleFor(inv(), [{ offset: 2, tone: 'final' }]), [{ offset: 2, tone: 'final' }]);
});

test('localNow respects time zones and DST', () => {
  const t = new Date('2026-03-08T07:30:00Z'); // US DST starts 2026-03-08 at 2am local
  assert.deepEqual(S.localNow(t, 'America/Los_Angeles'), { date: '2026-03-07', hour: 23, timeZone: 'America/Los_Angeles' });
  assert.deepEqual(S.localNow(t, 'Asia/Kolkata'), { date: '2026-03-08', hour: 13, timeZone: 'Asia/Kolkata' });
  assert.deepEqual(S.localNow(new Date('2026-03-08T11:00:00Z'), 'America/Los_Angeles').hour, 4); // now PDT (UTC-7)
  assert.deepEqual(S.localNow(t, 'Not/AZone').timeZone, 'UTC');
  assert.deepEqual(S.localNow(t, '').date, '2026-03-08');
});

test('dueStep picks the step for today', () => {
  assert.equal(S.dueStep(inv(), sched, '2026-03-16'), null);
  assert.deepEqual(S.dueStep(inv(), sched, '2026-03-17').step, { offset: -3, tone: 'friendly' });
  assert.equal(S.dueStep(inv(), sched, '2026-03-20').key, '2026-03-20|0');
  assert.equal(S.dueStep(inv(), sched, '2026-03-27').step.tone, 'firm');
  assert.equal(S.dueStep(inv(), sched, '2026-04-10').step.tone, 'final');
});

test('dueStep never sends twice and catches up only a few days', () => {
  const sent = new Set(['2026-03-17|-3']);
  assert.equal(S.dueStep(inv(), sched, '2026-03-17', sent), null);
  assert.equal(S.dueStep(inv(), sched, '2026-03-18', sent), null);
  // Missed run: still sent within the grace period...
  assert.equal(S.dueStep(inv(), sched, '2026-03-30').step.tone, 'firm');
  // ...but not after it.
  assert.equal(S.dueStep(inv(), sched, '2026-03-31'), null);
  // Turned on long after the due date: only the latest step goes, not a burst of old ones.
  assert.equal(S.dueStep(inv(), sched, '2026-04-11').step.offset, 21);
  assert.equal(S.dueStep(inv(), sched, '2026-04-11', new Set(['2026-04-10|21'])), null);
});

test('dueStep stops for paid, stopped, switched-off or email-less invoices', () => {
  assert.equal(S.dueStep(inv({ paid: true }), sched, DUE), null);
  assert.equal(S.dueStep(inv({ remindersStoppedAt: '2026-03-18T10:00:00Z' }), sched, DUE), null);
  assert.equal(S.dueStep(inv({ autoRemind: false }), sched, DUE), null);
  assert.equal(S.dueStep(inv({ clientEmail: '' }), sched, DUE), null);
});

test('nextStep shows what is coming', () => {
  assert.equal(S.nextStep(inv(), sched, '2026-03-01').date, '2026-03-17');
  assert.equal(S.nextStep(inv(), sched, '2026-03-17').date, '2026-03-17');
  assert.equal(S.nextStep(inv(), sched, '2026-03-17', new Set(['2026-03-17|-3'])).date, '2026-03-20');
  assert.equal(S.nextStep(inv(), sched, '2026-05-01'), null);
  assert.equal(S.nextStep(inv({ paid: true }), sched, '2026-03-01'), null);
});

test('describeStep', () => {
  assert.equal(S.describeStep({ offset: -3, tone: 'friendly' }), 'Friendly 3 days before');
  assert.equal(S.describeStep({ offset: 0, tone: 'friendly' }), 'Friendly on the due date');
  assert.equal(S.describeStep({ offset: 1, tone: 'final' }), 'Final notice 1 day after');
});

test('buildReminder wording follows the due date', () => {
  const s = { ownerName: 'Alex', businessName: 'Rivera Photo', paymentLink: 'https://pay.example/alex' };
  assert.match(S.buildReminder(inv(), s, 'friendly', '2026-03-17', 'en-US').body, /is due on Mar 20, 2026/);
  assert.match(S.buildReminder(inv(), s, 'friendly', DUE, 'en-US').body, /is due today/);
  const firm = S.buildReminder(inv(), s, 'firm', '2026-03-27', 'en-US');
  assert.match(firm.subject, /^Payment overdue: invoice \(INV-1001\) for \$2,400$/);
  assert.match(firm.body, /was due on Mar 20, 2026/);
  assert.match(S.buildReminder(inv(), s, 'final', '2026-04-10', 'en-US').subject, /^Final notice/);
});

test('buildEmail names the business, links to stop, and escapes content', () => {
  const s = { ownerName: 'Alex "The" <Rivera>', businessName: 'Rivera & Co <Photo>', paymentLink: 'https://pay.example/a?b=1&c=2' };
  const e = S.buildEmail(inv({ clientName: '<script>x</script>' }), s, 'friendly', DUE, 'https://app.example/stop.html?t=abc', 'en-US');
  assert.match(e.text, /Sent on behalf of Rivera & Co <Photo> by ShutterPaid/);
  assert.match(e.text, /https:\/\/app\.example\/stop\.html\?t=abc/);
  assert.ok(e.html.includes('Rivera &amp; Co &lt;Photo&gt;'));
  assert.ok(e.html.includes('href="https://app.example/stop.html?t=abc"'));
  assert.ok(!e.html.includes('<script>'));
  assert.ok(e.html.includes('href="https://pay.example/a?b=1&amp;c=2"'));
  assert.equal(e.fromName, 'Alex The Rivera');
  // Falls back to the owner name when there is no business name.
  assert.match(S.buildEmail(inv(), { ownerName: 'Alex' }, 'firm', DUE, 'u', 'en-US').text, /behalf of Alex/);
});

// ---------- The run ----------
function fakeDeps(rows, opts) {
  const log = new Map(); // key invoiceId|date|offset -> { id, status }
  const sent = [];
  let n = 0;
  const deps = {
    now: opts.now,
    candidates: async () => rows,
    sentKeys: async () => {
      const m = new Map();
      for (const [k, r] of log) {
        if (r.status !== 'sent') continue;
        const [id, d, o] = k.split('|');
        if (!m.has(id)) m.set(id, new Set());
        m.get(id).add(d + '|' + o);
      }
      return m;
    },
    // Mirrors claim_auto_reminder: one row per step; only failed rows can be retried.
    claim: async (a) => {
      const k = a.invoiceId + '|' + a.scheduledFor + '|' + a.stepOffset;
      const r = log.get(k);
      if (r && r.status !== 'failed') return null;
      const id = r ? r.id : 'log-' + (++n);
      log.set(k, { id, status: 'sending' });
      return id;
    },
    send: async (email) => {
      if (opts.failFor && email.to === opts.failFor) throw new Error('Resend 422: invalid to');
      sent.push(email);
      return 'msg-' + sent.length;
    },
    markSent: async (id) => { for (const r of log.values()) if (r.id === id) r.status = 'sent'; },
    markFailed: async (id) => { for (const r of log.values()) if (r.id === id) r.status = 'failed'; },
    sleep: async () => {}
  };
  return { deps, sent, log };
}

const CONFIG = { appUrl: 'https://app.example/', functionsUrl: 'https://ref.supabase.co/functions/v1', fromEmail: 'reminders@mail.example', minIntervalMs: 0 };
const profile = (o) => Object.assign({ email: 'alex@studio.example', ownerName: 'Alex Rivera', businessName: 'Rivera Photo', timeZone: 'Europe/London', sendHour: 9, reminderSchedule: sched }, o);

test('run sends due reminders with sender name, reply-to, stop link and headers', async () => {
  const rows = [{ invoice: inv(), profile: profile(), token: 'tok-1' }];
  const { deps, sent } = fakeDeps(rows, { now: new Date('2026-03-17T10:00:00Z') });
  const report = await runReminders(deps, CONFIG);
  assert.equal(report.sent, 1);
  const e = sent[0];
  assert.equal(e.from, 'Alex Rivera <reminders@mail.example>');
  assert.equal(e.replyTo, 'alex@studio.example');
  assert.equal(e.to, 'priya@example.com');
  assert.equal(e.idempotencyKey, 'reminder-log-1');
  assert.match(e.text, /https:\/\/app\.example\/stop\.html\?t=tok-1/);
  assert.equal(e.headers['List-Unsubscribe'], '<https://ref.supabase.co/functions/v1/stop-reminders?t=tok-1>');
  assert.match(e.subject, /^Friendly reminder/);
});

test('run is idempotent: a second (or concurrent) run sends nothing new', async () => {
  const rows = [{ invoice: inv(), profile: profile({ replyTo: 'billing@studio.example' }), token: 't' }];
  const { deps, sent } = fakeDeps(rows, { now: new Date('2026-03-20T12:00:00Z') });
  await Promise.all([runReminders(deps, CONFIG), runReminders(deps, CONFIG)]);
  await runReminders(deps, CONFIG);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].replyTo, 'billing@studio.example');
});

test('run waits for each user\'s local send hour', async () => {
  const rows = [
    { invoice: inv({ id: 'la' }), profile: profile({ timeZone: 'America/Los_Angeles' }), token: 'a' },
    { invoice: inv({ id: 'in' }), profile: profile({ timeZone: 'Asia/Kolkata' }), token: 'b' }
  ];
  // 14:00 UTC = 07:00 in LA (before 9am, so wait), 19:30 in Kolkata (send).
  const { deps, sent } = fakeDeps(rows, { now: new Date('2026-03-17T14:00:00Z') });
  const report = await runReminders(deps, CONFIG);
  assert.deepEqual(sent.map((e) => e.headers['List-Unsubscribe']), ['<https://ref.supabase.co/functions/v1/stop-reminders?t=b>']);
  assert.equal(report.skipped['before-send-hour'], 1);
});

test('run skips accounts without a business name and bad client emails', async () => {
  const rows = [
    { invoice: inv({ id: 'a' }), profile: profile({ businessName: '', ownerName: '' }), token: 'a' },
    { invoice: inv({ id: 'b', clientEmail: 'not-an-email' }), profile: profile(), token: 'b' }
  ];
  const { deps, sent } = fakeDeps(rows, { now: new Date('2026-03-20T12:00:00Z') });
  const report = await runReminders(deps, CONFIG);
  assert.equal(sent.length, 0);
  assert.deepEqual(report.skipped, { 'no-business-name': 1, 'bad-client-email': 1 });
});

test('a failed send is recorded and retried on the next run', async () => {
  const rows = [{ invoice: inv(), profile: profile(), token: 't' }];
  const opts = { now: new Date('2026-03-20T12:00:00Z'), failFor: 'priya@example.com' };
  const { deps, sent, log } = fakeDeps(rows, opts);
  const r1 = await runReminders(deps, CONFIG);
  assert.equal(r1.failed, 1);
  assert.equal([...log.values()][0].status, 'failed');
  opts.failFor = null;
  const r2 = await runReminders(deps, CONFIG);
  assert.equal(r2.sent, 1);
  assert.equal(sent[0].idempotencyKey, 'reminder-log-1');
});

test('dry run plans without claiming or sending', async () => {
  const rows = [{ invoice: inv(), profile: profile(), token: 't' }];
  const { deps, sent, log } = fakeDeps(rows, { now: new Date('2026-03-20T12:00:00Z') });
  deps.dryRun = true;
  const report = await runReminders(deps, CONFIG);
  assert.deepEqual(report.planned, [{ invoiceId: 'inv-1', date: DUE, offset: 0, tone: 'friendly' }]);
  assert.equal(sent.length + log.size, 0);
});

test('reminders use the invoice payment link over the general one', () => {
  const s = { ownerName: 'Alex', businessName: 'Rivera', paymentLink: 'https://paypal.me/alex' };
  assert.match(S.buildReminder(inv(), s, 'friendly', DUE, 'en-US').body, /paypal\.me\/alex/);
  const r = S.buildReminder(inv({ paymentUrl: 'https://buy.stripe.com/abc' }), s, 'friendly', DUE, 'en-US').body;
  assert.match(r, /buy\.stripe\.com\/abc/);
  assert.ok(!/paypal/.test(r));
});

test('run adds the Stripe payment link, and still sends if creating it fails', async () => {
  const rows = [{ invoice: inv({ id: 'a' }), profile: profile({ paymentLink: 'https://paypal.me/alex' }), token: 'a' },
    { invoice: inv({ id: 'b', clientEmail: 'b@example.com' }), profile: profile({ paymentLink: 'https://paypal.me/alex' }), token: 'b' }];
  const { deps, sent } = fakeDeps(rows, { now: new Date('2026-03-20T12:00:00Z') });
  deps.paymentLink = async (i) => { if (i.id === 'b') throw new Error('stripe down'); return 'https://buy.stripe.com/' + i.id; };
  await runReminders(deps, CONFIG);
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /buy\.stripe\.com\/a/);
  assert.match(sent[1].text, /paypal\.me\/alex/);
});

test('reminders ask only for the balance after an advance', () => {
  const s = { ownerName: 'Alex', businessName: 'Rivera' };
  const r = S.buildReminder(inv({ amount: 300, amountPaid: 75 }), s, 'firm', '2026-03-27', 'en-US');
  assert.match(r.subject, /for \$225 \(the balance after your advance of \$75\)$/);
  assert.match(r.body, /The balance of \$225 \(the balance after your advance of \$75\)/);
  assert.match(S.buildReminder(inv({ amount: 300 }), s, 'firm', '2026-03-27', 'en-US').subject, /for \$300$/);
});
