// "Join the beta" form on the landing page. Saves the email to the beta_signups table with the
// public anon key (visitors can add an address but can't read the list). Hidden when Supabase
// isn't configured, e.g. on GitHub Pages.
(function () {
  var cfg = window.SP_CONFIG || {};
  var section = document.getElementById('beta');
  var form = document.getElementById('betaForm');
  if (!section || !form || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return;
  section.hidden = false;
  var status = document.getElementById('betaStatus');
  var input = document.getElementById('betaEmail');

  function show(text, kind) {
    status.textContent = text;
    status.className = 'beta-status ' + (kind || '');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = input.value.trim();
    // Bots fill in the hidden field; pretend it worked and send nothing.
    if (form.elements.website.value) return show('Thanks! You’re on the list.', 'ok');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      input.focus();
      return show('Please enter a valid email address.', 'err');
    }
    var btn = form.querySelector('button');
    btn.disabled = true;
    show('');
    fetch(cfg.supabaseUrl + '/rest/v1/beta_signups', {
      method: 'POST',
      headers: {
        apikey: cfg.supabaseAnonKey,
        Authorization: 'Bearer ' + cfg.supabaseAnonKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ email: email, source: 'landing' })
    }).then(function (res) {
      // 409 means the address is already on the list; the visitor sees the same thanks either way.
      if (res.ok || res.status === 409) {
        form.reset();
        show('Thanks! You’re on the list.', 'ok');
        if (res.ok && window.SPAnalytics) window.SPAnalytics.track('Beta signup');
      } else {
        show('Something went wrong. Please try again in a minute.', 'err');
      }
    }).catch(function () {
      show('You seem to be offline. Please try again.', 'err');
    }).then(function () {
      btn.disabled = false;
    });
  });
})();
