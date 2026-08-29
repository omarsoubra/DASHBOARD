// StrengthByO service worker
// ─────────────────────────────────────────────────────────────────────────
// Sprint 5.1 HARDENING: Network-first for HTML documents, cache-first only
// for immutable static assets. Prevents stale-shell serving after deploys.
// Bump CACHE_NAME on every shell change to force old SWs out.
// NEVER caches program JSON payloads (they live behind auth on Apps Script).
// ─────────────────────────────────────────────────────────────────────────
const CACHE_NAME = 'strengthbyo-v3-2026-08-29';
const STATIC_ASSETS = [
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
];

// Install: pre-cache only static (non-HTML) assets.
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
});

// Activate: drop every old cache version + claim all pages so the new SW
// takes over immediately without a second page reload.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => {
        // Nudge open pages to reload so the new shell gets fetched.
        clients.forEach((c) => {
          try { c.postMessage({ type: 'sw_updated', version: CACHE_NAME }); } catch (_) {}
        });
      })
  );
});

// Fetch strategy:
//   • HTML documents  → NETWORK-FIRST (falls back to cache when offline).
//     This is what fixes the stale-shell bug: a deploy is picked up on the
//     very next navigation, no manual cache-clear required.
//   • Static assets   → CACHE-FIRST (icons, manifest — rarely change).
//   • Cross-origin    → passthrough (never intercept Apps Script POSTs).
//   • Non-GET         → passthrough.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isDocument = req.destination === 'document' || req.mode === 'navigate';
  if (isDocument) {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).then((resp) => {
        if (resp && resp.ok) {
          // Update the cache in the background so we still have an offline
          // fallback, but the response the browser just got is always fresh.
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => caches.match(req).then((r) => r || caches.match('./')))
    );
    return;
  }

  // Static asset — cache-first, but revalidate in the background so we
  // pick up icon/manifest changes eventually.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req).then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// Notification handling (unchanged from v1).
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
