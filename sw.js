// Offline support.
// - App shell files are pre-cached per version and served cache-first.
// - Pages and js/config.js are network-first, so a deploy shows up as soon as you're online.
// - A new version waits until the user taps "Refresh" (see js/pwa.js), then takes over.
// CACHE must change on every release. Deploy builds stamp it with the commit (scripts/build.mjs);
// if you deploy without the build step, bump the number by hand.
const CACHE = 'shutterpaid-v9';
const ASSETS = [
  './',
  'index.html',
  'app.html',
  'book.html',
  'css/styles.css',
  'js/analytics.js',
  'js/beta.js',
  'js/core.js',
  'js/booking.js',
  'js/booking-setup.js',
  'js/markdown.js',
  'js/ics.js',
  'js/book.js',
  'js/schedule.js',
  'js/cloud.js',
  'js/app.js',
  'js/pwa.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];
// Third-party script hosts allowed into the cache so the app still boots offline.
const CDN_HOSTS = ['cdn.jsdelivr.net'];
const NETWORK_FIRST = /\/js\/config\.js$/;

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's HTTP cache so we never pre-cache a stale file.
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function put(request, response) {
  if (response && response.ok && (response.type === 'basic' || response.type === 'cors')) {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
}

function networkFirst(request) {
  return fetch(request)
    .then((res) => put(request, res))
    .catch(() => caches.match(request, { ignoreSearch: true }).then((cached) => cached || Response.error()));
}

function cacheFirst(request, ignoreSearch) {
  return caches.match(request, { ignoreSearch }).then((cached) => cached || fetch(request).then((res) => put(request, res)));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/sw.js')) return;
    if (req.mode === 'navigate' || NETWORK_FIRST.test(url.pathname)) event.respondWith(networkFirst(req));
    else event.respondWith(cacheFirst(req, true));
    return;
  }

  // Version-pinned CDN scripts never change, so cache-first is safe. API calls (Supabase and
  // anything else) are left alone and always go to the network.
  if (CDN_HOSTS.includes(url.hostname)) event.respondWith(cacheFirst(req, false));
});
