// ShutterPaid cloud sync: Supabase auth plus an offline-first outbox.
// Every change is written to the local cache first (by app.js) and queued here. The queue is pushed
// to Supabase whenever we're online and signed in, then the latest server data is pulled back.
// If js/config.js has no Supabase settings, this module stays disabled and the app is local-only.
(function () {
  'use strict';

  const Core = window.SPCore;
  const config = window.SP_CONFIG || {};
  const enabled = !!(config.supabaseUrl && config.supabaseAnonKey);
  const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
  const ACTIVE_USER_KEY = 'shutterpaid:activeUser';
  const PULL_EVERY = 5 * 60 * 1000;
  const PAGE = 1000;

  let client = null;
  let user = readActiveUser();
  let handlers = { onUser() {}, onRemote() {}, onStatus() {} };
  let status = enabled ? (user ? 'offline' : 'signed-out') : 'disabled';
  let lastSynced = null;
  let syncing = false;
  let again = false;

  // ---------- Small helpers ----------
  function readActiveUser() {
    try {
      const raw = localStorage.getItem(ACTIVE_USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeActiveUser(u) {
    try {
      if (u) localStorage.setItem(ACTIVE_USER_KEY, JSON.stringify(u));
      else localStorage.removeItem(ACTIVE_USER_KEY);
    } catch (e) { /* storage disabled: session still works for this tab */ }
  }

  function outboxKey(id) { return 'shutterpaid:outbox:' + id; }

  function readOutbox(id) {
    try {
      return JSON.parse(localStorage.getItem(outboxKey(id || (user && user.id))) || '[]');
    } catch (e) {
      return [];
    }
  }

  function writeOutbox(ops) {
    if (!user) return;
    try {
      localStorage.setItem(outboxKey(user.id), JSON.stringify(ops));
    } catch (e) {
      console.warn('Could not save the sync queue', e);
    }
  }

  function setStatus(s) {
    status = s;
    handlers.onStatus(info());
  }

  function info() {
    return { status, user, pending: user ? readOutbox().length : 0, lastSynced };
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  function slimUser(u) {
    return u ? { id: u.id, email: u.email || '' } : null;
  }

  // ---------- Setup ----------
  let ready = null;
  function ensureClient() {
    if (!enabled) return Promise.resolve(null);
    if (client) return Promise.resolve(client);
    if (!ready) {
      ready = (window.supabase ? Promise.resolve() : loadScript(SUPABASE_JS))
        .then(() => {
          client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
          });
          client.auth.onAuthStateChange((event, session) => {
            // The initial session is handled by init() so an offline start can't sign anyone out.
            if (event === 'INITIAL_SESSION') return;
            // Supabase invokes this while holding its auth lock; defer so our own calls don't deadlock.
            setTimeout(() => applySession(session), 0);
          });
          return client;
        })
        .catch((err) => {
          ready = null; // try again later, e.g. when we come back online
          throw err;
        });
    }
    return ready;
  }

  function applySession(session) {
    const next = slimUser(session && session.user);
    const changed = (next && next.id) !== (user && user.id);
    if (!changed) {
      if (next) { user = next; writeActiveUser(next); }
      return false;
    }
    user = next;
    writeActiveUser(next);
    lastSynced = null;
    setStatus(next ? 'syncing' : 'signed-out');
    handlers.onUser(next);
    if (next) sync();
    return true;
  }

  async function init(h) {
    handlers = Object.assign(handlers, h);
    if (!enabled) return info();
    handlers.onStatus(info());

    window.addEventListener('online', () => sync());
    window.addEventListener('offline', () => { if (user) setStatus('offline'); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
    setInterval(() => { if (document.visibilityState === 'visible') sync(); }, PULL_EVERY);

    try {
      await ensureClient();
      const { data, error } = await client.auth.getSession();
      // An error here usually means a token refresh failed offline: keep the cached user.
      const switched = !error && applySession(data.session);
      if (!switched && user) sync();
      // Clean ?code=… / #access_token=… from the address bar after an auth redirect.
      if (/[?&#](code|access_token|error_description)=/.test(location.href)) {
        history.replaceState(null, '', location.pathname);
      }
    } catch (err) {
      console.warn('Cloud sync unavailable for now', err);
      if (user) setStatus('offline');
    }
    return info();
  }

  // ---------- Auth ----------
  function redirectUrl() {
    return new URL('app.html', location.href).href;
  }

  async function signInWithEmail(email) {
    const c = await ensureClient();
    const { error } = await c.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectUrl() } });
    if (error) throw error;
  }

  async function verifyCode(email, token) {
    const c = await ensureClient();
    const { error } = await c.auth.verifyOtp({ email, token, type: 'email' });
    if (error) throw error;
  }

  async function signInWithGoogle() {
    const c = await ensureClient();
    const { error } = await c.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectUrl() } });
    if (error) throw error;
  }

  async function signOut() {
    const c = await ensureClient().catch(() => null);
    const prev = user;
    if (c) await c.auth.signOut({ scope: 'local' }).catch(() => {});
    if (user) applySession(null);
    // Keep an unsynced queue so nothing is lost; it is pushed on the next sign-in as this user.
    return prev;
  }

  // ---------- Outbox ----------
  function enqueue(op) {
    if (!user) return;
    const ops = readOutbox();
    ops.push(op);
    writeOutbox(Core.coalesceOps(ops));
    if (navigator.onLine !== false && status !== 'syncing') setStatus('syncing');
    else handlers.onStatus(info());
    scheduleSync();
  }

  let syncTimer = null;
  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, 400);
  }

  function pending() {
    return Core.pendingKeys(user ? readOutbox().concat(readParked()) : []);
  }

  // Changes the server refused because of the plan (FREE_PLAN_LIMIT / PRO_REQUIRED) are set aside
  // instead of dropped, so the invoice stays on this device. They go back in the queue when the
  // account upgrades or frees up room (requeueParked).
  function parkedKey(id) { return 'shutterpaid:parked:' + id; }

  function readParked(id) {
    try {
      return JSON.parse(localStorage.getItem(parkedKey(id || (user && user.id))) || '[]');
    } catch (e) {
      return [];
    }
  }

  function writeParked(ops) {
    if (!user) return;
    try {
      if (ops.length) localStorage.setItem(parkedKey(user.id), JSON.stringify(ops));
      else localStorage.removeItem(parkedKey(user.id));
    } catch (e) { /* ignore */ }
  }

  function requeueParked() {
    const parked = readParked();
    if (!parked.length) return;
    writeParked([]);
    writeOutbox(Core.coalesceOps(parked.concat(readOutbox())));
    scheduleSync();
  }

  async function runBatch(c, batch) {
    const first = batch[0];
    // Most tables are keyed by id; booking_profiles is keyed by the photographer's user id.
    const key = first.table === 'booking_profiles' ? 'user_id' : 'id';
    if (first.op === 'delete') {
      return c.from(first.table).delete().in(key, batch.map((o) => o.id));
    }
    return c.from(first.table).upsert(batch.map((o) => o.row), { onConflict: key });
  }

  // Push queued changes in order, batching neighbours that hit the same table the same way.
  async function flush(c) {
    let ops = Core.coalesceOps(readOutbox());
    while (ops.length) {
      const batch = [ops[0]];
      while (batch.length < 200 && ops[batch.length] && ops[batch.length].table === ops[0].table && ops[batch.length].op === ops[0].op) {
        batch.push(ops[batch.length]);
      }
      let { error } = await runBatch(c, batch);
      if (error && Core.isTransientError(error)) throw error;
      if (error && batch.length > 1) {
        // One bad row fails the whole statement: retry one at a time so the good rows still save.
        for (let i = 0; i < batch.length; i++) {
          const one = await runBatch(c, [batch[i]]);
          if (one.error && Core.isTransientError(one.error)) {
            batch.length = i; // keep the rest queued
            break;
          }
          if (one.error) reject(batch[i], one.error);
        }
        error = null;
      } else if (error) {
        reject(batch[0], error);
      }
      // Re-read in case the user made more changes while we were waiting on the network: an op that
      // was replaced by a newer version of the same row stays queued.
      const sent = new Set(batch.map((b) => JSON.stringify(b)));
      const latest = readOutbox().filter((o) => !sent.has(JSON.stringify(o)));
      writeOutbox(latest);
      ops = Core.coalesceOps(latest);
    }
  }

  function reject(op, error) {
    const limit = Core.planLimitError(error);
    if (limit) {
      writeParked(Core.coalesceOps(readParked().concat([op])));
      handlers.onStatus(Object.assign(info(), { limit }));
      return;
    }
    // Rejected outright (validation or permission). Retrying won't help, so drop it and tell the
    // user; their local copy stays on this device.
    console.error('Sync rejected', error, op);
    const slugTaken = op.table === 'booking_profiles' && error.code === '23505';
    handlers.onStatus(Object.assign(info(), { rejected: error.message, slugTaken }));
  }

  async function selectAll(c, table, columns) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await c.from(table).select(columns).order('id').range(from, from + PAGE - 1);
      if (error) throw error;
      rows.push.apply(rows, data);
      if (data.length < PAGE) return rows;
    }
  }

  // Read everything this user has on the server (RLS limits every query to their own rows).
  async function fetchRemote() {
    const c = await ensureClient();
    if (!user) throw new Error('Not signed in');
    const [invoices, reminders, profile] = await Promise.all([
      selectAll(c, 'invoices', Core.INVOICE_COLUMNS),
      selectAll(c, 'reminder_log', Core.REMINDER_COLUMNS),
      c.from('profiles').select('*').eq('id', user.id).maybeSingle()
    ]);
    if (profile.error) throw profile.error;
    return {
      invoices: Core.assemble(invoices, reminders),
      settings: profile.data ? Core.rowToSettings(profile.data) : null,
      profile: profile.data,
      booking: await fetchBooking(c)
    };
  }

  // Booking setup (profile, event types, weekly hours, blocked dates). Returns null if it can't be
  // read, e.g. the booking migration hasn't been applied yet, so invoice sync keeps working.
  async function fetchBooking(c) {
    try {
      const [profile, eventTypes, hours, blocked] = await Promise.all([
        c.from('booking_profiles').select('*').eq('user_id', user.id).maybeSingle(),
        selectAll(c, 'event_types', '*'),
        selectAll(c, 'availability_rules', '*'),
        selectAll(c, 'blocked_dates', '*')
      ]);
      if (profile.error) throw profile.error;
      return { profile: profile.data, eventTypes, hours, blocked };
    } catch (err) {
      console.warn('Booking setup not available', err);
      return null;
    }
  }

  // Is this booking link free? (Photographers can't read each other's profiles.)
  async function slugAvailable(slug) {
    const c = await ensureClient();
    const { data, error } = await c.rpc('booking_slug_available', { p_slug: slug });
    if (error) throw error;
    return !!data;
  }

  // Upload a profile photo to the public booking-photos bucket; returns its public URL.
  async function uploadPhoto(blob) {
    const c = await ensureClient();
    if (!user) throw new Error('Not signed in');
    const path = user.id + '/avatar-' + Date.now() + '.jpg';
    const { error } = await c.storage.from('booking-photos').upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false });
    if (error) throw error;
    return c.storage.from('booking-photos').getPublicUrl(path).data.publicUrl;
  }

  async function sync() {
    if (!enabled || !user) return;
    if (syncing) { again = true; return; }
    if (navigator.onLine === false) { setStatus('offline'); return; }
    syncing = true;
    const uid = user.id;
    setStatus('syncing');
    try {
      const c = await ensureClient();
      await flush(c);
      const remote = await fetchRemote();
      if (!user || user.id !== uid) return; // signed out or switched account mid-sync
      lastSynced = new Date();
      handlers.onRemote(remote);
      setStatus(readOutbox().length ? 'syncing' : 'synced');
    } catch (err) {
      console.warn('Sync failed, will retry', err);
      setStatus(navigator.onLine === false || Core.isTransientError(err) ? 'offline' : 'error');
    } finally {
      syncing = false;
      if (again) { again = false; scheduleSync(); }
    }
  }

  function discardLocalCopy(id) {
    try {
      localStorage.removeItem(outboxKey(id));
      localStorage.removeItem(parkedKey(id));
    } catch (e) { /* ignore */ }
  }

  // Call a billing Edge Function with the user's session; returns { url }.
  async function invoke(name, body) {
    const c = await ensureClient();
    const { data, error } = await c.functions.invoke(name, { body: body || {} });
    if (error) {
      let message = 'Something went wrong. Please try again.';
      try {
        const detail = error.context && typeof error.context.json === 'function' ? await error.context.json() : null;
        if (detail && detail.error) message = detail.error;
      } catch (e) { /* keep the generic message */ }
      throw new Error(navigator.onLine === false ? 'You\'re offline. Connect to the internet and try again.' : message);
    }
    return data;
  }

  window.SPCloud = {
    enabled,
    init,
    info,
    user: () => user,
    signInWithEmail,
    verifyCode,
    signInWithGoogle,
    signOut,
    enqueue,
    pending,
    pendingCount: (id) => readOutbox(id).length + readParked(id).length,
    slugAvailable,
    uploadPhoto,
    parkedCount: () => readParked().length,
    requeueParked,
    invoke,
    fetchRemote,
    sync,
    discardLocalCopy
  };
})();
