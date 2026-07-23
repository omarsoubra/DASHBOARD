// StrengthByO service worker
// Cache-first strategy for the shell so client programs work offline once installed.
const CACHE_NAME = 'strengthbyo-v1';
const SHELL_ASSETS = [
  './',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GET, only same-origin. Do NOT cache POST or cross-origin (Apps Script) requests.
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        // Cache successful HTML/JS/CSS/image responses for offline fallback
        if (resp.ok && (req.destination === 'document' || req.destination === 'script' || req.destination === 'style' || req.destination === 'image')) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return resp;
      }).catch(() => caches.match('./'));
    })
  );
});

// Handle notification clicks (opens the app to the check-in section)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      const url = event.notification.data && event.notification.data.url ? event.notification.data.url : './';
      for (const c of clients) {
        if (c.url.indexOf(url) !== -1 && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
