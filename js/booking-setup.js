// Booking setup screen (Bookings tab): booking page profile, event types, weekly hours, days off and
// cancellation policy. Signed-in photographers only. Like invoices, every change is saved to the
// account cache first and queued for sync (see js/app.js and js/cloud.js).
(function () {
  'use strict';

  const App = window.SPApp;
  const B = window.SPBooking;
  const M = window.SPMarkdown;
  const S = window.SPSchedule;
  const Cloud = window.SPCloud;
  if (!App || !B) return;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = App.esc;
  const state = App.state;
  const uuid = window.SPCore.uuid;

  // Forms the user has typed into since they were last filled, so a background sync doesn't
  // overwrite their edits.
  const dirty = new Set();
  let pendingPhotoUrl = null;

  // ---------- Data helpers ----------
  function booking() {
    return state.booking;
  }

  function savedProfile() {
    return booking().profile;
  }

  // The saved profile, or sensible defaults for a first-time setup.
  function currentProfile() {
    if (savedProfile()) return savedProfile();
    const s = state.settings;
    const name = s.businessName || s.ownerName || '';
    return {
      slug: B.slugify(name),
      displayName: name,
      photoUrl: pendingPhotoUrl || '',
      bio: '',
      timeZone: s.timeZone || App.deviceTimeZone(),
      accepting: false,
      minNoticeMinutes: 1440,
      maxDaysAhead: 90,
      maxPerDay: '',
      cancellationPolicy: ''
    };
  }

  function saveProfile(p) {
    booking().profile = p;
    App.save();
    App.queueRow('booking_profiles', App.userId(), B.profileToRow(p, App.userId()));
  }

  function bookingUrl(slug) {
    return new URL('book/' + slug, document.baseURI).href;
  }

  function readiness() {
    return [
      { done: !!savedProfile(), text: 'Save your profile and booking link' },
      { done: booking().eventTypes.some((e) => e.active), text: 'Add an event type clients can book' },
      { done: booking().hours.length > 0, text: 'Set your weekly hours' }
    ];
  }

  // ---------- Status ----------
  function renderStatus() {
    const p = savedProfile();
    const steps = readiness();
    const ready = steps.every((s) => s.done);
    $('#bkAccepting').checked = !!(p && p.accepting);
    $('#bkStatusText').textContent = p && p.accepting
      ? 'Bookings are on. Clients can book you at the link below.'
      : ready ? 'Bookings are off. Switch them on when you\'re ready.' : 'Finish these steps, then switch bookings on.';
    $('#bkChecklist').innerHTML = ready ? '' : steps.map((s) =>
      '<li class="' + (s.done ? 'done' : '') + '"><span aria-hidden="true">' + (s.done ? '✓' : '○') + '</span> ' +
      esc(s.text) + '<span class="visually-hidden">' + (s.done ? ' (done)' : ' (to do)') + '</span></li>').join('');
    $('#bkLinkRow').hidden = !p;
    $('#bkLinkNote').hidden = !p;
    if (p) $('#bkLink').textContent = bookingUrl(p.slug);
  }

  $('#bkAccepting').addEventListener('change', (e) => {
    const p = savedProfile();
    const turnOn = e.target.checked;
    if (turnOn && !readiness().every((s) => s.done)) {
      e.target.checked = false;
      App.toast('Finish the steps above before accepting bookings');
      renderStatus();
      return;
    }
    saveProfile(Object.assign({}, p, { accepting: turnOn }));
    renderStatus();
    App.toast(turnOn ? 'Bookings are on' : 'Bookings are off');
  });

  $('#bkCopyLink').addEventListener('click', async () => {
    const text = $('#bkLink').textContent;
    try {
      await navigator.clipboard.writeText(text);
      App.toast('Booking link copied');
    } catch (err) {
      const r = document.createRange();
      r.selectNodeContents($('#bkLink'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      App.toast('Select the link and copy it');
    }
  });

  // ---------- Profile ----------
  const profileForm = $('#bkProfileForm');

  function renderPhoto(url) {
    $('#bkPhoto').hidden = !url;
    $('#bkPhotoEmpty').hidden = !!url;
    $('#bkPhotoRemove').hidden = !url;
    if (url) $('#bkPhoto').src = url;
  }

  function renderProfile() {
    const p = currentProfile();
    renderPhoto(pendingPhotoUrl !== null ? pendingPhotoUrl : p.photoUrl);
    if (dirty.has('profile')) return;
    const f = profileForm.elements;
    f.displayName.value = p.displayName;
    f.slug.value = p.slug;
    f.bio.value = p.bio;
    f.timeZone.value = p.timeZone;
    $('#bkBioCount').textContent = p.bio.length;
    $('#bkProfileError').textContent = '';
  }

  profileForm.addEventListener('input', (e) => {
    dirty.add('profile');
    const f = profileForm.elements;
    if (e.target === f.bio) $('#bkBioCount').textContent = f.bio.value.length;
    // Suggest a link from the name until the photographer edits the link themselves.
    if (e.target === f.displayName && !savedProfile() && !f.slug.dataset.edited) f.slug.value = B.slugify(f.displayName.value);
    if (e.target === f.slug) f.slug.dataset.edited = '1';
  });

  profileForm.elements.slug.addEventListener('blur', (e) => {
    const cleaned = B.slugify(e.target.value);
    if (cleaned && cleaned !== e.target.value) e.target.value = cleaned;
  });

  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = profileForm.elements;
    const err = $('#bkProfileError');
    err.textContent = '';
    const slug = B.slugify(f.slug.value);
    f.slug.value = slug;
    const displayName = f.displayName.value.trim();
    const timeZone = f.timeZone.value.trim();
    const fail = (msg, field) => { err.textContent = msg; if (field) field.focus(); };
    if (!displayName) return fail('Enter the name clients will see.', f.displayName);
    const slugIssue = B.slugProblem(slug);
    if (slugIssue) return fail(slugIssue, f.slug);
    if (!S.validTimeZone(timeZone)) return fail('Pick a time zone from the list, like America/New_York.', f.timeZone);

    const before = savedProfile();
    if (!before || before.slug !== slug) {
      // Links must be unique across all photographers, so check with the server first.
      if (navigator.onLine === false) return fail('Connect to the internet to check that this booking link is free.');
      const btn = profileForm.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        if (!(await Cloud.slugAvailable(slug))) return fail('That booking link is taken. Try adding your city or studio name.', f.slug);
      } catch (ex) {
        return fail('We couldn\'t check the booking link. Please try again.');
      } finally {
        btn.disabled = false;
      }
    }
    const p = Object.assign({}, currentProfile(), {
      slug, displayName, bio: f.bio.value.trim(), timeZone,
      photoUrl: pendingPhotoUrl !== null ? pendingPhotoUrl : currentProfile().photoUrl
    });
    pendingPhotoUrl = null;
    saveProfile(p);
    dirty.delete('profile');
    render({ keepEdits: true });
    App.toast(before ? 'Profile saved' : 'Booking page created 🎉');
  });

  // Photos are cropped to a square and shrunk before upload, so they load fast for clients.
  function squareJpeg(file, size) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = Math.min(size, side);
        canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not read the image'))), 'image/jpeg', 0.86);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the image')); };
      img.src = url;
    });
  }

  $('#bkPhotoInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return App.toast('Choose a JPEG, PNG or WebP image');
    if (file.size > 20 * 1024 * 1024) return App.toast('That image is too large (20 MB maximum)');
    if (navigator.onLine === false) return App.toast('Connect to the internet to upload a photo');
    App.toast('Uploading photo…');
    try {
      const url = await Cloud.uploadPhoto(await squareJpeg(file, 512));
      if (savedProfile()) {
        saveProfile(Object.assign({}, savedProfile(), { photoUrl: url }));
        App.toast('Photo updated');
      } else {
        pendingPhotoUrl = url;
        App.toast('Photo uploaded. Save your profile to keep it.');
      }
      renderPhoto(url);
    } catch (err) {
      console.warn(err);
      App.toast('Upload failed. Please try again.');
    }
  });

  $('#bkPhotoRemove').addEventListener('click', () => {
    if (savedProfile()) saveProfile(Object.assign({}, savedProfile(), { photoUrl: '' }));
    pendingPhotoUrl = savedProfile() ? null : '';
    renderPhoto('');
  });

  // ---------- Event types ----------
  function depositText(et) {
    const amount = B.depositAmount(et);
    if (!amount) return 'No advance';
    return 'Optional advance ' + App.money(amount, et.currency) + (et.depositType === 'percent' ? ' (' + B.round2(et.depositValue) + '%)' : '');
  }

  function renderTypes() {
    const list = booking().eventTypes;
    $('#bkTypeList').innerHTML = list.length ? list.map((et) =>
      '<li class="item">' +
        '<div><div class="item-title">' + esc(et.name) + '</div>' +
        '<div class="item-meta">' + [B.formatDuration(et.durationMinutes), esc(B.LOCATION_TYPES[et.locationType]), esc(depositText(et))].join(' · ') + '</div></div>' +
        '<div class="item-amount">' + (et.active ? '<span class="badge badge-ok">Bookable</span>' : '<span class="badge badge-muted">Hidden</span>') +
        '<div>' + esc(App.money(et.price, et.currency)) + '</div></div>' +
        '<div class="item-actions">' +
          '<button class="btn btn-sm" type="button" data-et-act="edit" data-id="' + esc(et.id) + '">Edit</button>' +
          '<button class="btn btn-sm btn-ghost" type="button" data-et-act="toggle" data-id="' + esc(et.id) + '">' + (et.active ? 'Hide from clients' : 'Show to clients') + '</button>' +
        '</div>' +
      '</li>').join('')
      : '<li class="empty">No event types yet. Add the kinds of shoots clients can book, like weddings or portraits.</li>';
  }

  function saveType(et) {
    const list = booking().eventTypes;
    const i = list.findIndex((x) => x.id === et.id);
    if (i >= 0) list[i] = et; else list.push(et);
    App.save();
    App.queueRow('event_types', et.id, B.eventTypeToRow(et, App.userId()));
  }

  $('#bkTypeList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-et-act]');
    if (!btn) return;
    const et = booking().eventTypes.find((x) => x.id === btn.dataset.id);
    if (!et) return;
    if (btn.dataset.etAct === 'edit') return openType(et);
    saveType(Object.assign({}, et, { active: !et.active }));
    render({ keepEdits: true });
  });

  const etDialog = $('#etDialog');
  const etForm = $('#etForm');

  function fillType(et) {
    const f = etForm.elements;
    f.id.value = et.id || '';
    f.name.value = et.name;
    f.description.value = et.description;
    f.durationMinutes.value = et.durationMinutes;
    f.bufferBefore.value = et.bufferBefore;
    f.bufferAfter.value = et.bufferAfter;
    f.locationType.value = et.locationType;
    f.locationDetails.value = et.locationDetails;
    f.price.value = et.price || '';
    f.currency.value = et.currency;
    $$('[name=depositMode]', etForm).forEach((r) => { r.checked = r.value === et.depositMode; });
    f.depositType.value = et.depositType;
    f.depositValue.value = et.depositValue || '';
    f.instructions.value = et.instructions;
    f.cancellationPolicy.value = et.cancellationPolicy;
    f.active.checked = et.active;
    resetMarkdown(etForm);
    updateDeposit();
  }

  function readType() {
    const f = etForm.elements;
    const mode = ($('[name=depositMode]:checked', etForm) || {}).value || 'none';
    return B.newEventType({
      id: f.id.value || uuid(),
      name: f.name.value.trim(),
      description: f.description.value.trim(),
      durationMinutes: Math.round(Number(f.durationMinutes.value)),
      bufferBefore: Math.round(Number(f.bufferBefore.value) || 0),
      bufferAfter: Math.round(Number(f.bufferAfter.value) || 0),
      locationType: f.locationType.value,
      locationDetails: f.locationDetails.value.trim(),
      price: B.round2(Number(f.price.value) || 0),
      currency: f.currency.value,
      depositMode: mode === 'optional' ? 'optional' : 'none',
      depositType: f.depositType.value,
      depositValue: B.round2(Number(f.depositValue.value) || 0),
      instructions: f.instructions.value.trim(),
      cancellationPolicy: f.cancellationPolicy.value.trim(),
      active: f.active.checked
    });
  }

  function updateDeposit() {
    const et = readType();
    const optional = et.depositMode === 'optional';
    $('#etDepositFields').hidden = !optional;
    $('#etDepositLabel').textContent = et.depositType === 'percent' ? 'Percentage (%)' : 'Amount (' + et.currency + ')';
    const amount = B.depositAmount(et);
    $('#etDepositSummary').textContent = !optional
      ? 'Clients book without paying in advance.'
      : amount > 0
        ? 'Clients can pay ' + App.money(amount, et.currency) + ' now and ' + App.money(B.round2(et.price - amount), et.currency) + ' later, or book without paying anything now. Advances are paid to your own Stripe account once you connect payouts.'
        : 'Set a price and an advance amount.';
  }

  function openType(et) {
    $('#etTitle').textContent = et ? 'Edit event type' : 'New event type';
    $('#etPresetRow').hidden = !!et;
    $('#etDelete').hidden = !et;
    $('#etError').textContent = '';
    etForm.elements.preset.value = '';
    fillType(et || B.newEventType({ currency: state.settings.currency || 'USD', price: '' }));
    etDialog.showModal();
    etForm.elements[et ? 'name' : 'preset'].focus();
  }

  $('#bkAddType').addEventListener('click', () => openType(null));
  $('#etCancel').addEventListener('click', () => etDialog.close());

  etForm.elements.preset.addEventListener('change', (e) => {
    const preset = B.PRESETS[e.target.value];
    const keep = readType();
    fillType(B.newEventType(Object.assign({ currency: keep.currency, price: keep.price || '' }, preset || {})));
  });

  etForm.addEventListener('input', (e) => {
    if (['depositMode', 'depositType', 'depositValue', 'price', 'currency'].includes(e.target.name)) updateDeposit();
  });
  etForm.addEventListener('change', (e) => {
    if (['depositMode', 'depositType', 'currency'].includes(e.target.name)) updateDeposit();
  });

  etForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const et = readType();
    const problems = B.eventTypeProblems(et);
    const first = Object.keys(problems)[0];
    if (first) {
      $('#etError').textContent = problems[first];
      const field = etForm.elements[first === 'depositValue' && !(Number(et.price) > 0) ? 'price' : first];
      if (field && field.focus) field.focus();
      return;
    }
    const existing = booking().eventTypes.find((x) => x.id === et.id);
    et.sortOrder = existing ? existing.sortOrder : booking().eventTypes.reduce((m, x) => Math.max(m, x.sortOrder), -1) + 1;
    saveType(et);
    etDialog.close();
    render({ keepEdits: true });
    App.toast(existing ? 'Event type saved' : 'Event type added');
  });

  $('#etDelete').addEventListener('click', () => {
    const id = etForm.elements.id.value;
    const et = booking().eventTypes.find((x) => x.id === id);
    if (!et || !confirm('Delete "' + et.name + '"? Clients won\'t be able to book it. To keep it but stop new bookings, hide it instead.')) return;
    booking().eventTypes = booking().eventTypes.filter((x) => x.id !== id);
    App.save();
    App.queueDelete('event_types', id);
    etDialog.close();
    render({ keepEdits: true });
    App.toast('Event type deleted');
  });

  // ---------- Weekly hours ----------
  const hoursForm = $('#bkHoursForm');
  let week = null; // working copy: { [weekday]: [{start, end}] }

  function weekFromHours(hours) {
    const w = {};
    B.WEEK_ORDER.forEach((d) => { w[d] = []; });
    hours.forEach((h) => w[h.weekday].push({ start: h.start, end: h.end }));
    Object.values(w).forEach((list) => list.sort((a, b) => a.start.localeCompare(b.start)));
    return w;
  }

  function readWeek() {
    const w = {};
    $$('.bk-day', hoursForm).forEach((row) => {
      const d = Number(row.dataset.day);
      w[d] = $('[data-open]', row).checked
        ? $$('.bk-interval', row).map((iv) => ({ start: $('[data-start]', iv).value, end: $('[data-end]', iv).value }))
        : [];
    });
    return w;
  }

  function renderWeek() {
    $('#bkWeek').innerHTML = B.WEEK_ORDER.map((d) => {
      const list = week[d];
      const open = list.length > 0;
      const day = B.WEEKDAYS[d];
      return '<div class="bk-day" data-day="' + d + '">' +
        '<label class="check bk-day-name"><input type="checkbox" data-open' + (open ? ' checked' : '') + '> ' + day + '</label>' +
        '<div class="bk-intervals">' + (open ? list.map((iv, i) =>
          '<div class="bk-interval">' +
            '<input type="time" step="900" data-start value="' + esc(iv.start) + '" aria-label="' + day + ' start time ' + (i + 1) + '">' +
            '<span aria-hidden="true">–</span>' +
            '<input type="time" step="900" data-end value="' + esc(iv.end) + '" aria-label="' + day + ' end time ' + (i + 1) + '">' +
            '<button type="button" class="btn btn-sm btn-ghost" data-remove aria-label="Remove ' + day + ' hours ' + (i + 1) + '">✕</button>' +
          '</div>').join('') +
          '<button type="button" class="btn btn-sm btn-ghost" data-add>+ Add hours</button>'
          : '<span class="bk-closed">Unavailable</span>') +
        '</div></div>';
    }).join('');
  }

  $('#bkWeek').addEventListener('click', (e) => {
    const row = e.target.closest('.bk-day');
    if (!row) return;
    const d = Number(row.dataset.day);
    if (e.target.closest('[data-add]')) {
      week = readWeek();
      const last = week[d][week[d].length - 1];
      const start = last ? Math.min(B.toMinutes(last.end) + 60, 23 * 60) : 9 * 60;
      week[d].push({ start: B.fromMinutes(start), end: B.fromMinutes(Math.min(start + 120, 23 * 60 + 45)) });
      renderWeek();
      const ivs = $$('.bk-day[data-day="' + d + '"] [data-start]', hoursForm);
      ivs[ivs.length - 1].focus();
    } else if (e.target.closest('[data-remove]')) {
      week = readWeek();
      const i = $$('.bk-interval', row).indexOf(e.target.closest('.bk-interval'));
      week[d].splice(i, 1);
      renderWeek();
      $('.bk-day[data-day="' + d + '"] [data-open]', hoursForm).focus();
    }
    dirty.add('hours');
  });

  $('#bkWeek').addEventListener('change', (e) => {
    if (!e.target.matches('[data-open]')) return;
    const d = Number(e.target.closest('.bk-day').dataset.day);
    week = readWeek();
    week[d] = e.target.checked ? [{ start: '09:00', end: '17:00' }] : [];
    renderWeek();
    $('.bk-day[data-day="' + d + '"] [data-open]', hoursForm).focus();
    dirty.add('hours');
  });

  hoursForm.addEventListener('input', () => dirty.add('hours'));

  function renderHours() {
    if (dirty.has('hours')) return;
    // Until hours are saved, suggest Monday to Friday, 9 to 5 (saved only when they press Save;
    // the checklist keeps "Set your weekly hours" open until then).
    week = weekFromHours(booking().hours.length ? booking().hours : B.defaultHours());
    renderWeek();
    const p = currentProfile();
    const f = hoursForm.elements;
    f.minNotice.value = String(p.minNoticeMinutes);
    if (f.minNotice.value !== String(p.minNoticeMinutes)) {
      f.minNotice.add(new Option(B.formatNotice(p.minNoticeMinutes), String(p.minNoticeMinutes)));
      f.minNotice.value = String(p.minNoticeMinutes);
    }
    f.maxDaysAhead.value = p.maxDaysAhead;
    f.maxPerDay.value = p.maxPerDay || '';
    $('#bkHoursError').textContent = '';
  }

  hoursForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#bkHoursError');
    err.textContent = '';
    if (!savedProfile()) {
      err.textContent = 'Save your profile first.';
      return;
    }
    const w = readWeek();
    for (const d of B.WEEK_ORDER) {
      const problem = w[d].length ? B.hoursProblem(w[d]) : null;
      if (problem) {
        err.textContent = B.WEEKDAYS[d] + ': ' + problem;
        return;
      }
    }
    const f = hoursForm.elements;
    const maxDays = Math.round(Number(f.maxDaysAhead.value));
    const maxPerDay = f.maxPerDay.value === '' ? '' : Math.round(Number(f.maxPerDay.value));
    if (!(maxDays >= 1 && maxDays <= 730)) { err.textContent = 'Clients can book between 1 and 730 days ahead.'; f.maxDaysAhead.focus(); return; }
    if (maxPerDay !== '' && !(maxPerDay >= 1 && maxPerDay <= 50)) { err.textContent = 'Max bookings per day must be between 1 and 50, or blank.'; f.maxPerDay.focus(); return; }

    // Replace the stored hours only if they changed.
    const next = [];
    B.WEEK_ORDER.forEach((d) => w[d].forEach((iv) => next.push({ weekday: d, start: iv.start, end: iv.end })));
    const key = (list) => list.map((h) => h.weekday + h.start + h.end).sort().join('|');
    if (key(next) !== key(booking().hours)) {
      booking().hours.forEach((h) => App.queueDelete('availability_rules', h.id));
      booking().hours = next.map((h) => Object.assign({ id: uuid() }, h));
      booking().hours.forEach((h) => App.queueRow('availability_rules', h.id, B.hourToRow(h, App.userId())));
    }
    saveProfile(Object.assign({}, savedProfile(), { minNoticeMinutes: Number(f.minNotice.value), maxDaysAhead: maxDays, maxPerDay }));
    dirty.delete('hours');
    render({ keepEdits: true });
    App.toast('Availability saved');
  });

  // ---------- Days off ----------
  const blockedForm = $('#bkBlockedForm');

  function renderBlocked() {
    const today = App.todayISO();
    const list = booking().blocked.filter((b) => b.endDate >= today);
    $('#bkBlockedList').innerHTML = list.length ? list.map((b) =>
      '<li class="item bk-blocked">' +
        '<div><div class="item-title">' + esc(b.startDate === b.endDate ? App.prettyDate(b.startDate) : App.prettyDate(b.startDate) + ' – ' + App.prettyDate(b.endDate)) + '</div>' +
        (b.note ? '<div class="item-meta">' + esc(b.note) + '</div>' : '') + '</div>' +
        '<div><button class="btn btn-sm btn-ghost btn-danger" type="button" data-unblock="' + esc(b.id) + '" aria-label="Remove days off ' + esc(b.startDate) + '">Remove</button></div>' +
      '</li>').join('')
      : '<li class="empty" style="padding:12px">No days off planned.</li>';
  }

  $('#bkBlockedList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-unblock]');
    if (!btn) return;
    booking().blocked = booking().blocked.filter((b) => b.id !== btn.dataset.unblock);
    App.save();
    App.queueDelete('blocked_dates', btn.dataset.unblock);
    renderBlocked();
    App.toast('Days off removed');
  });

  blockedForm.elements.startDate.addEventListener('change', (e) => {
    const end = blockedForm.elements.endDate;
    if (!end.value || end.value < e.target.value) end.value = e.target.value;
  });

  blockedForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = blockedForm.elements;
    const b = { id: uuid(), startDate: f.startDate.value, endDate: f.endDate.value, note: f.note.value.trim() };
    const problem = B.blockedProblem(b);
    if (problem) {
      $('#bkBlockedError').textContent = problem;
      return;
    }
    $('#bkBlockedError').textContent = '';
    booking().blocked.push(b);
    booking().blocked.sort((x, y) => x.startDate.localeCompare(y.startDate));
    App.save();
    App.queueRow('blocked_dates', b.id, B.blockedToRow(b, App.userId()));
    blockedForm.reset();
    renderBlocked();
    App.toast('Days off added');
  });

  // ---------- Cancellation policy ----------
  const policyForm = $('#bkPolicyForm');

  function renderPolicy() {
    if (dirty.has('policy')) return;
    policyForm.elements.policy.value = currentProfile().cancellationPolicy;
    resetMarkdown(policyForm);
  }

  policyForm.addEventListener('input', () => dirty.add('policy'));

  policyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!savedProfile()) return App.toast('Save your profile first');
    saveProfile(Object.assign({}, savedProfile(), { cancellationPolicy: policyForm.elements.policy.value.trim() }));
    dirty.delete('policy');
    App.toast('Policy saved');
  });

  // ---------- Markdown editors (Write / Preview) ----------
  function resetMarkdown(root) {
    $$('[data-md]', root).forEach((ed) => showMdTab(ed, 'write'));
  }

  function showMdTab(ed, tab) {
    const preview = $('.md-preview', ed);
    const area = $('textarea', ed);
    $$('[data-md-tab]', ed).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mdTab === tab)));
    area.hidden = tab !== 'write';
    preview.hidden = tab !== 'preview';
    if (tab === 'preview') {
      // Safe: SPMarkdown escapes everything and only allows http(s)/mailto links.
      preview.innerHTML = M.toHtml(area.value) || '<p class="hint">Nothing to preview yet.</p>';
    }
  }

  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-md-tab]');
    if (tab) showMdTab(tab.closest('[data-md]'), tab.dataset.mdTab);
  });

  // ---------- Render ----------
  function render(opts) {
    if (!App.userId()) return;
    // Fill the time zone suggestions once.
    const tz = $('#tzList');
    if (tz && !tz.options.length && typeof Intl.supportedValuesOf === 'function') {
      tz.innerHTML = Intl.supportedValuesOf('timeZone').map((z) => '<option value="' + esc(z) + '">').join('');
    }
    // Opening the tab starts fresh; saves and background syncs keep other forms' unsaved edits.
    if (!(opts && opts.keepEdits)) dirty.clear();
    renderStatus();
    renderProfile();
    renderTypes();
    renderHours();
    renderBlocked();
    renderPolicy();
  }

  window.SPBookingSetup = { render };
})();
