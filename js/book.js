// Public booking page (book.html): choose a session, a date and time, enter details, review and
// book; then see the confirmation. With #manage=<token> it shows the customer's booking instead,
// where they can re-read instructions, reschedule or cancel. No login: everything goes through
// the booking Edge Functions. Times are shown in the customer's time zone.
(function () {
  'use strict';

  const cfg = window.SP_CONFIG || {};
  const B = window.SPBooking;
  const M = window.SPMarkdown;
  const ICS = window.SPIcs;
  const FN = (cfg.supabaseUrl || '').replace(/\/$/, '') + '/functions/v1/';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = M.escape;

  const deviceTz = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
  })();

  const st = {
    slug: '',
    page: null,
    type: null,
    tz: deviceTz,
    month: null, // 'YYYY-MM' in the customer's time zone
    days: {}, // date -> slots, for loaded months
    loaded: {}, // month -> true
    lastBookable: '',
    date: '',
    slot: null,
    details: null,
    step: 1,
    rescheduleToken: '', // set while rescheduling an existing booking
    manage: null
  };

  // ---------- Small helpers ----------
  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  function money(amount, currency) {
    try {
      const n = Number(amount);
      return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);
    } catch (e) {
      return currency + ' ' + Number(amount).toFixed(2);
    }
  }

  function fmtTime(iso, tz) {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz });
  }

  function fmtDate(iso, tz, long) {
    return new Date(iso).toLocaleDateString(undefined, { weekday: long ? 'long' : 'short', month: 'long', day: 'numeric', year: 'numeric', timeZone: tz });
  }

  function fmtDay(dateISO) {
    const [y, m, d] = dateISO.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  }

  function tzName(tz) {
    return tz.replace(/_/g, ' ');
  }

  function todayIn(tz) {
    const p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
    return p.year + '-' + p.month + '-' + p.day;
  }

  function addMonths(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return d.toISOString().slice(0, 7);
  }

  function lastDayOf(ym) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }

  async function api(name, opts) {
    if (!cfg.supabaseUrl) throw new Error('Online booking isn\'t set up on this site yet.');
    let res;
    try {
      res = await fetch(FN + name + (opts && opts.query ? '?' + new URLSearchParams(opts.query) : ''), {
        method: opts && opts.body ? 'POST' : 'GET',
        // These functions are public (no login or API key), so plain GETs need no CORS preflight.
        headers: opts && opts.body ? { 'Content-Type': 'application/json' } : {},
        body: opts && opts.body ? JSON.stringify(opts.body) : undefined
      });
    } catch (e) {
      throw new Error(navigator.onLine === false ? 'You\'re offline. Connect to the internet to book.' : 'We couldn\'t reach the booking service. Please try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Please try again.');
      err.status = res.status;
      err.fields = data.fields;
      throw err;
    }
    return data;
  }

  function status(msg, isError) {
    const el = $('#bookStatus');
    el.hidden = !msg;
    el.textContent = msg || '';
    el.classList.toggle('is-error', !!isError);
  }

  function showWho(p) {
    $('#bookWho').hidden = false;
    $('#whoName').textContent = p.displayName;
    $('#whoBio').textContent = p.bio || '';
    $('#whoBio').hidden = !p.bio;
    const img = $('#whoPhoto');
    img.hidden = !p.photoUrl;
    if (p.photoUrl) img.src = p.photoUrl;
    document.title = 'Book ' + p.displayName;
  }

  // ---------- Steps ----------
  const TITLES = { 1: 'Choose a session', 2: 'Choose a date and time', 3: 'Your details', 4: 'Review and book' };

  function goStep(n, opts) {
    st.step = n;
    $$('.book-step').forEach((p) => { p.hidden = Number(p.dataset.panel) !== n; });
    $$('.book-steps li').forEach((li) => {
      const k = Number(li.dataset.step);
      li.classList.toggle('done', k < n);
      if (k === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    $('#stepTitle').textContent = st.rescheduleToken && n === 2 ? 'Choose a new date and time' : TITLES[n];
    $('.book-steps').hidden = !!st.rescheduleToken;
    $('#flowError').textContent = '';
    if (!(opts && opts.noFocus)) {
      $('#stepTitle').focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-back]')) return;
    if (st.rescheduleToken && st.step === 2) return openManage(st.rescheduleToken);
    goStep(st.step - 1);
  });

  // ---------- Step 1: event types ----------
  function renderTypes() {
    const list = st.page.eventTypes;
    $('#typeList').innerHTML = list.length ? list.map((t) =>
      '<button type="button" class="book-type" role="listitem" data-type="' + esc(t.id) + '">' +
        '<span class="book-type-head"><strong>' + esc(t.name) + '</strong><span class="book-type-price">' + esc(money(t.price, t.currency)) + '</span></span>' +
        '<span class="book-type-meta">' + esc(B.formatDuration(t.durationMinutes)) + ' · ' + esc(t.locationLabel) +
          (t.advanceAmount > 0 ? ' · Optional advance ' + esc(money(t.advanceAmount, t.currency)) : '') + '</span>' +
        (t.description ? '<span class="book-type-desc">' + esc(t.description) + '</span>' : '') +
      '</button>').join('')
      : '<p class="sub">No sessions are open for booking right now.</p>';
  }

  $('#typeList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-type]');
    if (!btn) return;
    selectType(st.page.eventTypes.find((t) => t.id === btn.dataset.type));
  });

  function selectType(t) {
    st.type = t;
    st.days = {};
    st.loaded = {};
    st.date = '';
    st.slot = null;
    st.month = todayIn(st.tz).slice(0, 7);
    $('#chosenType').innerHTML = '<strong>' + esc(t.name) + '</strong> · ' + esc(B.formatDuration(t.durationMinutes)) + ' · ' + esc(money(t.price, t.currency));
    goStep(2);
    loadMonth();
  }

  // ---------- Step 2: calendar and times ----------
  function fillTzSelect() {
    const sel = $('#tzSelect');
    const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [deviceTz];
    if (!zones.includes(st.tz)) zones.unshift(st.tz);
    sel.innerHTML = zones.map((z) => '<option value="' + esc(z) + '"' + (z === st.tz ? ' selected' : '') + '>' + esc(tzName(z)) + '</option>').join('');
    updateTzLabel();
  }

  function updateTzLabel() {
    const photographerTz = st.page ? st.page.timeZone : (st.manage ? st.manage.photographer.timeZone : st.tz);
    $('#tzLabel').textContent = 'Times are in ' + tzName(st.tz) + (st.tz === deviceTz ? ' (your time zone)' : '') +
      (photographerTz && photographerTz !== st.tz ? '. The photographer is in ' + tzName(photographerTz) + '.' : '.') + ' Change:';
  }

  $('#tzSelect').addEventListener('change', (e) => {
    st.tz = e.target.value;
    updateTzLabel();
    st.days = {};
    st.loaded = {};
    st.date = '';
    loadMonth();
  });

  async function loadMonth() {
    renderCalendar();
    if (st.loaded[st.month]) return;
    const today = todayIn(st.tz);
    const from = st.month + '-01' < today ? today : st.month + '-01';
    const to = lastDayOf(st.month);
    if (to < today) { st.loaded[st.month] = true; renderCalendar(); return; }
    $('#calHint').textContent = 'Loading available times…';
    try {
      const res = await api('get-available-slots', { query: Object.assign({
        slug: st.slug, event_type_id: st.type.id, from, to, tz: st.tz
      }, st.rescheduleToken ? { token: st.rescheduleToken } : {}) });
      st.lastBookable = res.lastBookableDate;
      res.days.forEach((d) => { st.days[d.date] = d.slots; });
      st.loaded[st.month] = true;
      // Jump to the first month with times if this one has none.
      if (!res.days.length && st.month <= today.slice(0, 7) && addMonths(st.month, 1) <= (st.lastBookable || '').slice(0, 7)) {
        st.month = addMonths(st.month, 1);
        return loadMonth();
      }
      $('#calHint').textContent = '';
    } catch (err) {
      $('#calHint').textContent = err.message;
    }
    renderCalendar();
  }

  function renderCalendar() {
    const [y, m] = st.month.split('-').map(Number);
    $('#calMonth').textContent = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const today = todayIn(st.tz);
    $('#calPrev').disabled = st.month <= today.slice(0, 7);
    $('#calNext').disabled = !!st.lastBookable && addMonths(st.month, 1) > st.lastBookable.slice(0, 7);
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const daysIn = Number(lastDayOf(st.month).slice(8));
    const head = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => {
      const full = new Date(Date.UTC(2023, 0, 1 + i)).toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' });
      return '<div role="columnheader" class="book-cal-dow"><abbr title="' + esc(full) + '">' + esc(d) + '</abbr></div>';
    }).join('');
    const cells = [];
    for (let i = 0; i < first; i++) cells.push('<div role="gridcell" class="book-cal-empty"></div>');
    for (let d = 1; d <= daysIn; d++) {
      const date = st.month + '-' + String(d).padStart(2, '0');
      const open = !!(st.days[date] && st.days[date].length);
      const selected = date === st.date;
      const label = fmtDay(date) + (open ? ', ' + st.days[date].length + ' times available' : ', no times available');
      cells.push('<div role="gridcell"><button type="button" class="book-day' + (open ? ' open' : '') + (selected ? ' selected' : '') +
        (date === today ? ' today' : '') + '" data-date="' + date + '" aria-label="' + esc(label) + '"' +
        (open ? '' : ' aria-disabled="true"') + ' aria-pressed="' + selected + '" tabindex="-1">' + d + '</button></div>');
    }
    const rows = [];
    for (let i = 0; i < cells.length; i += 7) rows.push('<div role="row" class="book-cal-row">' + cells.slice(i, i + 7).join('') + '</div>');
    $('#calGrid').innerHTML = '<div role="row" class="book-cal-row">' + head + '</div>' + rows.join('');
    // One day is reachable with Tab (the selected day, else the first open one); arrows move from there.
    const focusDay = $('#calGrid .book-day.selected') || $('#calGrid .book-day.open') || $('#calGrid .book-day');
    if (focusDay) focusDay.tabIndex = 0;
    if (!st.loaded[st.month]) return;
    const anyOpen = Object.keys(st.days).some((k) => k.startsWith(st.month) && st.days[k].length);
    if (!anyOpen && !$('#calHint').textContent) $('#calHint').textContent = 'No open times this month. Try the next month.';
    renderTimes();
  }

  $('#calPrev').addEventListener('click', () => { st.month = addMonths(st.month, -1); $('#calHint').textContent = ''; loadMonth(); });
  $('#calNext').addEventListener('click', () => { st.month = addMonths(st.month, 1); $('#calHint').textContent = ''; loadMonth(); });

  $('#calGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.book-day');
    if (!btn || btn.getAttribute('aria-disabled') === 'true') return;
    st.date = btn.dataset.date;
    st.slot = null;
    renderCalendar();
    const first = $('#timeList button');
    if (first) first.focus();
  });

  // Arrow keys move around the calendar grid (a week is 7 days).
  $('#calGrid').addEventListener('keydown', (e) => {
    const btn = e.target.closest('.book-day');
    if (!btn) return;
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (!(e.key in moves) && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const days = $$('#calGrid .book-day');
    let i = days.indexOf(btn);
    if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = days.length - 1;
    else i = Math.min(days.length - 1, Math.max(0, i + moves[e.key]));
    days.forEach((d) => { d.tabIndex = -1; });
    days[i].tabIndex = 0;
    days[i].focus();
  });

  function renderTimes() {
    const list = st.date ? st.days[st.date] || [] : [];
    $('#timesTitle').textContent = st.date ? fmtDay(st.date) : 'Choose a date';
    const photographerTz = st.page ? st.page.timeZone : st.manage.photographer.timeZone;
    $('#timeList').innerHTML = list.map((s) =>
      '<button type="button" class="book-time" role="listitem" data-start="' + esc(s.start) + '">' + esc(fmtTime(s.start, st.tz)) +
      (photographerTz !== st.tz ? '<small>' + esc(fmtTime(s.start, photographerTz)) + ' for the photographer</small>' : '') + '</button>').join('') ||
      (st.date ? '<p class="sub">No times left on this day.</p>' : '<p class="sub">Days with open times are highlighted.</p>');
  }

  $('#timeList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-start]');
    if (!btn) return;
    const slot = st.days[st.date].find((s) => s.start === btn.dataset.start);
    st.slot = slot;
    if (st.rescheduleToken) return confirmReschedule();
    $('#chosenTime').innerHTML = '<strong>' + esc(st.type.name) + '</strong> · ' + esc(fmtDate(slot.start, st.tz, true)) + ' at ' + esc(fmtTime(slot.start, st.tz));
    renderDetails();
    goStep(3);
  });

  // ---------- Step 3: details ----------
  function renderDetails() {
    const t = st.type;
    const addr = $('#addressRow');
    addr.hidden = !(t.locationType === 'customer_address' || t.locationType === 'outdoor');
    addr.firstChild.textContent = t.locationType === 'outdoor' ? 'Preferred location (optional)' : 'Event address';
    $('#fAddress').required = t.needsAddress;
    const policy = t.cancellationPolicy || st.page.cancellationPolicy;
    $('#policyBox').innerHTML = policy
      ? '<h3>Cancellation policy</h3><div class="md-preview book-md">' + M.toHtml(policy) + '</div>'
      : '<p class="hint" style="margin:0">' + esc(st.page.displayName) + ' hasn\'t added a cancellation policy. You can still cancel or reschedule from your booking link.</p>';
  }

  function fieldErrors(map) {
    const ids = { name: 'fName', email: 'fEmail', phone: 'fPhone', address: 'fAddress', accept_policy: 'fAccept' };
    Object.values(ids).forEach((id) => {
      $('#' + id + 'Err').textContent = '';
      $('#' + id).removeAttribute('aria-invalid');
    });
    let first = null;
    Object.keys(map || {}).forEach((k) => {
      if (!ids[k]) return;
      $('#' + ids[k] + 'Err').textContent = map[k];
      $('#' + ids[k]).setAttribute('aria-invalid', 'true');
      if (!first) first = $('#' + ids[k]);
    });
    if (first) first.focus();
    return !first;
  }

  $('#detailsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const d = {
      name: f.name.value.trim(),
      email: f.email.value.trim(),
      phone: f.phone.value.trim(),
      address: $('#addressRow').hidden ? '' : f.address.value.trim(),
      notes: f.notes.value.trim(),
      website: f.website.value,
      accept: f.accept.checked
    };
    const errs = {};
    if (!d.name) errs.name = 'Enter your name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) errs.email = 'Enter a valid email address, like name@example.com.';
    if (d.phone && !/^[0-9+()\-.\s]{6,40}$/.test(d.phone)) errs.phone = 'Enter a valid phone number, or leave it blank.';
    if (st.type.needsAddress && !d.address) errs.address = 'Enter the address for the shoot.';
    if (!d.accept) errs.accept_policy = 'Please accept the cancellation policy to continue.';
    if (!fieldErrors(errs)) return;
    st.details = d;
    renderReview();
    goStep(4);
  });

  // ---------- Step 4: review ----------
  function row(label, value) {
    return value ? '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>' : '';
  }

  function renderReview() {
    const t = st.type;
    const s = st.slot;
    $('#review').innerHTML =
      row('Session', t.name) +
      row('When', fmtDate(s.start, st.tz, true) + ', ' + fmtTime(s.start, st.tz) + ' – ' + fmtTime(s.end, st.tz) + ' (' + tzName(st.tz) + ')') +
      row('Where', [t.locationLabel, t.locationDetails || st.details.address].filter(Boolean).join(' · ')) +
      row('Price', money(t.price, t.currency)) +
      row('Name', st.details.name) +
      row('Email', st.details.email) +
      row('Phone', st.details.phone) +
      row('Notes', st.details.notes);
    const advance = t.advanceAmount > 0;
    $('#payChoice').hidden = !advance;
    $$('[name=pay]').forEach((r) => { r.checked = false; });
    $('#payErr').textContent = '';
    if (advance) {
      $('#payAdvanceLabel').textContent = 'Pay an advance of ' + money(t.advanceAmount, t.currency) + ' now (' + money(t.price - t.advanceAmount, t.currency) + ' later)';
      $('#payLaterLabel').textContent = 'Book without an advance and pay ' + st.page.displayName + ' later';
      $('#payNote').textContent = 'Either way, your time is reserved when you confirm.';
    } else {
      $('#payNote').textContent = 'Nothing to pay now. You\'ll pay ' + st.page.displayName + ' directly.';
    }
  }

  $('#confirmBtn').addEventListener('click', async () => {
    const t = st.type;
    let payAdvance = false;
    if (t.advanceAmount > 0) {
      const choice = ($('[name=pay]:checked') || {}).value;
      if (!choice) {
        $('#payErr').textContent = 'Choose whether to pay an advance now or later.';
        $('[name=pay]').focus();
        return;
      }
      payAdvance = choice === 'advance';
    }
    const btn = $('#confirmBtn');
    btn.disabled = true;
    btn.textContent = 'Booking…';
    $('#flowError').textContent = '';
    try {
      const res = await api('create-booking', { body: {
        slug: st.slug,
        event_type_id: t.id,
        start: st.slot.start,
        name: st.details.name,
        email: st.details.email,
        phone: st.details.phone,
        address: st.details.address,
        notes: st.details.notes,
        tz: st.tz,
        accept_policy: true,
        pay_advance: payAdvance,
        website: st.details.website
      } });
      if (window.SPAnalytics) window.SPAnalytics.track('Booking', { advance: payAdvance ? 'yes' : 'no' });
      if (res.checkoutUrl) {
        window.location.href = res.checkoutUrl; // advance payments (added with Stripe payouts)
        return;
      }
      history.replaceState(null, '', location.pathname + location.search + '#manage=' + res.token);
      await openManage(res.token, { justBooked: true });
    } catch (err) {
      if (err.status === 409) {
        // Someone took the time: refresh the calendar and let them pick another.
        st.loaded = {};
        st.days = {};
        st.slot = null;
        goStep(2);
        $('#flowError').textContent = err.message;
        loadMonth();
      } else if (err.fields) {
        goStep(3);
        fieldErrors(err.fields);
      } else {
        $('#flowError').textContent = err.message;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Confirm booking';
    }
  });

  // ---------- Confirmation / manage ----------
  const STATUS_TEXT = {
    confirmed: 'Confirmed',
    pending_payment: 'Waiting for payment',
    cancelled: 'Cancelled',
    completed: 'Completed',
    no_show: 'Missed'
  };

  function calendarEvent(v) {
    const b = v.booking;
    const where = [v.location && v.location.label, (v.location && v.location.details) || b.eventAddress].filter(Boolean).join(' · ');
    return {
      uid: b.id + '@shutterpaid',
      start: b.start,
      end: b.end,
      title: b.eventName + ' with ' + v.photographer.displayName,
      description: (v.instructions ? M.toText(v.instructions) + '\n\n' : '') + 'Manage your booking: ' + manageUrl(st.manageToken),
      location: where,
      url: manageUrl(st.manageToken)
    };
  }

  function manageUrl(token) {
    return location.origin + location.pathname + location.search + '#manage=' + token;
  }

  async function openManage(token, opts) {
    st.manageToken = token;
    st.rescheduleToken = '';
    $('#flow').hidden = true;
    status('Loading your booking…');
    try {
      st.manage = await api('manage-booking', { query: { token } });
    } catch (err) {
      status(err.message, true);
      return;
    }
    status('');
    renderManage(opts || {});
  }

  function renderManage(opts) {
    const v = st.manage;
    const b = v.booking;
    showWho(v.photographer);
    if (!st.slug) st.slug = v.photographer.slug;
    const tz = st.tz;
    $('#done').hidden = false;
    const cancelled = b.status === 'cancelled';
    $('#doneTitle').textContent = opts.justBooked ? 'You\'re booked! 🎉' : opts.rescheduled ? 'Your booking has moved' : cancelled ? 'This booking is cancelled' : 'Your booking';
    $('#doneSub').textContent = opts.justBooked
      ? 'We\'ve emailed a confirmation to ' + b.customerEmail + '.'
      : cancelled ? (b.cancelReason || '') : '';
    const pay = v.payment;
    const payText = pay.status === 'advance_paid' ? 'Advance paid: ' + money(pay.advancePaid, pay.currency) + '. Balance: ' + money(pay.balance, pay.currency)
      : pay.status === 'awaiting_payment' ? 'Waiting for your advance payment'
        : pay.status === 'refunded' ? 'Advance refunded: ' + money(pay.refunded, pay.currency)
          : money(pay.price, pay.currency) + ', paid to ' + v.photographer.displayName + ' directly';
    $('#doneSummary').innerHTML =
      row('Status', STATUS_TEXT[b.status] || b.status) +
      row('Session', b.eventName) +
      row('When', fmtDate(b.start, tz, true) + ', ' + fmtTime(b.start, tz) + ' – ' + fmtTime(b.end, tz) + ' (' + tzName(tz) + ')') +
      row('Where', [v.location && v.location.label, (v.location && v.location.details) || b.eventAddress].filter(Boolean).join(' · ')) +
      row('Payment', payText) +
      row('Booked by', b.customerName + ' · ' + b.customerEmail);
    $('#calButtons').hidden = cancelled;
    const link = manageUrl(st.manageToken);
    $('#manageLink').textContent = link;
    $('#gcalLink').href = ICS.googleCalendarUrl(calendarEvent(v));
    $('#instructionsBox').hidden = !v.instructions || cancelled;
    $('#instructions').innerHTML = M.toHtml(v.instructions || '');
    $('#donePolicyBox').hidden = !v.cancellationPolicy || cancelled;
    $('#donePolicy').innerHTML = M.toHtml(v.cancellationPolicy || '');
    const r = v.rules;
    $('#manageActions').hidden = cancelled || b.status === 'completed' || b.status === 'no_show';
    $('#rescheduleBtn').hidden = !r.canReschedule;
    $('#cancelBtn').hidden = !r.canCancel;
    $('#cancelForm').hidden = true;
    $('#manageRule').textContent = r.canCancel || r.canReschedule
      ? 'You can change this booking online until ' + fmtDate(r.changeDeadline, tz) + ', ' + fmtTime(r.changeDeadline, tz) + '.'
      : r.reason || 'Contact the photographer to change this booking.';
    $('#othersBox').hidden = !v.others.length;
    $('#othersList').innerHTML = v.others.map((o) =>
      '<li class="item"><div><div class="item-title">' + esc(o.eventName) + '</div><div class="item-meta">' +
      esc(fmtDate(o.start, tz) + ', ' + fmtTime(o.start, tz)) + ' · ' + esc(STATUS_TEXT[o.status] || o.status) + '</div></div>' +
      '<div><a class="btn btn-sm" href="#manage=' + esc(o.token) + '">View</a></div></li>').join('');
    $('#doneTitle').focus();
    window.scrollTo({ top: 0 });
  }

  $('#icsBtn').addEventListener('click', () => {
    const v = st.manage;
    const blob = new Blob([ICS.buildIcs(calendarEvent(v))], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = B.slugify(v.booking.eventName + ' ' + v.photographer.displayName) + '.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('#copyManage').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#manageLink').textContent);
      toast('Link copied');
    } catch (e) {
      const r = document.createRange();
      r.selectNodeContents($('#manageLink'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      toast('Select the link and copy it');
    }
  });

  $('#cancelBtn').addEventListener('click', () => {
    $('#cancelForm').hidden = false;
    $('#cancelReason').focus();
  });
  $('#cancelKeep').addEventListener('click', () => { $('#cancelForm').hidden = true; $('#cancelBtn').focus(); });

  $('#cancelForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      st.manage = await api('manage-booking', { body: { token: st.manageToken, action: 'cancel', reason: $('#cancelReason').value } });
      renderManage({});
      toast('Your booking is cancelled');
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('#rescheduleBtn').addEventListener('click', () => {
    const v = st.manage;
    st.rescheduleToken = st.manageToken;
    st.page = null;
    st.type = { id: v.booking.eventTypeId, name: v.booking.eventName, durationMinutes: Math.round((Date.parse(v.booking.end) - Date.parse(v.booking.start)) / 60000) };
    st.days = {};
    st.loaded = {};
    st.date = '';
    st.month = todayIn(st.tz).slice(0, 7);
    $('#done').hidden = true;
    $('#flow').hidden = false;
    $('#chosenType').innerHTML = 'Moving <strong>' + esc(v.booking.eventName) + '</strong> from ' + esc(fmtDate(v.booking.start, st.tz) + ', ' + fmtTime(v.booking.start, st.tz));
    updateTzLabel();
    goStep(2);
    loadMonth();
  });

  async function confirmReschedule() {
    const s = st.slot;
    const ok = window.confirm('Move your booking to ' + fmtDate(s.start, st.tz, true) + ' at ' + fmtTime(s.start, st.tz) + '?');
    if (!ok) return;
    try {
      st.manage = await api('manage-booking', { body: { token: st.rescheduleToken, action: 'reschedule', start: s.start } });
      st.rescheduleToken = '';
      $('#flow').hidden = true;
      renderManage({ rescheduled: true });
    } catch (err) {
      $('#flowError').textContent = err.message;
      if (err.status === 409) { st.days = {}; st.loaded = {}; loadMonth(); }
    }
  }

  // ---------- Start ----------
  function slugFromUrl() {
    const m = location.pathname.match(/\/book\/([^/]+)\/?$/);
    if (m) return decodeURIComponent(m[1]).toLowerCase();
    return (new URLSearchParams(location.search).get('p') || '').toLowerCase();
  }

  function tokenFromHash() {
    const m = /#manage=([0-9a-f-]{36})/i.exec(location.hash);
    return m ? m[1] : '';
  }

  async function startBooking() {
    $('#done').hidden = true;
    st.slug = slugFromUrl();
    if (!st.slug) return status('This booking link is incomplete. Please check the address.', true);
    status('Loading…');
    try {
      st.page = await api('booking-page', { query: { slug: st.slug } });
    } catch (err) {
      return status(err.message, true);
    }
    status('');
    showWho(st.page);
    $('#flow').hidden = false;
    renderTypes();
    fillTzSelect();
    goStep(1, { noFocus: true });
    // Only one session type: skip straight to the calendar.
    if (st.page.eventTypes.length === 1) selectType(st.page.eventTypes[0]);
  }

  function route() {
    const token = tokenFromHash();
    if (token) {
      fillTzSelect();
      openManage(token);
    } else {
      startBooking();
    }
  }

  window.addEventListener('hashchange', () => { if (tokenFromHash()) route(); });
  route();
})();
