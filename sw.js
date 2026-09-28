// StrengthByO service worker
// ─────────────────────────────────────────────────────────────────────────
// Sprint 5.1 HARDENING: Network-first for HTML documents, cache-first only
// for immutable static assets. Prevents stale-shell serving after deploys.
// Bump CACHE_NAME on every shell change to force old SWs out.
// NEVER caches program JSON payloads (they live behind auth on Apps Script).
// ─────────────────────────────────────────────────────────────────────────
const CACHE_NAME = 'strengthbyo-v4-2026-08-30-pwa-refresh';
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

// ─────────────────────────────────────────────────────────────────────────
// LOCKED IN Push Notifications (minimal proof).
// A client shell registers THIS file with scope = its own folder
// (register('../../sw.js', { scope: './' })), so one worker file serves every
// client while each registration — and its push subscription — stays scoped
// to that one client's pages.
// ─────────────────────────────────────────────────────────────────────────

// A notification may only ever open a page inside this registration's scope.
// Anything else (other origin, other client's folder, javascript:, garbage)
// falls back to the scope root.
function _liSafeClickUrl(raw, scope) {
  try {
    const base = new URL(scope);
    const u = new URL(typeof raw === 'string' && raw ? raw : './', base);
    if (u.origin !== base.origin) return base.href;
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return base.href;
    if (!u.pathname.startsWith(base.pathname)) return base.href;
    return u.href;
  } catch (_) {
    return scope;
  }
}

// iOS revokes subscriptions whose pushes do not show a notification, so this
// ALWAYS shows one — even for an empty or malformed payload.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = {}; }
  if (!d || typeof d !== 'object') d = {};
  const scope = self.registration.scope;
  const title = (typeof d.title === 'string' && d.title.trim()) ? d.title.slice(0, 80) : 'LOCKED IN';
  const body = typeof d.body === 'string' ? d.body.slice(0, 240) : '';
  const tag = (typeof d.tag === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(d.tag)) ? d.tag : 'locked-in';
  const eventId = (typeof d.eventId === 'string' && d.eventId.length <= 64) ? d.eventId : null;
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    icon: new URL('icon-192.png', self.location.href).href,
    badge: new URL('icon-192.png', self.location.href).href,
    data: { url: _liSafeClickUrl(d.url, scope), eventId },
  }));
});

// Notification click → focus an open window of this scope, else open one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const scope = self.registration.scope;
  const target = _liSafeClickUrl(event.notification.data && event.notification.data.url, scope);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if (c.url && c.url.split('#')[0] === target.split('#')[0] && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
