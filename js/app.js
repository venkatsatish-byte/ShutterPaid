// ShutterPaid app logic.
// Signed out, all data lives in localStorage on this device (local-only mode).
// Signed in, data is cached in localStorage per account and synced to Supabase by js/cloud.js.
(function () {
  'use strict';

  const Core = window.SPCore;
  const Cloud = window.SPCloud;
  const LOCAL_KEY = 'shutterpaid:data:v1';

  const defaultSettings = {
    ownerName: '',
    businessName: '',
    currency: 'USD',
    soonDays: 3,
    paymentLink: '',
    signature: '',
    timeZone: deviceTimeZone()
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
      settings: Object.assign({}, defaultSettings, data && data.settings)
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
    const last = inv.reminders && inv.reminders.length ? inv.reminders[inv.reminders.length - 1] : null;
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

    return '<li class="item">' +
      '<div><div class="item-title">' + esc(inv.clientName) + '</div><div class="item-meta">' + meta + '</div></div>' +
      '<div class="item-amount">' + BADGES[st] + '<div>' + money(inv.amount, inv.currency) + '</div></div>' +
      '<div class="item-actions">' + actions.join('') + '</div>' +
      '</li>';
  }

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
  }

  function renderAll() {
    renderDashboard();
    renderInvoices();
    renderAccount();
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
    invoiceDialog.showModal();
  }

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
    if (existing) {
      Object.assign(existing, data);
      putInvoice(existing);
      toast('Invoice updated');
    } else {
      putInvoice(Object.assign({ id: uid(), paid: false, paidDate: '', reminders: [], createdAt: todayISO() }, data));
      toast('Invoice added 📸');
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
        toast('Marked paid — nice work! 💸');
        break;
      case 'unpaid':
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
    const s = state.settings;
    const first = (inv.clientName || '').split(/\s|&/)[0] || 'there';
    const amount = money(inv.amount, inv.currency);
    const ref = inv.number ? ' (' + inv.number + ')' : '';
    const shoot = inv.shootType ? inv.shootType.toLowerCase() + ' session' : 'session';
    const due = prettyDate(inv.dueDate);
    const n = daysUntil(inv.dueDate);
    const pay = s.paymentLink ? '\n\nYou can pay quickly and securely here:\n' + s.paymentLink : '';
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
      if (f[k]) state.settings[k] = k === 'soonDays' ? Math.min(30, Math.max(0, Number(f[k].value) || 0)) : f[k].value.trim();
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
      const known = state.invoices.concat(remote.invoices);
      const plan = Core.planUpload(device.invoices, known);
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
      // Keep the original device data under a different key, just in case, and stop asking.
      write(LOCAL_KEY + ':uploaded', device);
      localStorage.removeItem(LOCAL_KEY);
      localStorage.setItem(offeredKey(u.id), new Date().toISOString());
      uploadDialog.close();
      renderAll();
      const skipped = plan.skipped.length;
      toast('Added ' + plan.upload.length + ' invoice' + (plan.upload.length === 1 ? '' : 's') + (skipped ? ' (' + skipped + ' already in your account)' : '') + ' ☁️');
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
    if (currentView === 'settings') renderSettings();
    if (u) maybeOfferUpload(u);
  }

  function onRemote(remote) {
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
    if (currentView === 'settings' && !$('#settingsForm').contains(document.activeElement)) renderSettings();
  }

  function onStatus(i) {
    syncInfo = i;
    renderAccount();
    if (i.rejected) toast('Some changes couldn\'t be saved to your account.');
  }

  // ---------- Boot ----------
  renderAll();
  Cloud.init({ onUser, onRemote, onStatus });
  if (location.hash === '#new') {
    history.replaceState(null, '', location.pathname);
    openInvoiceDialog(null);
  }
})();
