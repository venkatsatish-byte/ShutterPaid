// ShutterPaid app logic. All data lives in localStorage on the user's device.
(function () {
  'use strict';

  const STORE_KEY = 'shutterpaid:data:v1';
  const DAY = 24 * 60 * 60 * 1000;

  const defaultSettings = {
    ownerName: '',
    businessName: '',
    currency: 'USD',
    soonDays: 3,
    paymentLink: '',
    signature: ''
  };

  // ---------- Storage ----------
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        return {
          invoices: Array.isArray(data.invoices) ? data.invoices : [],
          settings: Object.assign({}, defaultSettings, data.settings)
        };
      }
    } catch (e) {
      console.warn('Could not read saved data', e);
    }
    return { invoices: [], settings: Object.assign({}, defaultSettings) };
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('Could not save. Is storage full or disabled?');
    }
  }

  const state = load();

  // ---------- Helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function todayISO() {
    const d = new Date();
    return toISO(d);
  }

  function toISO(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function parseISO(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(iso, n) {
    const d = parseISO(iso);
    d.setDate(d.getDate() + n);
    return toISO(d);
  }

  function daysUntil(iso) {
    return Math.round((parseISO(iso) - parseISO(todayISO())) / DAY);
  }

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
    if (inv.paid) return 'Paid ' + prettyDate(inv.paidDate);
    const n = daysUntil(inv.dueDate);
    if (n === 0) return 'Due today';
    if (n === 1) return 'Due tomorrow';
    if (n > 1) return 'Due in ' + n + ' days';
    if (n === -1) return 'Due yesterday';
    return 'Overdue by ' + Math.abs(n) + ' days';
  }

  function statusOf(inv) {
    if (inv.paid) return 'paid';
    const n = daysUntil(inv.dueDate);
    if (n < 0) return 'overdue';
    if (n <= Number(state.settings.soonDays)) return 'soon';
    return 'open';
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
      actions.push('<button class="btn btn-sm btn-primary" data-act="remind" data-id="' + inv.id + '">✉️ Remind</button>');
      actions.push('<button class="btn btn-sm" data-act="paid" data-id="' + inv.id + '">✅ Mark paid</button>');
    } else {
      actions.push('<button class="btn btn-sm" data-act="unpaid" data-id="' + inv.id + '">↩️ Mark unpaid</button>');
    }
    if (!opts || !opts.compact) {
      actions.push('<button class="btn btn-sm btn-ghost" data-act="edit" data-id="' + inv.id + '">Edit</button>');
      actions.push('<button class="btn btn-sm btn-ghost btn-danger" data-act="delete" data-id="' + inv.id + '">Delete</button>');
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
  }

  // ---------- Navigation ----------
  function showView(name) {
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
      toast('Invoice updated');
    } else {
      state.invoices.push(Object.assign({ id: uid(), paid: false, paidDate: '', reminders: [], createdAt: todayISO() }, data));
      toast('Invoice added 📸');
    }
    save();
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
        save(); renderAll();
        toast('Marked paid — nice work! 💸');
        break;
      case 'unpaid':
        inv.paid = false;
        inv.paidDate = '';
        save(); renderAll();
        break;
      case 'edit':
        openInvoiceDialog(inv);
        break;
      case 'delete':
        if (confirm('Delete the invoice for ' + inv.clientName + '?')) {
          state.invoices = state.invoices.filter((i) => i !== inv);
          save(); renderAll();
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
    const n = daysUntil(inv.dueDate);
    const sent = (inv.reminders || []).length;
    if (n < -21 && sent >= 2) return 'final';
    if (n < -7 || (n < 0 && sent >= 1)) return 'firm';
    return 'friendly';
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
    reminderInvoice.reminders = reminderInvoice.reminders || [];
    reminderInvoice.reminders.push({ date: todayISO(), tone: reminderTone, channel: channel });
    save();
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
      if (f[k]) state.settings[k] = k === 'soonDays' ? Math.max(0, Number(f[k].value) || 0) : f[k].value.trim();
    });
    save();
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
      state.invoices = data.invoices;
      state.settings = Object.assign({}, defaultSettings, data.settings);
      save(); renderAll(); renderSettings();
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
      state.invoices.push(Object.assign({
        id: uid(), number: nextInvoiceNumber(), currency: cur, notes: '', paid: false, paidDate: '', reminders: [], createdAt: t
      }, s));
    });
    save(); renderAll();
    toast('Sample data loaded');
    showView('dashboard');
  });

  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('This permanently erases all invoices and settings on this device. Continue?')) return;
    state.invoices = [];
    state.settings = Object.assign({}, defaultSettings);
    save(); renderAll(); renderSettings();
    toast('All data erased');
  });

  // ---------- Boot ----------
  renderAll();
  if (location.hash === '#new') {
    history.replaceState(null, '', location.pathname);
    openInvoiceDialog(null);
  }
})();
