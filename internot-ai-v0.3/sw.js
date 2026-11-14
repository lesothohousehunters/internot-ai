// Internot AI service worker: makes the app open with no internet at all,
// and adds the two headers browsers need before they allow multi-threaded (fast) inference.
const VERSION = 'internot-v0.3.0';
const SHELL = ['./', './index.html', './style.css', './app.js', './maps.js', './mesh.js', './osmpbf.js', './map-worker.js', './vendor/qrcode.js', './vendor/jsqr.js', './icon.svg', './icon-192.png', './icon-512.png', './manifest.webmanifest',
  './vendor/wllama/index.js', './vendor/wllama/wllama.wasm'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function isolate(res) {
  if (!res || res.status === 0) return res; // opaque response: cannot be changed
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return; // e.g. the one-time model download
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return isolate(hit);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return isolate(res);
    } catch {
      if (req.mode === 'navigate') { const page = await cache.match('./index.html'); if (page) return isolate(page); }
      return new Response('Offline', { status: 503 });
    }
  })());
});
