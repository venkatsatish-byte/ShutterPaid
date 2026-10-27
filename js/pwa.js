// Service worker registration, the "new version available" prompt, and the "Install app" button.
(function () {
  let refreshRequested = false;
  if ('serviceWorker' in navigator) {
    // Reload once the new version takes over, but only when the user asked for it (the very first
    // install also changes the controller, and that must not reload the page).
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!refreshRequested) return;
      refreshRequested = false;
      window.location.reload();
    });

    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
        // A new version may already be installed and waiting from an earlier visit.
        if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
        reg.addEventListener('updatefound', function () {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener('statechange', function () {
            // Only prompt when replacing an old version, not on the very first install.
            if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate(worker);
          });
        });
        // Long-lived tabs and installed apps: look for updates when brought back to the front.
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') reg.update().catch(function () {});
        });
      }).catch(function (err) {
        console.warn('Service worker registration failed', err);
      });
    });
  }

  function showUpdate(worker) {
    let bar = document.getElementById('updateBanner');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'updateBanner';
      bar.className = 'update-banner';
      bar.setAttribute('role', 'status');
      bar.innerHTML = '<span>A new version of ShutterPaid is available.</span>' +
        '<button class="btn btn-sm btn-primary" type="button">Refresh</button>';
      document.body.appendChild(bar);
    }
    bar.hidden = false;
    bar.querySelector('button').onclick = function () {
      this.disabled = true;
      refreshRequested = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    };
  }

  var deferredPrompt = null;
  var installBtn = document.getElementById('installBtn');

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener('click', async function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.hidden = true;
    });
  }

  window.addEventListener('appinstalled', function () {
    if (installBtn) installBtn.hidden = true;
  });
})();
