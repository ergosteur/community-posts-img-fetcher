const CACHE = 'ytc-img-saver-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
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
  const req = e.request;
  // App shell cache-first
  if (req.method === 'GET' && ASSETS.some(a => new URL(a, location).href === req.url)) {
    e.respondWith(caches.match(req).then(r => r || fetch(req)));
    return;
  }
  // Network-first for everything else
  e.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});