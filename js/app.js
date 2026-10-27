// ShutterPaid app logic.
// Signed out, all data lives in localStorage on this device (local-only mode).
// Signed in, data is cached in localStorage per account and synced to Supabase by js/cloud.js.
(function () {
  'use strict';

  const Core = window.SPCore;
  const Cloud = window.SPCloud;
  const Sched = window.SPSchedule;
  const LOCAL_KEY = 'shutterpaid:data:v1';

  const defaultSettings = {
    ownerName: '',
    businessName: '',
    currency: 'USD',
    soonDays: 3,
    paymentLink: '',
    signature: '',
    timeZone: deviceTimeZone(),
    reminderSchedule: Sched.DEFAULT_SCHEDULE.map((x) => Object.assign({}, x)),
    sendHour: Sched.DEFAULT_SEND_HOUR,
    replyTo: ''
  };

  function deviceTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (e) {
      return 'UTC';
    }
  }

  // ---------- Storage ----------
  // The account cache key, or the device-only key when signed out.
  function storeKey() {
    const u = Cloud.user();
    return u ? 'shutterpaid:cache:' + u.id : LOCAL_KEY;
  }

  function load(key) {
    let data = null;
    try {
      const raw = localStorage.getItem(key);
      if (raw) data = JSON.parse(raw);
    } catch (e) {
      console.warn('Could not read saved data', e);
    }
    const out = {
      invoices: data && Array.isArray(data.invoices) ? data.invoices : [],
      settings: Object.assign({}, defaultSettings, data && data.settings),
      plan: data && data.plan ? data.plan : null
    };
    // Upgrade ids from older versions to UUIDs so they can be synced without duplicates.
    const changed = out.invoices.map(Core.normalizeInvoice).some(Boolean);
    if (changed) write(key, out);
    return out;
  }

  function write(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
      return true;
    } catch (e) {
      toast('Could not save. Is storage full or disabled?');
      return false;
    }
  }

  function save() {
    write(storeKey(), state);
  }

  const state = load(storeKey());

  function useStore() {
    const data = load(storeKey());
    state.invoices = data.invoices;
    state.settings = data.settings;
    state.plan = data.plan;
  }

  // ---------- Plans ----------
  // Display prices; the real prices live in Stripe (STRIPE_PRICE_MONTHLY / _YEARLY). Keep in sync.
  const PRICES = { month: '$9', year: '$90' };
  const LIMIT = Core.FREE_ACTIVE_LIMIT;

  // Limits apply to accounts. Local-only mode (no account) works as before.
  function onFreePlan() {
    return !!userId() && !Core.isPro(state.plan);
  }

  function isPro() {
    return !!userId() && Core.isPro(state.plan);
  }

  function roomLeft() {
    return onFreePlan() ? LIMIT - Core.activeCount(state.invoices) : Infinity;
  }

  // ---------- Changes (local cache first, then queued for sync) ----------
  function userId() {
    const u = Cloud.user();
    return u ? u.id : null;
  }

  function queueInvoice(inv) {
    if (userId()) Cloud.enqueue({ table: 'invoices', op: 'upsert', id: inv.id, row: Core.invoiceToRow(inv, userId()) });
  }

  function queueInvoiceDelete(id) {
    if (userId()) Cloud.enqueue({ table: 'invoices', op: 'delete', id: id });
  }

  function queueReminder(inv, r) {
    if (userId()) Cloud.enqueue({ table: 'reminder_log', op: 'upsert', id: r.id, row: Core.reminderToRow(inv.id, r, userId()) });
  }

  function queueSettings() {
    if (userId()) Cloud.enqueue({ table: 'profiles', op: 'upsert', id: userId(), row: Core.settingsToRow(state.settings, userId()) });
  }

  function putInvoice(inv) {
    if (!state.invoices.includes(inv)) state.invoices.push(inv);
    save();
    queueInvoice(inv);
  }

  function deleteInvoice(inv) {
    state.invoices = state.invoices.filter((i) => i !== inv);
    save();
    queueInvoiceDelete(inv.id);
  }

  function replaceAllInvoices(next) {
    state.invoices.forEach((i) => queueInvoiceDelete(i.id));
    state.invoices = next;
    save();
    next.forEach((inv) => {
      queueInvoice(inv);
      inv.reminders.forEach((r) => queueReminder(inv, r));
    });
  }

  // ---------- Helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const uid = Core.uuid;
  const todayISO = () => Core.todayISO();
  const parseISO = Core.parseISO;
  const addDays = Core.addDays;
  const daysUntil = (iso) => Core.daysUntil(iso);

  function money(amount, currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency || state.settings.currency,
        minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
        maximumFractionDigits: amount % 1 === 0 ? 0 : 2
      }).format(amount || 0);
    } catch (e) {
      return (currency || '') + ' ' + Number(amount || 0).toFixed(2);
    }
  }

  function prettyDate(iso) {
    if (!iso) return '';
    return parseISO(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function relativeDue(inv) {
    return Core.relativeDue(inv, todayISO(), prettyDate);
  }

  function statusOf(inv) {
    return Core.statusOf(inv, state.settings.soonDays, todayISO());
  }

  const BADGES = {
    paid: '<span class="badge badge-ok">Paid</span>',
    overdue: '<span class="badge badge-danger">Overdue</span>',
    soon: '<span class="badge badge-warn">Due soon</span>',
    open: '<span class="badge badge-muted">Open</span>'
  };

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function nextInvoiceNumber() {
    const nums = state.invoices
      .map((i) => parseInt(String(i.number || '').replace(/\D/g, ''), 10))
      .filter((n) => !isNaN(n));
    return 'INV-' + (nums.length ? Math.max.apply(null, nums) + 1 : 1001);
  }

  // ---------- Rendering ----------
  function invoiceItem(inv, opts) {
    const st = statusOf(inv);
    const delivered = (inv.reminders || []).filter(Core.isDelivered);
    const last = delivered.length ? delivered[delivered.length - 1] : null;
    const meta = [
      esc(inv.shootType),
      inv.number ? esc(inv.number) : '',
      relativeDue(inv),
      last ? 'Last reminded ' + prettyDate(last.date) : ''
    ].filter(Boolean).join(' · ');

    const actions = [];
    if (!inv.paid) {
      actions.push('<button class="btn btn-sm btn-primary" data-act="remind" data-id="' + esc(inv.id) + '">✉️ Remind</button>');
      actions.push('<button class="btn btn-sm" data-act="paid" data-id="' + esc(inv.id) + '">✅ Mark paid</button>');
    } else {
      actions.push('<button class="btn btn-sm" data-act="unpaid" data-id="' + esc(inv.id) + '">↩️ Mark unpaid</button>');
    }
    if (!opts || !opts.compact) {
      actions.push('<button class="btn btn-sm btn-ghost" data-act="edit" data-id="' + esc(inv.id) + '">Edit</button>');
      actions.push('<button class="btn btn-sm btn-ghost btn-danger" data-act="delete" data-id="' + esc(inv.id) + '">Delete</button>');
    }

    const auto = autoStatus(inv);
    const history = (!opts || !opts.compact) && inv.reminders && inv.reminders.length ? reminderHistory(inv) : '';

    return '<li class="item">' +
      '<div><div class="item-title">' + esc(inv.clientName) + '</div><div class="item-meta">' + meta + '</div>' +
      (auto ? '<div class="item-auto ' + auto.cls + '">' + esc(auto.text) + '</div>' : '') + '</div>' +
      '<div class="item-amount">' + BADGES[st] + '<div>' + money(inv.amount, inv.currency) + '</div></div>' +
      '<div class="item-actions">' + actions.join('') + '</div>' +
      history +
      '</li>';
  }

  // ---------- Automatic reminders (display) ----------
  function localToday() {
    return Sched.localNow(new Date(), state.settings.timeZone).date;
  }

  function sentAutoKeys(inv) {
    return new Set((inv.reminders || [])
      .filter((r) => r.channel === 'auto' && r.status === 'sent')
      .map((r) => r.scheduledFor + '|' + r.stepOffset));
  }

  function autoStatus(inv) {
    if (!inv.autoRemind || !userId()) return null;
    if (inv.paid) return null;
    if (!isPro()) return { cls: 'warn', text: '⏸ Auto reminders paused: they need ShutterPaid Pro' };
    if (inv.remindersStoppedAt) return { cls: 'warn', text: '⏸ The client asked to stop automatic reminders for this invoice' };
    if (!inv.clientEmail) return { cls: 'warn', text: '⚠️ Add the client\'s email to send automatic reminders' };
    if (!state.settings.businessName && !state.settings.ownerName) return { cls: 'warn', text: '⚠️ Add your business name in Settings to send automatic reminders' };
    const next = Sched.nextStep(inv, Sched.scheduleFor(inv, state.settings.reminderSchedule), localToday(), sentAutoKeys(inv));
    if (!next) return { cls: '', text: '🤖 Auto reminders on · all scheduled reminders sent' };
    const when = next.date === localToday() ? 'today' : prettyDate(next.date);
    return { cls: 'on', text: '🤖 Next auto reminder: ' + Sched.TONE_LABELS[next.step.tone] + ', ' + when };
  }

  const CHANNEL_LABELS = { email: 'opened in your email app', copy: 'copied', auto: 'sent automatically' };

  function reminderHistory(inv) {
    const items = inv.reminders.slice().reverse().map((r) => {
      let how = CHANNEL_LABELS[r.channel] || r.channel;
      let cls = '';
      if (r.channel === 'auto' && r.status === 'failed') { how = 'automatic send failed'; cls = 'failed'; }
      if (r.channel === 'auto' && r.status === 'sending') how = 'sending…';
      return '<li>' + esc(prettyDate(r.date)) + ' · ' + esc(Sched.TONE_LABELS[r.tone] || r.tone) + ' · <span class="' + cls + '">' + esc(how) + '</span></li>';
    }).join('');
    return '<details class="history"><summary>Reminder history (' + inv.reminders.length + ')</summary><ul>' + items + '</ul></details>';
  }

  // ---------- Schedule editor ----------
  function scheduleRow(step) {
    const when = step.offset < 0 ? 'before' : step.offset > 0 ? 'after' : 'on';
    const tones = Sched.TONES.map((t) => '<option value="' + t + '"' + (t === step.tone ? ' selected' : '') + '>' + esc(Sched.TONE_LABELS[t]) + '</option>').join('');
    const whens = [['before', 'days before due'], ['on', 'on the due date'], ['after', 'days after due']]
      .map((w) => '<option value="' + w[0] + '"' + (w[0] === when ? ' selected' : '') + '>' + w[1] + '</option>').join('');
    return '<div class="sched-row">' +
      '<select data-k="tone" aria-label="Tone">' + tones + '</select>' +
      '<input data-k="days" type="number" min="1" max="365" inputmode="numeric" aria-label="Days" value="' + Math.abs(step.offset) + '"' + (when === 'on' ? ' disabled' : '') + '>' +
      '<select data-k="when" aria-label="When">' + whens + '</select>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-k="remove" aria-label="Remove this step">✕</button>' +
      '</div>';
  }

  function renderScheduleEditor(el, steps) {
    el.innerHTML = steps.map(scheduleRow).join('') +
      '<div><button type="button" class="btn btn-sm" data-k="add">+ Add a reminder</button></div>';
  }

  function readScheduleEditor(el) {
    const steps = $$('.sched-row', el).map((row) => {
      const when = $('[data-k=when]', row).value;
      const days = Math.max(1, Math.round(Number($('[data-k=days]', row).value) || 1));
      return { tone: $('[data-k=tone]', row).value, offset: when === 'on' ? 0 : when === 'before' ? -days : days };
    });
    return Sched.normalizeSchedule(steps, []);
  }

  // One handler for every schedule editor on the page.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.schedule-editor [data-k]');
    if (!btn || btn.tagName !== 'BUTTON') return;
    const el = btn.closest('.schedule-editor');
    const steps = readScheduleEditor(el);
    if (btn.dataset.k === 'remove') {
      const row = btn.closest('.sched-row');
      const i = $$('.sched-row', el).indexOf(row);
      const all = $$('.sched-row', el);
      row.remove();
      const focus = all[i + 1] || all[i - 1];
      (focus ? $('[data-k=tone]', focus) : $('[data-k=add]', el)).focus();
      return;
    }
    if (steps.length >= Sched.MAX_STEPS) return toast('Up to ' + Sched.MAX_STEPS + ' reminders per schedule');
    const last = steps.length ? steps[steps.length - 1].offset : -1;
    steps.push({ offset: Math.min(365, last + 7), tone: last >= 7 ? 'final' : 'firm' });
    renderScheduleEditor(el, steps);
    const rows = $$('.sched-row', el);
    $('[data-k=tone]', rows[rows.length - 1]).focus();
  });

  document.addEventListener('change', (e) => {
    if (e.target.matches('.schedule-editor [data-k=when]')) {
      const days = $('[data-k=days]', e.target.closest('.sched-row'));
      days.disabled = e.target.value === 'on';
      if (e.target.value !== 'on' && Number(days.value) < 1) days.value = 3;
    }
  });

  function renderDashboard() {
    const s = state.settings;
    const hour = new Date().getHours();
    const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    $('#greeting').textContent = hello + (s.ownerName ? ', ' + s.ownerName.split(' ')[0] : '') + ' 👋';

    // Totals only include invoices in the default currency.
    const cur = s.currency;
    const same = state.invoices.filter((i) => (i.currency || cur) === cur);
    const unpaid = same.filter((i) => !i.paid);
    const sum = (arr) => arr.reduce((t, i) => t + Number(i.amount || 0), 0);
    const monthPrefix = todayISO().slice(0, 7);

    $('#statOutstanding').textContent = money(sum(unpaid), cur);
    $('#statOverdue').textContent = money(sum(unpaid.filter((i) => daysUntil(i.dueDate) < 0)), cur);
    $('#statSoon').textContent = money(sum(unpaid.filter((i) => {
      const n = daysUntil(i.dueDate);
      return n >= 0 && n <= 7;
    })), cur);
    $('#statPaid').textContent = money(sum(same.filter((i) => i.paid && (i.paidDate || '').startsWith(monthPrefix))), cur);

    const due = state.invoices
      .filter((i) => ['overdue', 'soon'].includes(statusOf(i)))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    $('#reminderList').innerHTML = due.length
      ? due.map((i) => invoiceItem(i, { compact: true })).join('')
      : '<li class="empty">' + (state.invoices.length
        ? '🎉 All caught up! No reminders needed right now.'
        : 'No invoices yet. Tap <strong>+ New invoice</strong> to add your first shoot, or load sample data in Settings.') + '</li>';
  }

  let currentFilter = 'all';
  function renderInvoices() {
    const q = $('#searchInput').value.trim().toLowerCase();
    const list = state.invoices
      .filter((i) => {
        const st = statusOf(i);
        if (currentFilter === 'paid') return st === 'paid';
        if (currentFilter === 'unpaid') return st !== 'paid';
        if (currentFilter === 'overdue') return st === 'overdue';
        return true;
      })
      .filter((i) => !q || [i.clientName, i.shootType, i.number, i.clientEmail].join(' ').toLowerCase().includes(q))
      .sort((a, b) => (a.paid - b.paid) || a.dueDate.localeCompare(b.dueDate));

    $('#invoiceList').innerHTML = list.length
      ? list.map((i) => invoiceItem(i)).join('')
      : '<li class="empty">No invoices match.</li>';
  }

  function renderSettings() {
    const f = $('#settingsForm');
    Object.keys(defaultSettings).forEach((k) => {
      if (f.elements[k]) f.elements[k].value = state.settings[k];
    });
    renderAutoSettings();
  }

  function renderAutoSettings() {
    const panel = $('#autoPanel');
    panel.hidden = !Cloud.enabled;
    if (!Cloud.enabled) return;
    const a = $('#autoForm');
    const hours = $('#sendHourSelect');
    if (!hours.options.length) {
      for (let h = 5; h <= 21; h++) {
        const label = new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        hours.add(new Option(label, String(h)));
      }
      const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
      $('#tzList').innerHTML = zones.map((z) => '<option value="' + esc(z) + '">').join('');
    }
    hours.value = String(state.settings.sendHour);
    a.elements.timeZone.value = state.settings.timeZone || deviceTimeZone();
    a.elements.replyTo.value = state.settings.replyTo || '';
    renderScheduleEditor($('#defaultSchedule'), Sched.normalizeSchedule(state.settings.reminderSchedule));
    const signedIn = !!userId();
    $('#autoPanelNote').textContent = signedIn
      ? 'ShutterPaid emails your clients for you on this schedule. Turn it on for each invoice. Reminders stop as soon as an invoice is marked paid.'
      : 'Sign in to have ShutterPaid email your clients for you on a schedule. Without an account you can still send each reminder yourself.';
  }

  $('#autoForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const steps = readScheduleEditor($('#defaultSchedule'));
    if (!steps.length) return toast('Add at least one reminder to the schedule');
    const tz = f.timeZone.value.trim();
    if (!Sched.validTimeZone(tz)) {
      f.timeZone.focus();
      return toast('Pick a time zone from the list, like Europe/London');
    }
    state.settings.reminderSchedule = steps;
    state.settings.sendHour = Number(f.sendHour.value);
    state.settings.timeZone = tz;
    state.settings.replyTo = f.replyTo.value.trim();
    save();
    queueSettings();
    renderAll();
    renderAutoSettings();
    toast('Reminder settings saved');
  });

  function renderAll() {
    renderDashboard();
    renderInvoices();
    renderAccount();
    renderPlan();
  }

  // ---------- Account & sync status ----------
  const SYNC_LABELS = {
    'signed-out': 'Sign in',
    syncing: 'Syncing…',
    synced: 'Synced',
    offline: 'Offline',
    error: 'Sync issue'
  };
  let syncInfo = Cloud.info();

  function syncDetail(i) {
    const n = i.pending;
    const queued = n ? n + ' change' + (n === 1 ? '' : 's') + ' waiting to upload. ' : '';
    if (i.status === 'offline') return 'You\'re offline. ' + queued + 'Changes are saved on this device and will sync when you\'re back online.';
    if (i.status === 'error') return queued + 'We couldn\'t reach your account. We\'ll keep trying.';
    if (i.status === 'syncing') return queued + 'Syncing with your account…';
    if (i.lastSynced) return 'All changes saved to your account. Last synced ' + i.lastSynced.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + '.';
    return 'All changes saved to your account.';
  }

  function renderAccount() {
    if (!Cloud.enabled) return;
    const i = syncInfo;
    const signedIn = !!i.user;
    const btn = $('#accountBtn');
    btn.hidden = false;
    btn.dataset.status = i.status;
    $('#accountBtnLabel').textContent = SYNC_LABELS[i.status] || 'Account';
    btn.setAttribute('aria-label', signedIn ? 'Account and sync: ' + (SYNC_LABELS[i.status] || '') : 'Sign in to sync');

    $('#accountPanel').hidden = false;
    $('#accountSignedOut').hidden = signedIn;
    $('#accountSignedIn').hidden = !signedIn;
    if (signedIn) {
      $('#accountEmail').textContent = i.user.email || 'your account';
      $('#syncDetail').textContent = syncDetail(i);
    }
    $('#backupNote').textContent = signedIn
      ? 'Your invoices sync to your account. You can still export a backup at any time.'
      : 'Your data is stored only on this device. Export a backup to keep it safe or move it to another device.';
    $('#resetBtn').textContent = signedIn ? 'Erase all account data' : 'Erase all data';
  }

  // ---------- Navigation ----------
  let currentView = 'dashboard';
  function showView(name) {
    currentView = name;
    $$('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
    $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }

  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  $('#filterBar').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    currentFilter = chip.dataset.filter;
    $$('#filterBar .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderInvoices();
  });
  $('#searchInput').addEventListener('input', renderInvoices);

  // ---------- Invoice dialog ----------
  const invoiceDialog = $('#invoiceDialog');
  const invoiceForm = $('#invoiceForm');

  function openInvoiceDialog(inv) {
    if (!inv && roomLeft() <= 0) return openUpgrade('limit');
    invoiceForm.reset();
    const f = invoiceForm.elements;
    $('#invoiceDialogTitle').textContent = inv ? 'Edit invoice' : 'New invoice';
    f.id.value = inv ? inv.id : '';
    f.clientName.value = inv ? inv.clientName : '';
    f.clientEmail.value = inv ? inv.clientEmail || '' : '';
    f.shootType.value = inv ? inv.shootType : 'Wedding';
    f.number.value = inv ? inv.number || '' : nextInvoiceNumber();
    f.amount.value = inv ? inv.amount : '';
    f.currency.value = inv ? inv.currency || state.settings.currency : state.settings.currency;
    f.shootDate.value = inv ? inv.shootDate || '' : todayISO();
    f.dueDate.value = inv ? inv.dueDate : addDays(todayISO(), 14);
    f.notes.value = inv ? inv.notes || '' : '';
    renderInvoiceAuto(inv);
    invoiceDialog.showModal();
  }

  function renderInvoiceAuto(inv) {
    const box = $('#invoiceAuto');
    box.hidden = !Cloud.enabled;
    if (!Cloud.enabled) return;
    const signedIn = !!userId();
    const input = $('#autoRemindInput');
    const proOnly = signedIn && !isPro();
    input.checked = signedIn && !!(inv ? inv.autoRemind : false);
    // Free accounts can switch auto-reminders off but not on.
    input.disabled = !signedIn || !!(inv && inv.remindersStoppedAt) || (proOnly && !input.checked);
    $('#autoUpsell').hidden = !proOnly;
    const custom = inv && inv.reminderSchedule;
    $('#customScheduleInput').checked = !!custom;
    $('#customScheduleDetails').open = !!custom;
    renderScheduleEditor($('#invoiceSchedule'), Sched.normalizeSchedule(custom || state.settings.reminderSchedule));
    updateInvoiceAutoHint(inv);
  }

  function updateInvoiceAutoHint(inv) {
    const signedIn = !!userId();
    const custom = $('#customScheduleInput').checked;
    $('#invoiceSchedule').setAttribute('aria-disabled', String(!custom));
    $$('#invoiceSchedule input, #invoiceSchedule select, #invoiceSchedule button').forEach((el) => {
      el.disabled = !custom || (el.dataset.k === 'days' && $('[data-k=when]', el.closest('.sched-row')).value === 'on');
    });
    let hint;
    if (!signedIn) hint = 'Sign in to have ShutterPaid send reminders for you.';
    else if (inv && inv.remindersStoppedAt) hint = 'The client asked to stop automatic reminders for this invoice. You can still send reminders yourself.';
    else hint = 'Schedule: ' + Sched.normalizeSchedule(custom ? readScheduleEditor($('#invoiceSchedule')) : state.settings.reminderSchedule).map(Sched.describeStep).join(', ') + '.';
    $('#autoRemindHint').textContent = hint;
  }

  $('#customScheduleInput').addEventListener('change', () => updateInvoiceAutoHint(state.invoices.find((i) => i.id === invoiceForm.elements.id.value)));
  $('#invoiceSchedule').addEventListener('change', () => updateInvoiceAutoHint(state.invoices.find((i) => i.id === invoiceForm.elements.id.value)));

  invoiceForm.addEventListener('submit', (e) => {
    if (!e.submitter || e.submitter.value !== 'save') return;
    const f = invoiceForm.elements;
    const data = {
      clientName: f.clientName.value.trim(),
      clientEmail: f.clientEmail.value.trim(),
      shootType: f.shootType.value,
      number: f.number.value.trim(),
      amount: Number(f.amount.value),
      currency: f.currency.value,
      shootDate: f.shootDate.value,
      dueDate: f.dueDate.value,
      notes: f.notes.value.trim()
    };
    const existing = state.invoices.find((i) => i.id === f.id.value);
    if (Cloud.enabled && userId()) {
      data.autoRemind = $('#autoRemindInput').checked && (isPro() || !!(existing && existing.autoRemind));
      const custom = $('#customScheduleInput').checked ? readScheduleEditor($('#invoiceSchedule')) : [];
      data.reminderSchedule = custom.length ? custom : null;
      if (data.autoRemind && !data.clientEmail) {
        e.preventDefault();
        toast('Add the client\'s email to send automatic reminders');
        f.clientEmail.focus();
        return;
      }
    }
    if (existing) {
      Object.assign(existing, data);
      putInvoice(existing);
      toast('Invoice updated');
    } else {
      putInvoice(Object.assign({ id: uid(), paid: false, paidDate: '', reminders: [], createdAt: todayISO() }, data));
      toast('Invoice added 📸');
    }
    if (data.autoRemind && !state.settings.businessName && !state.settings.ownerName) {
      setTimeout(() => toast('Add your business name in Settings so reminders can go out'), 2500);
    }
    renderAll();
  });

  $$('[data-action="new-invoice"]').forEach((b) => b.addEventListener('click', () => openInvoiceDialog(null)));

  // ---------- Invoice actions ----------
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const inv = state.invoices.find((i) => i.id === btn.dataset.id);
    if (!inv) return;
    switch (btn.dataset.act) {
      case 'remind':
        openReminder(inv);
        break;
      case 'paid':
        inv.paid = true;
        inv.paidDate = todayISO();
        putInvoice(inv); renderAll();
        freedSlot();
        toast('Marked paid — nice work! 💸');
        break;
      case 'unpaid':
        if (roomLeft() <= 0) return openUpgrade('limit');
        inv.paid = false;
        inv.paidDate = '';
        putInvoice(inv); renderAll();
        break;
      case 'edit':
        openInvoiceDialog(inv);
        break;
      case 'delete':
        if (confirm('Delete the invoice for ' + inv.clientName + '?')) {
          deleteInvoice(inv); renderAll();
          freedSlot();
          toast('Invoice deleted');
        }
        break;
    }
  });

  // ---------- Reminders ----------
  const reminderDialog = $('#reminderDialog');
  let reminderInvoice = null;
  let reminderTone = 'friendly';

  function suggestedTone(inv) {
    return Core.suggestedTone(inv, todayISO());
  }

  function buildReminder(inv, tone) {
    return Sched.buildReminder(inv, state.settings, tone, todayISO());
  }

  function fillReminder() {
    const r = buildReminder(reminderInvoice, reminderTone);
    $('#reminderSubject').value = r.subject;
    $('#reminderBody').value = r.body;
    $$('#tonePicker .chip').forEach((c) => c.classList.toggle('active', c.dataset.tone === reminderTone));
  }

  function openReminder(inv) {
    reminderInvoice = inv;
    reminderTone = suggestedTone(inv);
    fillReminder();
    reminderDialog.showModal();
  }

  function logReminder(channel) {
    const entry = { id: uid(), date: todayISO(), tone: reminderTone, channel: channel, sentAt: new Date().toISOString() };
    reminderInvoice.reminders = reminderInvoice.reminders || [];
    reminderInvoice.reminders.push(entry);
    save();
    queueReminder(reminderInvoice, entry);
    renderAll();
  }

  $('#tonePicker').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-tone]');
    if (!chip) return;
    reminderTone = chip.dataset.tone;
    fillReminder();
  });

  $('#reminderCancel').addEventListener('click', () => reminderDialog.close());

  $('#reminderSend').addEventListener('click', () => {
    const to = reminderInvoice.clientEmail || '';
    const href = 'mailto:' + encodeURIComponent(to) +
      '?subject=' + encodeURIComponent($('#reminderSubject').value) +
      '&body=' + encodeURIComponent($('#reminderBody').value);
    window.location.href = href;
    logReminder('email');
    reminderDialog.close();
    toast('Reminder logged ✉️');
  });

  $('#reminderCopy').addEventListener('click', async () => {
    const text = $('#reminderSubject').value + '\n\n' + $('#reminderBody').value;
    try {
      await navigator.clipboard.writeText(text);
      logReminder('copy');
      toast('Copied. Paste it into WhatsApp, SMS or email.');
    } catch (err) {
      $('#reminderBody').select();
      toast('Select the text and copy it manually');
    }
  });

  // ---------- Settings ----------
  $('#settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    Object.keys(defaultSettings).forEach((k) => {
      if (!f[k]) return;
      state.settings[k] = k === 'soonDays' ? Math.min(30, Math.max(0, Number(f[k].value) || 0)) : f[k].value.trim();
    });
    if (!state.settings.timeZone) state.settings.timeZone = deviceTimeZone();
    save();
    queueSettings();
    renderAll();
    toast('Settings saved');
  });

  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'shutterpaid-backup-' + todayISO() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('#importInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.invoices)) throw new Error('Missing invoices');
      if (onFreePlan() && Core.activeCount(data.invoices) > LIMIT) {
        openUpgrade('import');
        return;
      }
      if (!confirm('Replace your current data with this backup?')) return;
      // Fresh ids, so a backup restored into two accounts never collides.
      const next = data.invoices.map((inv) => {
        const copy = Object.assign({}, inv, { id: uid() });
        copy.reminders = (inv.reminders || []).map((r) => Object.assign({}, r, { id: uid() }));
        return copy;
      });
      replaceAllInvoices(next);
      state.settings = Object.assign({}, defaultSettings, data.settings);
      save(); queueSettings();
      renderAll(); renderSettings();
      toast('Backup restored');
    } catch (err) {
      toast('That file doesn\'t look like a ShutterPaid backup');
    } finally {
      e.target.value = '';
    }
  });

  $('#demoBtn').addEventListener('click', () => {
    if (roomLeft() < 4) return openUpgrade('sample');
    if (state.invoices.length && !confirm('Add sample invoices alongside your existing data?')) return;
    const t = todayISO();
    const cur = state.settings.currency;
    const sample = [
      { clientName: 'Priya & Sam', clientEmail: 'priya@example.com', shootType: 'Wedding', amount: 2400, dueDate: addDays(t, -3), shootDate: addDays(t, -30) },
      { clientName: 'Bloom Studio', clientEmail: 'hello@bloom.example', shootType: 'Product', amount: 850, dueDate: addDays(t, 1), shootDate: addDays(t, -10) },
      { clientName: 'Jordan Lee', clientEmail: 'jordan@example.com', shootType: 'Portrait', amount: 320, dueDate: addDays(t, -25), shootDate: addDays(t, -50) },
      { clientName: 'Oak & Pine Realty', clientEmail: 'ops@oakpine.example', shootType: 'Real estate', amount: 600, dueDate: addDays(t, 12), shootDate: addDays(t, -2) },
      { clientName: 'The Garcia Family', clientEmail: 'garcia@example.com', shootType: 'Family', amount: 450, dueDate: addDays(t, -5), shootDate: addDays(t, -20), paid: true, paidDate: addDays(t, -2) }
    ];
    sample.forEach((s) => {
      putInvoice(Object.assign({
        id: uid(), number: nextInvoiceNumber(), currency: cur, notes: '', paid: false, paidDate: '', reminders: [], createdAt: t
      }, s));
    });
    renderAll();
    toast('Sample data loaded');
    showView('dashboard');
  });

  $('#resetBtn').addEventListener('click', () => {
    const msg = userId()
      ? 'This permanently erases all invoices and settings in your account, on every device. Continue?'
      : 'This permanently erases all invoices and settings on this device. Continue?';
    if (!confirm(msg)) return;
    replaceAllInvoices([]);
    state.settings = Object.assign({}, defaultSettings);
    save(); queueSettings();
    renderAll(); renderSettings();
    toast('All data erased');
  });

  // ---------- Sign in / sign out ----------
  const authDialog = $('#authDialog');
  let authEmail = '';

  function authError(err, fallback) {
    console.warn(err);
    const msg = err && err.message ? err.message : '';
    $('#authError').textContent = /rate|seconds/i.test(msg) ? msg : (fallback || 'Something went wrong. Please try again.');
  }

  function openAuth() {
    $('#authError').textContent = '';
    $('#authStepEmail').hidden = false;
    $('#authStepCode').hidden = true;
    authDialog.showModal();
    $('#authEmailInput').focus();
  }

  $('#accountBtn').addEventListener('click', () => {
    if (Cloud.user()) {
      showView('settings');
      $('#accountPanel').scrollIntoView({ block: 'start' });
    } else {
      openAuth();
    }
  });
  $('#openAuthBtn').addEventListener('click', openAuth);
  $('#authClose').addEventListener('click', () => authDialog.close());

  $('#authEmailForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    authEmail = $('#authEmailInput').value.trim();
    if (!authEmail) return;
    const btn = $('#authEmailBtn');
    btn.disabled = true;
    $('#authError').textContent = '';
    try {
      await Cloud.signInWithEmail(authEmail);
      $('#authSentTo').textContent = authEmail;
      $('#authStepEmail').hidden = true;
      $('#authStepCode').hidden = false;
      $('#authCodeInput').value = '';
      $('#authCodeInput').focus();
    } catch (err) {
      authError(err, navigator.onLine === false ? 'You\'re offline. Connect to the internet to sign in.' : 'We couldn\'t send the email. Check the address and try again.');
    } finally {
      btn.disabled = false;
    }
  });

  $('#authCodeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('#authCodeInput').value.replace(/\s/g, '');
    if (!code) return;
    $('#authError').textContent = '';
    try {
      await Cloud.verifyCode(authEmail, code);
      authDialog.close();
    } catch (err) {
      authError(err, 'That code didn\'t work. Check it, or request a new email.');
    }
  });

  $('#authBack').addEventListener('click', () => {
    $('#authStepEmail').hidden = false;
    $('#authStepCode').hidden = true;
    $('#authEmailInput').focus();
  });

  $('#authGoogle').addEventListener('click', async () => {
    try {
      await Cloud.signInWithGoogle(); // navigates away to Google
    } catch (err) {
      authError(err, 'Google sign-in isn\'t available right now.');
    }
  });

  $('#syncNowBtn').addEventListener('click', () => Cloud.sync());

  $('#signOutBtn').addEventListener('click', async () => {
    const u = Cloud.user();
    if (!u) return;
    const pending = Cloud.pendingCount(u.id);
    const msg = pending
      ? pending + ' change' + (pending === 1 ? ' hasn\'t' : 's haven\'t') + ' synced yet. They\'ll stay on this device and upload the next time you sign in. Sign out?'
      : 'Sign out? Your invoices stay safe in your account.';
    if (!confirm(msg)) return;
    await Cloud.signOut();
    // With nothing left to upload, remove the account's copy from this device (it may be shared).
    if (!pending) {
      try { localStorage.removeItem('shutterpaid:cache:' + u.id); } catch (e) { /* ignore */ }
      Cloud.discardLocalCopy(u.id);
    }
    toast('Signed out');
  });

  // ---------- First sign-in: offer to upload device-only data ----------
  const uploadDialog = $('#uploadDialog');

  function offeredKey(id) { return 'shutterpaid:uploaded:' + id; }

  function maybeOfferUpload(u) {
    if (uploadDialog.open) return;
    let device;
    try {
      if (localStorage.getItem(offeredKey(u.id))) return;
      device = load(LOCAL_KEY);
    } catch (e) {
      return;
    }
    if (!Core.hasLocalData(device, defaultSettings)) return;
    const n = device.invoices.length;
    $('#uploadText').textContent = n
      ? 'This device has ' + n + ' invoice' + (n === 1 ? '' : 's') + ' and your settings saved from before you signed in. Add them to your account so they sync everywhere? Invoices already in your account won\'t be duplicated.'
      : 'This device has settings saved from before you signed in. Add them to your account?';
    uploadDialog.showModal();
  }

  $('#uploadSkip').addEventListener('click', () => uploadDialog.close());

  $('#uploadGo').addEventListener('click', async () => {
    const u = Cloud.user();
    if (!u) return uploadDialog.close();
    const btn = $('#uploadGo');
    btn.disabled = true;
    try {
      const device = load(LOCAL_KEY);
      // Upload what's not already queued, and compare against what the account already has.
      const remote = await Cloud.fetchRemote();
      if (remote.profile) state.plan = Core.planFromProfile(remote.profile);
      const known = state.invoices.concat(remote.invoices);
      const plan = Core.planUpload(device.invoices, known);
      // On the Free plan, upload what fits and keep the rest on this device for later.
      const fit = onFreePlan() ? Core.fitToPlan(plan.upload, Core.activeCount(state.invoices), LIMIT) : { fits: plan.upload, left: [] };
      plan.upload = fit.fits;
      plan.upload.forEach((inv) => {
        state.invoices.push(inv);
        queueInvoice(inv);
        inv.reminders.forEach((r) => queueReminder(inv, r));
      });
      const merged = Core.mergeSettingsForUpload(device.settings, remote.settings || state.settings, defaultSettings);
      if (merged.changed) {
        state.settings = merged.settings;
        queueSettings();
      }
      save();
      // Keep the original device data under a different key, just in case. Anything that didn't fit
      // the Free plan stays as device data, and we'll offer it again after an upgrade.
      write(LOCAL_KEY + ':uploaded', device);
      if (fit.left.length) {
        write(LOCAL_KEY, { invoices: fit.left, settings: device.settings });
      } else {
        localStorage.removeItem(LOCAL_KEY);
        localStorage.setItem(offeredKey(u.id), new Date().toISOString());
      }
      uploadDialog.close();
      renderAll();
      const skipped = plan.skipped.length;
      toast('Added ' + plan.upload.length + ' invoice' + (plan.upload.length === 1 ? '' : 's') + (skipped ? ' (' + skipped + ' already in your account)' : '') + ' ☁️');
      if (fit.left.length) setTimeout(() => openUpgrade('upload', fit.left.length), 600);
    } catch (err) {
      console.warn(err);
      toast(navigator.onLine === false ? 'You\'re offline. We\'ll ask again next time.' : 'Upload failed. We\'ll ask again next time.');
      uploadDialog.close();
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Cloud hooks ----------
  function onUser(u) {
    useStore();
    renderAll();
    renderSettings();
    if (u) maybeOfferUpload(u);
    let next = null;
    try { next = sessionStorage.getItem('shutterpaid:afterSignIn'); sessionStorage.removeItem('shutterpaid:afterSignIn'); } catch (e) { /* ignore */ }
    if (u && next === 'upgrade') setTimeout(() => openUpgrade('plan'), 300);
  }

  function onRemote(remote) {
    const wasPro = isPro();
    if (remote.profile) state.plan = Core.planFromProfile(remote.profile);
    if (isPro() && !wasPro) {
      // Just upgraded (or the plan loaded for the first time): send anything held back by the limit,
      // and offer device invoices that didn't fit earlier.
      Cloud.requeueParked();
      if (Cloud.user()) maybeOfferUpload(Cloud.user());
    }
    const pending = Cloud.pending();
    state.invoices = Core.mergeRemote(state.invoices, remote.invoices, pending);
    if (remote.settings && !pending.settings) {
      state.settings = Object.assign({}, defaultSettings, remote.settings);
      if (!remote.settings.timeZone) {
        state.settings.timeZone = deviceTimeZone();
        queueSettings();
      }
    }
    save();
    renderAll();
    // Don't overwrite the settings form while someone is typing in it.
    const editing = $('#settingsForm').contains(document.activeElement) || $('#autoForm').contains(document.activeElement);
    if (currentView === 'settings' && !editing) renderSettings();
  }

  function onStatus(i) {
    syncInfo = i;
    renderAccount();
    if (i.rejected) toast('Some changes couldn\'t be saved to your account.');
    if (i.limit) {
      toast(i.limit === 'PRO_REQUIRED'
        ? 'Automatic reminders need Pro. Your other changes are saved.'
        : 'The Free plan syncs ' + LIMIT + ' active invoices. Extra ones stay on this device until you upgrade.');
    }
  }

  // ---------- Upgrade & billing ----------
  const upgradeDialog = $('#upgradeDialog');
  const UPGRADE_REASONS = {
    limit: 'The Free plan includes ' + LIMIT + ' active (unpaid) invoices. Mark one paid, or upgrade for unlimited invoices.',
    auto: 'Let ShutterPaid email your clients for you, on your schedule, until they pay.',
    sample: 'Sample data adds 4 unpaid invoices, which would go over the Free plan\'s ' + LIMIT + ' active invoices.',
    import: 'This backup has more than ' + LIMIT + ' unpaid invoices, more than the Free plan holds.',
    plan: 'Unlimited invoices and automatic reminders for your photography business.'
  };

  function openUpgrade(reason, count) {
    if (!Cloud.enabled) return toast('Upgrades aren\'t available in this version of the app.');
    let text = UPGRADE_REASONS[reason] || UPGRADE_REASONS.plan;
    if (reason === 'upload') text = count + ' unpaid invoice' + (count === 1 ? '' : 's') + ' from this device didn\'t fit on the Free plan. They\'re still saved here. Upgrade to add them to your account.';
    $('#upgradeReason').textContent = text;
    $('#upgradeError').textContent = '';
    const trial = !(state.plan && state.plan.trialUsed);
    $('#upgradeTitle').textContent = trial ? 'Try ShutterPaid Pro free for 14 days' : 'Upgrade to ShutterPaid Pro';
    $('#upgradeTrialNote').hidden = !trial;
    $('#upgradeGo').textContent = !Cloud.user() ? 'Sign in to continue' : trial ? 'Start free trial' : 'Continue to checkout';
    $$('[data-price]').forEach((el) => { el.textContent = PRICES[el.dataset.price]; });
    if (!upgradeDialog.open) upgradeDialog.showModal();
  }

  $('#upgradeClose').addEventListener('click', () => upgradeDialog.close());

  $('#upgradeGo').addEventListener('click', async () => {
    if (!Cloud.user()) {
      try { sessionStorage.setItem('shutterpaid:afterSignIn', 'upgrade'); } catch (e) { /* ignore */ }
      upgradeDialog.close();
      return openAuth();
    }
    const btn = $('#upgradeGo');
    const interval = (upgradeDialog.querySelector('[name=interval]:checked') || {}).value || 'month';
    btn.disabled = true;
    $('#upgradeError').textContent = '';
    try {
      const data = await Cloud.invoke('create-checkout', { interval });
      track('Upgrade started', { interval });
      window.location.href = data.url;
    } catch (err) {
      $('#upgradeError').textContent = err.message;
      btn.disabled = false;
    }
  });

  async function openBillingPortal() {
    const btn = $('#planManageBtn');
    btn.disabled = true;
    try {
      const data = await Cloud.invoke('billing-portal');
      window.location.href = data.url;
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  }

  $('#planUpgradeBtn').addEventListener('click', () => openUpgrade('plan'));
  $('#planManageBtn').addEventListener('click', openBillingPortal);
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-upgrade]');
    if (b) openUpgrade(b.dataset.upgrade);
  });

  // An active slot opened up: retry anything the Free plan limit held back.
  function freedSlot() {
    if (userId() && Cloud.parkedCount()) Cloud.requeueParked();
  }

  // Placeholder for analytics events (wired up in a later phase).
  function track() {}

  function planSummary(p) {
    const date = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const price = p.interval ? PRICES[p.interval] + '/' + p.interval : '';
    if (p.status === 'trialing') {
      return 'Free trial until ' + date(p.trialEndsAt) + '. ' + (p.cancelAtPeriodEnd || !p.hasBilling
        ? 'Add a payment method in Manage billing to keep Pro after that.'
        : 'Then ' + price + '.');
    }
    if (p.status === 'past_due') return 'Your last payment didn\'t go through. Update your card in Manage billing to keep Pro.';
    if (p.cancelAtPeriodEnd) return 'Pro until ' + date(p.periodEnd) + ', then you\'ll move to the Free plan.';
    return [price, p.periodEnd ? 'Renews ' + date(p.periodEnd) : ''].filter(Boolean).join(' · ') + '.';
  }

  function renderPlan() {
    const signedIn = !!userId();
    $('#planPanel').hidden = !Cloud.enabled || !signedIn;
    const note = $('#planNote');
    note.hidden = !onFreePlan();
    if (onFreePlan()) {
      const used = Core.activeCount(state.invoices);
      note.classList.toggle('full', used >= LIMIT);
      note.innerHTML = 'Free plan: ' + Math.min(used, LIMIT) + ' of ' + LIMIT + ' active invoices. ' +
        '<button type="button" class="linkish" data-upgrade="plan">' + (state.plan && state.plan.trialUsed ? 'Upgrade to Pro' : 'Try Pro free for 14 days') + '</button>';
    }
    if (!signedIn || !Cloud.enabled) return;
    const p = state.plan || { plan: 'free' };
    const pro = isPro();
    $('#planName').textContent = pro ? 'ShutterPaid Pro' : 'Free plan';
    const badge = $('#planBadge');
    badge.hidden = !(pro && (p.status === 'trialing' || p.status === 'past_due'));
    badge.textContent = p.status === 'trialing' ? 'Trial' : 'Payment issue';
    badge.className = 'badge ' + (p.status === 'past_due' ? 'badge-danger' : 'badge-warn');
    $('#planDetail').textContent = pro
      ? planSummary(p)
      : Core.activeCount(state.invoices) + ' of ' + LIMIT + ' active invoices used. Manual reminders only. Pro adds unlimited invoices and automatic reminders for ' + PRICES.month + '/month or ' + PRICES.year + '/year.';
    $('#planUpgradeBtn').hidden = pro;
    $('#planUpgradeBtn').textContent = p.trialUsed ? 'Upgrade to Pro' : 'Start 14-day free trial';
    $('#planManageBtn').hidden = !p.hasBilling;
  }

  // Back from Stripe Checkout: the webhook may take a few seconds, so re-sync until Pro shows up.
  function handleCheckoutReturn() {
    const params = new URLSearchParams(location.search);
    const result = params.get('checkout');
    if (!result) return;
    history.replaceState(null, '', location.pathname);
    if (result === 'cancel') return toast('Checkout canceled. You\'re still on the Free plan.');
    toast('Thanks! Setting up Pro…');
    track('Upgraded');
    let tries = 0;
    const timer = setInterval(() => {
      if (isPro() || ++tries > 10) {
        clearInterval(timer);
        toast(isPro() ? 'You\'re on ShutterPaid Pro 🎉' : 'Payment received. Pro will appear in a minute; pull to refresh if not.');
        return;
      }
      Cloud.sync();
    }, 3000);
  }

  // ---------- Boot ----------
  renderAll();
  Cloud.init({ onUser, onRemote, onStatus });
  handleCheckoutReturn();
  if (location.hash === '#upgrade') {
    history.replaceState(null, '', location.pathname + location.search);
    openUpgrade('plan');
  }
  if (location.hash === '#new') {
    history.replaceState(null, '', location.pathname);
    openInvoiceDialog(null);
  }
})();
