// In-browser fake of the bits of supabase-js that cloud.js uses. Data persists in localStorage.
(function () {
  const DBK = '__fakedb', SK = '__fakesession';
  const db = () => JSON.parse(localStorage.getItem(DBK) || '{"invoices":[],"reminder_log":[],"profiles":[]}');
  const saveDb = (d) => localStorage.setItem(DBK, JSON.stringify(d));
  const offline = () => !!localStorage.getItem('__offline');
  const NET = { message: 'TypeError: Failed to fetch', code: '' };
  window.__calls = [];
  function createClient() {
    const listeners = [];
    let session = JSON.parse(localStorage.getItem(SK) || 'null');
    const emit = (ev) => listeners.forEach((cb) => cb(ev, session));
    const auth = {
      onAuthStateChange(cb) { listeners.push(cb); setTimeout(() => cb('INITIAL_SESSION', session)); return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session }, error: null }; },
      async signInWithOtp({ email }) { if (offline()) return { error: NET }; localStorage.setItem('__otp', email); return { error: null }; },
      async verifyOtp({ email, token }) {
        if (token !== '123456') return { error: { message: 'Token has expired or is invalid' } };
        const id = email === 'b@x.com' ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111';
        session = { user: { id, email } }; localStorage.setItem(SK, JSON.stringify(session));
        const d = db(); if (!d.profiles.some((p) => p.id === id)) { d.profiles.push({ id, email, owner_name: '', business_name: '', currency: 'USD', soon_days: 3, payment_link: '', signature: '', time_zone: '' }); saveDb(d); }
        emit('SIGNED_IN'); return { error: null };
      },
      async signInWithOAuth() { return { error: { message: 'not in test' } }; },
      async signOut() { session = null; localStorage.removeItem(SK); emit('SIGNED_OUT'); return { error: null }; }
    };
    function from(table) {
      const uid = () => session && session.user.id;
      const own = (r) => (table === 'profiles' ? r.id : r.user_id) === uid();
      const q = { filters: [], kind: 'select' };
      const run = async () => {
        window.__calls.push(table + ':' + q.kind + ':' + (q.rows ? q.rows.length : ''));
        if (offline()) return { data: null, error: NET };
        const d = db();
        if (q.kind === 'select') {
          let rows = d[table].filter(own);
          q.filters.forEach((f) => { rows = rows.filter(f); });
          rows = rows.slice(q.from || 0, q.to == null ? undefined : q.to + 1);
          return { data: q.single ? rows[0] || null : rows, error: null };
        }
        if (q.kind === 'upsert') {
          // Like a single SQL statement: if any row breaks a rule, nothing is saved.
          const before = JSON.stringify(d);
          const fail = (error) => { Object.assign(d, JSON.parse(before)); return { error }; };
          for (const r of q.rows) {
            if ((table === 'profiles' ? r.id : r.user_id) !== uid()) return { error: { code: '42501', message: 'rls' } };
            if (table === 'invoices' && !/^[A-Z]{3}$/.test(r.currency)) return { error: { code: '23514', message: 'check currency' } };
            const i = d[table].findIndex((x) => x.id === r.id);
            const old = i >= 0 ? d[table][i] : null;
            if (table === 'invoices') {
              // Mirrors enforce_plan_limits() in the plans migration.
              const prof = d.profiles.find((p) => p.id === uid()) || {};
              const pro = prof.plan === 'pro';
              const becomesActive = !r.paid && (!old || old.paid);
              const turnsOnAuto = r.auto_remind && (!old || !old.auto_remind);
              if (!pro && turnsOnAuto) return fail({ code: 'P0001', message: 'PRO_REQUIRED' });
              if (!pro && becomesActive && d.invoices.filter((x) => x.user_id === uid() && !x.paid && x.id !== r.id).length >= 5) {
                return fail({ code: 'P0001', message: 'FREE_PLAN_LIMIT' });
              }
            }
            if (old) { if (!own(old)) return fail({ code: '42501', message: 'rls' }); d[table][i] = Object.assign(old, r); }
            else d[table].push(Object.assign({ created_at: new Date().toISOString() }, r));
          }
          saveDb(d); return { data: null, error: null };
        }
        if (q.kind === 'delete') {
          const del = d[table].filter((r) => own(r) && q.ids.includes(r.id)).map((r) => r.id);
          d[table] = d[table].filter((r) => !del.includes(r.id));
          if (table === 'invoices') d.reminder_log = d.reminder_log.filter((r) => !del.includes(r.invoice_id));
          saveDb(d); return { data: null, error: null };
        }
      };
      const b = {
        select() { return b; }, order() { return b; },
        range(f, t) { q.from = f; q.to = t; return b; },
        eq(col, v) { q.filters.push((r) => r[col] === v); return b; },
        maybeSingle() { q.single = true; return b; },
        upsert(rows) { q.kind = 'upsert'; q.rows = Array.isArray(rows) ? rows : [rows]; return b; },
        delete() { q.kind = 'delete'; return b; },
        in(col, ids) { q.ids = ids; return b; },
        then(res, rej) { return run().then(res, rej); }
      };
      return b;
    }
    const functions = {
      async invoke(name, opts) {
        window.__invoked = (window.__invoked || []).concat([{ name, body: opts && opts.body }]);
        if (offline()) return { data: null, error: { message: 'Failed to send a request to the Edge Function', context: {} } };
        const url = (window.__functionUrls || {})[name];
        if (!url) return { data: null, error: { message: 'Edge Function returned a non-2xx status code', context: { json: async () => ({ error: 'No billing account yet. Upgrade to Pro first.' }) } } };
        return { data: { url }, error: null };
      }
    };
    return { auth, from, functions };
  }
  window.supabase = { createClient };
})();
