// Run with: npm test   (or: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

const TODAY = '2026-03-10';
const inv = (o) => Object.assign({ id: C.uuid(), clientName: 'Priya & Sam', amount: 100, dueDate: TODAY, paid: false, reminders: [] }, o);

test('date helpers', () => {
  assert.equal(C.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(C.addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(C.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(C.daysBetween('2026-03-01', '2026-03-31'), 30);
  // Across a daylight-saving change the answer is still a whole number of days.
  assert.equal(C.daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.equal(C.daysBetween('2026-10-24', '2026-10-26'), 2);
  assert.equal(C.todayISO(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(C.daysUntil('2026-03-13', TODAY), 3);
  assert.equal(C.daysUntil('2026-03-07', TODAY), -3);
});

test('statusOf', () => {
  assert.equal(C.statusOf(inv({ paid: true, dueDate: '2026-01-01' }), 3, TODAY), 'paid');
  assert.equal(C.statusOf(inv({ dueDate: '2026-03-09' }), 3, TODAY), 'overdue');
  assert.equal(C.statusOf(inv({ dueDate: TODAY }), 3, TODAY), 'soon');
  assert.equal(C.statusOf(inv({ dueDate: '2026-03-13' }), 3, TODAY), 'soon');
  assert.equal(C.statusOf(inv({ dueDate: '2026-03-14' }), 3, TODAY), 'open');
  assert.equal(C.statusOf(inv({ dueDate: '2026-03-11' }), '0', TODAY), 'open');
});

test('relativeDue', () => {
  const r = (d) => C.relativeDue(inv({ dueDate: d }), TODAY);
  assert.equal(r(TODAY), 'Due today');
  assert.equal(r('2026-03-11'), 'Due tomorrow');
  assert.equal(r('2026-03-15'), 'Due in 5 days');
  assert.equal(r('2026-03-09'), 'Due yesterday');
  assert.equal(r('2026-03-01'), 'Overdue by 9 days');
  assert.equal(C.relativeDue(inv({ paid: true, paidDate: '2026-03-02' }), TODAY, (d) => 'on ' + d), 'Paid on 2026-03-02');
});

test('suggestedTone', () => {
  const r = (n) => Array.from({ length: n }, () => ({ id: C.uuid() }));
  assert.equal(C.suggestedTone(inv({ dueDate: '2026-03-12' }), TODAY), 'friendly');
  assert.equal(C.suggestedTone(inv({ dueDate: '2026-03-08' }), TODAY), 'friendly');
  assert.equal(C.suggestedTone(inv({ dueDate: '2026-03-08', reminders: r(1) }), TODAY), 'firm');
  assert.equal(C.suggestedTone(inv({ dueDate: '2026-03-01' }), TODAY), 'firm');
  assert.equal(C.suggestedTone(inv({ dueDate: '2026-02-01', reminders: r(1) }), TODAY), 'firm');
  assert.equal(C.suggestedTone(inv({ dueDate: '2026-02-01', reminders: r(2) }), TODAY), 'final');
});

test('uuid and normalizeInvoice upgrade legacy ids once', () => {
  assert.ok(C.isUuid(C.uuid()));
  assert.ok(!C.isUuid('lq3x9k2abc'));
  const legacy = { id: 'lq3x9k2abc', reminders: [{ date: TODAY, tone: 'friendly', channel: 'email' }] };
  assert.equal(C.normalizeInvoice(legacy), true);
  assert.ok(C.isUuid(legacy.id) && C.isUuid(legacy.reminders[0].id));
  assert.equal(C.normalizeInvoice(legacy), false);
});

test('planUpload skips invoices already in the account', () => {
  const a = inv({ number: 'INV-1001', amount: 2400 });
  const b = inv({ number: 'INV-1002', clientName: 'Bloom Studio' });
  const sameIdAsRemote = inv({ number: 'INV-1003' });
  const remote = [
    sameIdAsRemote,
    // Same invoice typed in on another device: different id, same details.
    inv({ number: 'inv-1001 ', clientName: 'priya & sam', amount: 2400 })
  ];
  const plan = C.planUpload([a, b, sameIdAsRemote], remote);
  assert.deepEqual(plan.upload.map((i) => i.id), [b.id]);
  assert.equal(plan.skipped.length, 2);
  // Duplicates inside the local data itself are also collapsed.
  const dup = Object.assign({}, b, { id: C.uuid() });
  assert.equal(C.planUpload([b, dup], []).upload.length, 1);
  // Running the plan again after uploading adds nothing.
  assert.equal(C.planUpload([a, b], remote.concat(plan.upload)).upload.length, 0);
});

test('mergeSettingsForUpload only fills blanks in the account', () => {
  const defaults = { ownerName: '', businessName: '', currency: 'USD', soonDays: 3, timeZone: 'Europe/London' };
  const local = { ownerName: 'Alex', businessName: 'Rivera Photo', currency: 'GBP', soonDays: 5, timeZone: 'Europe/London' };
  const fresh = C.mergeSettingsForUpload(local, { ownerName: '', businessName: '', currency: 'USD', soonDays: 3, timeZone: '' }, defaults);
  assert.equal(fresh.changed, true);
  assert.deepEqual(fresh.settings, local);
  const existing = C.mergeSettingsForUpload(local, { ownerName: 'Alexandra', businessName: '', currency: 'EUR', soonDays: 3, timeZone: '' }, defaults);
  assert.equal(existing.settings.ownerName, 'Alexandra');
  assert.equal(existing.settings.currency, 'EUR');
  assert.equal(existing.settings.businessName, 'Rivera Photo');
});

test('hasLocalData', () => {
  const defaults = { ownerName: '', currency: 'USD', timeZone: 'UTC' };
  assert.equal(C.hasLocalData({ invoices: [], settings: { ownerName: '', currency: 'USD', timeZone: 'Asia/Kolkata' } }, defaults), false);
  assert.equal(C.hasLocalData({ invoices: [], settings: { ownerName: 'Alex', currency: 'USD' } }, defaults), true);
  assert.equal(C.hasLocalData({ invoices: [inv()], settings: {} }, defaults), true);
});

test('row mapping round-trips', () => {
  const i = inv({ clientEmail: 'p@example.com', shootType: 'Wedding', number: 'INV-1', currency: 'EUR', shootDate: '', notes: 'n', paid: true, paidDate: '2026-03-02' });
  const r = { id: C.uuid(), date: TODAY, tone: 'firm', channel: 'copy', sentAt: '2026-03-10T09:00:00.000Z' };
  const row = C.invoiceToRow(i, 'user-1');
  assert.equal(row.user_id, 'user-1');
  assert.equal(row.shoot_date, null);
  const back = C.assemble([row], [C.reminderToRow(i.id, r, 'user-1')]);
  assert.deepEqual(back[0].reminders, [r]);
  assert.equal(back[0].paidDate, '2026-03-02');
  assert.equal(C.invoiceToRow(Object.assign({}, i, { paid: false }), 'u').paid_date, null);
  const s = { ownerName: 'A', soonDays: '4', timeZone: 'UTC' };
  assert.deepEqual(C.rowToSettings(C.settingsToRow(s, 'u')), { ownerName: 'A', soonDays: 4, timeZone: 'UTC' });
});

test('coalesceOps keeps order and latest value, drops work for deleted invoices', () => {
  const up = (id, v) => ({ table: 'invoices', op: 'upsert', id, row: { id, v } });
  const rem = (id, invoiceId) => ({ table: 'reminder_log', op: 'upsert', id, row: { id, invoice_id: invoiceId } });
  const ops = C.coalesceOps([up('a', 1), rem('r1', 'a'), up('b', 1), up('a', 2), rem('r2', 'b'), { table: 'invoices', op: 'delete', id: 'b' }]);
  assert.deepEqual(ops.map((o) => o.table + ':' + o.id + ':' + o.op), ['invoices:a:upsert', 'reminder_log:r1:upsert', 'invoices:b:delete']);
  assert.equal(ops[0].row.v, 2);
});

test('mergeRemote keeps pending local edits and drops rows deleted elsewhere', () => {
  const r1 = { id: C.uuid() };
  const local = [
    inv({ id: 'edited', amount: 999 }),
    inv({ id: 'new-here' }),
    inv({ id: 'deleted-elsewhere' }),
    inv({ id: 'has-pending-reminder', reminders: [r1] })
  ];
  const remote = [inv({ id: 'edited', amount: 1 }), inv({ id: 'from-server' }), inv({ id: 'has-pending-reminder' })];
  const pending = { invoices: new Set(['edited', 'new-here']), reminders: new Set([r1.id]), settings: false };
  const out = C.mergeRemote(local, remote, pending);
  assert.deepEqual(out.map((i) => i.id).sort(), ['edited', 'from-server', 'has-pending-reminder', 'new-here']);
  assert.equal(out.find((i) => i.id === 'edited').amount, 999);
  assert.deepEqual(out.find((i) => i.id === 'has-pending-reminder').reminders, [r1]);
});

test('isTransientError', () => {
  assert.equal(C.isTransientError({ message: 'TypeError: Failed to fetch', code: '' }), true);
  assert.equal(C.isTransientError({ code: 'PGRST301' }), true);
  assert.equal(C.isTransientError({ code: '42501' }), false);
  assert.equal(C.isTransientError({ code: '23514' }), false);
});

test('settings with array values compare by value', () => {
  const sched = [{ offset: 0, tone: 'friendly' }];
  const defaults = { ownerName: '', reminderSchedule: sched };
  const fromJson = JSON.parse(JSON.stringify({ invoices: [], settings: { ownerName: '', reminderSchedule: sched } }));
  assert.equal(C.hasLocalData(fromJson, defaults), false);
  const custom = [{ offset: 5, tone: 'firm' }];
  const m = C.mergeSettingsForUpload({ ownerName: '', reminderSchedule: custom }, { ownerName: 'A', reminderSchedule: JSON.parse(JSON.stringify(sched)) }, defaults);
  assert.deepEqual(m.settings.reminderSchedule, custom);
});

test('failed automatic sends do not count towards the suggested tone', () => {
  const failed = { id: C.uuid(), channel: 'auto', status: 'failed' };
  assert.equal(C.suggestedTone(inv({ dueDate: '2026-03-08', reminders: [failed] }), TODAY), 'friendly');
  assert.equal(C.suggestedTone(inv({ dueDate: '2026-03-08', reminders: [{ id: C.uuid(), channel: 'email' }] }), TODAY), 'firm');
});

test('plans: isPro, limits and errors', () => {
  const now = Date.parse('2026-03-10T00:00:00Z');
  assert.equal(C.isPro(C.planFromProfile({ plan: 'pro', current_period_end: '2026-04-01T00:00:00Z' }), now), true);
  assert.equal(C.isPro(C.planFromProfile({ plan: 'pro', current_period_end: '2026-03-08T00:00:00Z' }), now), true); // grace
  assert.equal(C.isPro(C.planFromProfile({ plan: 'pro', current_period_end: '2026-03-01T00:00:00Z' }), now), false);
  assert.equal(C.isPro(C.planFromProfile({ plan: 'free' }), now), false);
  assert.equal(C.isPro(null), false);
  assert.equal(C.planLimitError({ code: 'P0001', message: 'FREE_PLAN_LIMIT' }), 'FREE_PLAN_LIMIT');
  assert.equal(C.planLimitError({ code: 'P0001', message: 'PRO_REQUIRED' }), 'PRO_REQUIRED');
  assert.equal(C.planLimitError({ code: '42501', message: 'permission denied' }), null);
});

test('fitToPlan keeps paid invoices and the soonest-due unpaid ones', () => {
  const list = [
    inv({ id: 'p1', paid: true }), inv({ id: 'u-late', dueDate: '2026-05-01' }),
    inv({ id: 'u-soon', dueDate: '2026-03-01' }), inv({ id: 'u-mid', dueDate: '2026-04-01' })
  ];
  const r = C.fitToPlan(list, 3, 5);
  assert.deepEqual(r.fits.map((i) => i.id), ['p1', 'u-soon', 'u-mid']);
  assert.deepEqual(r.left.map((i) => i.id), ['u-late']);
  assert.equal(C.fitToPlan(list, 9, 5).fits.length, 1);
  assert.equal(C.fitToPlan(list, 0, Infinity).left.length, 0);
});

test('CSV export escapes values and blocks spreadsheet formulas', () => {
  assert.equal(C.csvCell('plain'), 'plain');
  assert.equal(C.csvCell('Priya, Sam'), '"Priya, Sam"');
  assert.equal(C.csvCell('He said "hi"'), '"He said ""hi"""');
  assert.equal(C.csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(C.csvCell('=HYPERLINK("http://evil")'), '"\'=HYPERLINK(""http://evil"")"');
  assert.equal(C.csvCell('+1 555'), "'+1 555");
  assert.equal(C.csvCell('@sum'), "'@sum");
  assert.equal(C.csvCell(null), '');
  assert.equal(C.csvCell(0), '0');
});

test('toCSV lists invoices by due date with status and reminder counts', () => {
  const csv = C.toCSV([
    inv({ number: 'INV-2', clientName: 'Late, Client', dueDate: '2026-03-20', amount: 99.5, currency: 'EUR' }),
    inv({ number: 'INV-1', currency: 'USD', dueDate: '2026-03-01', paid: true, paidDate: '2026-03-05', paidVia: 'stripe', paymentUrl: 'https://buy.stripe.com/x',
      reminders: [{ id: 'a', date: '2026-02-27', channel: 'email' }, { id: 'b', date: '2026-03-02', channel: 'auto', status: 'failed' }] })
  ], 3, TODAY);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Invoice #,Client,Client email/);
  assert.match(lines[1], /^INV-1,Priya & Sam,.*,100\.00,USD,Paid,2026-03-05,Stripe,1,2026-02-27,Off,https:\/\/buy\.stripe\.com\/x,/);
  assert.match(lines[2], /^INV-2,"Late, Client",.*,99\.50,EUR,Open,,,0,,Off,,/);
});

test('invoices with an advance: balance, CSV columns', () => {
  const i = inv({ amount: 300, amountPaid: 75, number: 'BK-1', currency: 'USD' });
  assert.equal(C.balanceDue(i), 225);
  assert.equal(C.balanceDue(inv({ amount: 100, amountPaid: 150 })), 0);
  assert.equal(C.balanceDue(inv({ amount: 99.99 })), 99.99);
  const line = C.toCSV([i], 3, TODAY).split('\r\n')[1];
  assert.match(line, /,300\.00,75\.00,225\.00,USD,/);
  assert.equal(C.rowToInvoice({ id: 'x', amount: '300', amount_paid: '75.00', booking_id: 'b1', due_date: TODAY }, []).amountPaid, 75);
});
