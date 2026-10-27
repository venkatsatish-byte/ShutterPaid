// ShutterPaid core logic: pure functions with no DOM access, shared by the app and the tests.
// Loaded as a plain <script> in the browser (window.SPCore) and with require() in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SPCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 24 * 60 * 60 * 1000;

  // ---------- Dates (ISO yyyy-mm-dd, local calendar days) ----------
  function toISO(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function todayISO(now) {
    return toISO(now || new Date());
  }

  function parseISO(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(iso, n) {
    const d = parseISO(iso);
    d.setDate(d.getDate() + n);
    return toISO(d);
  }

  // Whole calendar days from `fromISO` to `toISO`. Rounding absorbs daylight-saving shifts.
  function daysBetween(fromISO, toISOStr) {
    return Math.round((parseISO(toISOStr) - parseISO(fromISO)) / DAY);
  }

  function daysUntil(iso, today) {
    return daysBetween(today || todayISO(), iso);
  }

  // ---------- Invoice status ----------
  function statusOf(inv, soonDays, today) {
    if (inv.paid) return 'paid';
    const n = daysUntil(inv.dueDate, today);
    if (n < 0) return 'overdue';
    if (n <= Number(soonDays)) return 'soon';
    return 'open';
  }

  function relativeDue(inv, today, formatDate) {
    if (inv.paid) return 'Paid ' + (formatDate ? formatDate(inv.paidDate) : inv.paidDate || '');
    const n = daysUntil(inv.dueDate, today);
    if (n === 0) return 'Due today';
    if (n === 1) return 'Due tomorrow';
    if (n > 1) return 'Due in ' + n + ' days';
    if (n === -1) return 'Due yesterday';
    return 'Overdue by ' + Math.abs(n) + ' days';
  }

  // Failed or still-sending automatic emails don't count as a reminder the client received.
  function isDelivered(r) {
    return !r.status || r.status === 'sent';
  }

  function suggestedTone(inv, today) {
    const n = daysUntil(inv.dueDate, today);
    const sent = (inv.reminders || []).filter(isDelivered).length;
    if (n < -21 && sent >= 2) return 'final';
    if (n < -7 || (n < 0 && sent >= 1)) return 'firm';
    return 'friendly';
  }

  // ---------- IDs ----------
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function isUuid(id) {
    return typeof id === 'string' && UUID_RE.test(id);
  }

  function uuid() {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  // Older versions used short random ids. Cloud rows need UUIDs, so upgrade them once, in place.
  // Returns true if anything changed.
  function normalizeInvoice(inv) {
    let changed = false;
    if (!isUuid(inv.id)) { inv.id = uuid(); changed = true; }
    if (!Array.isArray(inv.reminders)) { inv.reminders = []; changed = true; }
    inv.reminders.forEach((r) => {
      if (!isUuid(r.id)) { r.id = uuid(); changed = true; }
    });
    return changed;
  }

  // Two invoices with the same fingerprint are treated as the same invoice when uploading.
  function fingerprint(inv) {
    return [
      String(inv.number || '').trim().toLowerCase(),
      String(inv.clientName || '').trim().toLowerCase(),
      Number(inv.amount || 0).toFixed(2),
      inv.dueDate || ''
    ].join('|');
  }

  // Work out which local (device-only) invoices to add to the account without creating duplicates.
  // An invoice is skipped if the account already has the same id or the same fingerprint.
  function planUpload(localInvoices, remoteInvoices) {
    const ids = new Set(remoteInvoices.map((i) => i.id));
    const prints = new Set(remoteInvoices.map(fingerprint));
    const upload = [];
    const skipped = [];
    localInvoices.forEach((inv) => {
      const p = fingerprint(inv);
      if (ids.has(inv.id) || prints.has(p)) skipped.push(inv);
      else { upload.push(inv); prints.add(p); ids.add(inv.id); }
    });
    return { upload, skipped };
  }

  // Settings values can be arrays (the reminder schedule), so compare by value.
  function same(a, b) {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
  }

  // Fill blank account settings from this device's settings; never overwrite what the account has.
  function mergeSettingsForUpload(local, remote, defaults) {
    const out = Object.assign({}, defaults, remote);
    let changed = false;
    Object.keys(defaults).forEach((k) => {
      const r = out[k];
      const l = local[k];
      const remoteBlank = r === undefined || r === null || r === '';
      const localBlank = l === undefined || l === null || l === '';
      // Take the device value if the account has nothing, or still has the default and the device doesn't.
      if (!localBlank && (remoteBlank || (same(r, defaults[k]) && !same(l, defaults[k])))) {
        out[k] = l;
        changed = true;
      }
    });
    return { settings: out, changed };
  }

  function hasLocalData(data, defaults) {
    if (data.invoices && data.invoices.length) return true;
    return Object.keys(defaults).some((k) => k !== 'timeZone' && data.settings && !same(data.settings[k], defaults[k]) && data.settings[k] !== '');
  }

  // ---------- Row mapping (app objects <-> Postgres rows) ----------
  function invoiceToRow(inv, userId) {
    return {
      id: inv.id,
      user_id: userId,
      client_name: inv.clientName || '',
      client_email: inv.clientEmail || '',
      shoot_type: inv.shootType || 'Other',
      number: inv.number || '',
      amount: Number(inv.amount || 0),
      currency: inv.currency || 'USD',
      shoot_date: inv.shootDate || null,
      due_date: inv.dueDate,
      notes: inv.notes || '',
      paid: !!inv.paid,
      paid_date: inv.paid && inv.paidDate ? inv.paidDate : null,
      auto_remind: !!inv.autoRemind,
      reminder_schedule: inv.reminderSchedule || null
    };
  }

  function rowToInvoice(row, reminders) {
    return {
      id: row.id,
      clientName: row.client_name || '',
      clientEmail: row.client_email || '',
      shootType: row.shoot_type || 'Other',
      number: row.number || '',
      amount: Number(row.amount || 0),
      currency: row.currency || 'USD',
      shootDate: row.shoot_date || '',
      dueDate: row.due_date,
      notes: row.notes || '',
      paid: !!row.paid,
      paidDate: row.paid_date || '',
      createdAt: row.created_at || '',
      autoRemind: !!row.auto_remind,
      reminderSchedule: row.reminder_schedule || null,
      remindersStoppedAt: row.reminders_stopped_at || '',
      reminders: reminders || []
    };
  }

  function reminderToRow(invoiceId, r, userId) {
    return {
      id: r.id,
      user_id: userId,
      invoice_id: invoiceId,
      sent_on: r.date,
      sent_at: r.sentAt || r.date + 'T12:00:00Z',
      tone: r.tone,
      channel: r.channel
    };
  }

  function rowToReminder(row) {
    const r = { id: row.id, date: row.sent_on, tone: row.tone, channel: row.channel, sentAt: row.sent_at || '' };
    if (row.channel === 'auto') {
      r.status = row.status;
      r.scheduledFor = row.scheduled_for;
      r.stepOffset = row.step_offset;
      if (row.error) r.error = row.error;
    }
    return r;
  }

  // Explicit column lists: the browser isn't allowed to read server-only columns.
  const INVOICE_COLUMNS = 'id,user_id,client_name,client_email,shoot_type,number,amount,currency,shoot_date,due_date,' +
    'notes,paid,paid_date,created_at,updated_at,auto_remind,reminder_schedule,reminders_stopped_at';
  const REMINDER_COLUMNS = 'id,invoice_id,sent_on,sent_at,tone,channel,status,scheduled_for,step_offset,error';

  const SETTINGS_COLUMNS = {
    ownerName: 'owner_name',
    businessName: 'business_name',
    currency: 'currency',
    soonDays: 'soon_days',
    paymentLink: 'payment_link',
    signature: 'signature',
    timeZone: 'time_zone',
    reminderSchedule: 'reminder_schedule',
    sendHour: 'send_hour',
    replyTo: 'reply_to'
  };

  function settingsToRow(settings, userId) {
    const row = { id: userId };
    Object.keys(SETTINGS_COLUMNS).forEach((k) => {
      if (settings[k] !== undefined) row[SETTINGS_COLUMNS[k]] = k === 'soonDays' || k === 'sendHour' ? Number(settings[k]) || 0 : settings[k];
    });
    return row;
  }

  function rowToSettings(row) {
    const out = {};
    Object.keys(SETTINGS_COLUMNS).forEach((k) => {
      const v = row[SETTINGS_COLUMNS[k]];
      if (v !== undefined && v !== null) out[k] = v;
    });
    return out;
  }

  // Group reminder_log rows onto their invoices, oldest first.
  function assemble(invoiceRows, reminderRows) {
    const byInvoice = {};
    reminderRows.forEach((r) => {
      (byInvoice[r.invoice_id] = byInvoice[r.invoice_id] || []).push(rowToReminder(r));
    });
    return invoiceRows.map((row) => {
      const rem = (byInvoice[row.id] || []).sort((a, b) => (a.sentAt || a.date).localeCompare(b.sentAt || b.date));
      return rowToInvoice(row, rem);
    });
  }

  // ---------- Sync ----------
  // Collapse an outbox so each row is written once, with its latest value, at the position of its
  // first write (so an invoice is still created before its reminders). Deleting an invoice drops any
  // queued reminders for it, since the database removes them with the invoice anyway.
  function coalesceOps(ops) {
    const out = [];
    const index = {};
    const deletedInvoices = new Set();
    ops.forEach((op) => {
      const key = op.table + ':' + op.id;
      if (op.table === 'invoices' && op.op === 'delete') deletedInvoices.add(op.id);
      if (op.table === 'invoices' && op.op === 'upsert') deletedInvoices.delete(op.id);
      if (key in index) out[index[key]] = op;
      else { index[key] = out.length; out.push(op); }
    });
    return out.filter((op) => !(op.table === 'reminder_log' && op.row && deletedInvoices.has(op.row.invoice_id)));
  }

  function pendingKeys(ops) {
    const invoices = new Set();
    const reminders = new Set();
    let settings = false;
    ops.forEach((op) => {
      if (op.table === 'invoices') invoices.add(op.id);
      else if (op.table === 'reminder_log') reminders.add(op.id);
      else if (op.table === 'profiles') settings = true;
    });
    return { invoices, reminders, settings };
  }

  // Combine what the server returned with what this device has not uploaded yet.
  // Server wins for everything except rows with pending local changes.
  function mergeRemote(localInvoices, remoteInvoices, pending) {
    const localById = {};
    localInvoices.forEach((i) => { localById[i.id] = i; });
    const out = [];
    const seen = new Set();
    remoteInvoices.forEach((r) => {
      seen.add(r.id);
      const local = localById[r.id];
      if (local && pending.invoices.has(r.id)) { out.push(local); return; }
      const extra = local ? (local.reminders || []).filter((x) => pending.reminders.has(x.id) && !r.reminders.some((y) => y.id === x.id)) : [];
      out.push(extra.length ? Object.assign({}, r, { reminders: r.reminders.concat(extra) }) : r);
    });
    localInvoices.forEach((i) => {
      if (!seen.has(i.id) && pending.invoices.has(i.id)) out.push(i);
    });
    return out;
  }

  // Postgres/PostgREST errors carry a code; a missing code means the request never reached the
  // server (offline, DNS, CORS). PGRST3xx are auth/JWT problems that clear after a token refresh.
  function isTransientError(err) {
    if (!err) return false;
    if (!err.code) return true;
    return /^PGRST3/.test(err.code) || err.code === '57014' || err.code === '503';
  }

  return {
    DAY,
    toISO, todayISO, parseISO, addDays, daysBetween, daysUntil,
    statusOf, relativeDue, suggestedTone, isDelivered,
    isUuid, uuid, normalizeInvoice, fingerprint, planUpload, mergeSettingsForUpload, hasLocalData,
    invoiceToRow, rowToInvoice, reminderToRow, rowToReminder, settingsToRow, rowToSettings, assemble,
    INVOICE_COLUMNS, REMINDER_COLUMNS,
    coalesceOps, pendingKeys, mergeRemote, isTransientError
  };
});
