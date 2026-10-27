// Privacy-friendly analytics (Plausible: no cookies, no personal data). Loads only when
// js/config.js has an analytics domain, so local and GitHub Pages builds send nothing.
// Custom events used: "Signup", "Upgrade started", "Upgrade", "Beta signup".
(function () {
  var cfg = window.SP_CONFIG || {};
  window.SPAnalytics = {
    track: function (name, props) {
      try {
        if (window.plausible) window.plausible(name, props ? { props: props } : undefined);
      } catch (e) { /* analytics must never break the app */ }
    }
  };
  if (!cfg.plausibleDomain) return;
  window.plausible = window.plausible || function () { (window.plausible.q = window.plausible.q || []).push(arguments); };
  var s = document.createElement('script');
  s.defer = true;
  s.setAttribute('data-domain', cfg.plausibleDomain);
  s.src = cfg.plausibleSrc || 'https://plausible.io/js/script.js';
  document.head.appendChild(s);
})();
