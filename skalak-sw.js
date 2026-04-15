/* Offline cache: ugyanazon mappából szolgáld ki (http/https). file:// nem támogatott. */
const CACHE = 'akira-workshop-v1';
const PRECACHE = ['./skalak.html', './grandpiano-keys.png', './manifest-workshop.json'];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE).then(cache =>
            Promise.all(
                PRECACHE.map(url =>
                    cache.add(url).catch(() => {})
                )
            ).then(() => self.skipWaiting())
        )
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== location.origin) return;
    const p = url.pathname;
    if (!/skalak\.html|grandpiano-keys\.png|manifest-workshop\.json/i.test(p)) return;
    event.respondWith(
        caches.match(req).then(cached => cached || fetch(req).then(resp => {
            const copy = resp.clone();
            if (resp.ok) caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
            return resp;
        }))
    );
});
