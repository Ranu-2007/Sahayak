const CACHE = 'Sahayak-shell-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Never store API responses, account information, or operational records.
  if (url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(async response => {
      if (response.ok) {
        try { await caches.open(CACHE).then(cache => cache.put('/index.html', response.clone())); }
        catch { /* A cache quota or storage error should not block the network response. */ }
      }
      return response;
    }).catch(async () => (await caches.match('/index.html')) || (await caches.match('/'))));
    return;
  }
  event.respondWith(caches.match(request).then(cached => {
    if (cached) return cached;
    return fetch(request).then(async response => {
      if (response.ok && response.type === 'basic') {
        try { await caches.open(CACHE).then(cache => cache.put(request, response.clone())); }
        catch { /* Preserve the successful response when the browser cannot cache it. */ }
      }
      return response;
    });
  }));
});
