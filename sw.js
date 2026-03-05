const CACHE = 'disp-v1';
const OFFLINE = ['./index.html'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(OFFLINE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Uvijek pokušaj mrežu, fallback na cache
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
