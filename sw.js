/**
 * IGNITE service worker
 *  - Offline fallback for gated pages
 *  - Receives Web Push notifications and displays them
 *  - Handles notification clicks (opens the app)
 */
const VERSION = 'ignite-v1';
const STATIC_CACHE = VERSION + '-static';
const OFFLINE_URL = '/offline.html';

const PRECACHE = [
  '/',
  '/index.html',
  '/quiz.html',
  '/login.html',
  '/app.html',
  '/workout.html',
  '/success.html',
  '/404.html',
  '/shared.js',
  '/manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // Best-effort precache — ignore fetch errors individually
    await Promise.all(PRECACHE.map(url =>
      cache.add(url).catch(err => console.warn('precache miss:', url, err.message))
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Clean up old caches
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  // Only handle GETs; let everything else pass through
  if (request.method !== 'GET') return;

  // Don't cache API calls
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return;

  // Network-first for HTML navigations (fall back to cache, then offline page)
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(STATIC_CACHE);
        cache.put(request, fresh.clone());
        return fresh;
      } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;
        const offline = await caches.match(OFFLINE_URL);
        return offline || Response.error();
      }
    })());
    return;
  }

  // Stale-while-revalidate for static assets (CSS/JS/images)
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const fetchPromise = fetch(request).then(resp => {
      if (resp && resp.status === 200) {
        caches.open(STATIC_CACHE).then(c => c.put(request, resp.clone())).catch(()=>{});
      }
      return resp;
    }).catch(() => cached);
    return cached || fetchPromise;
  })());
});

// ---------- PUSH ----------
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch(e){ payload = { title: 'IGNITE', body: event.data ? event.data.text() : '' }; }
  const {
    title = 'IGNITE 🔥',
    body = 'Your next move is ready.',
    url = '/app.html',
    tag = 'ignite-default',
    badge = '/icon-badge.png',
    icon = '/icon-192.png',
    actions = [],
    requireInteraction = false,
  } = payload;

  event.waitUntil(self.registration.showNotification(title, {
    body, tag, badge, icon, data: { url }, actions, requireInteraction,
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/app.html';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = all.find(c => c.url.includes(new URL(url, self.registration.scope).pathname));
    if (existing) { existing.focus(); existing.navigate(url).catch(()=>{}); return; }
    return self.clients.openWindow(url);
  })());
});
