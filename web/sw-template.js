// ScreenRate service worker (generated at build time by vite.config.js from sw-template.js).
// - App shell: precached, cache-first (versioned per build).
// - TMDB posters: runtime cache-first.
// - imdb.sqlite.enc: NOT handled here; the app keeps it in its own Cache Storage entry ("Update data").
const VERSION = '__VERSION__';
const ASSETS = __ASSETS__;
const SHELL = `screenrate-shell-${VERSION}`;
const RUNTIME = 'screenrate-runtime';
const RUNTIME_HOSTS = [/^image\.tmdb\.org$/];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['./', ...ASSETS])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('screenrate-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    if (url.pathname.endsWith('/imdb.sqlite.enc') || url.pathname.endsWith('/db-version.json')) return;
    if (req.mode === 'navigate') {
      e.respondWith(fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put('./', copy));
        return res;
      }).catch(() => caches.match('./')));
      return;
    }
    // cache-first; anything not precached lands here on first use
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  if (RUNTIME_HOSTS.some((re) => re.test(url.hostname))) {
    e.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      const hit = await cache.match(req, { ignoreVary: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && (res.type === 'basic' || res.type === 'cors')) cache.put(req, res.clone());
      return res;
    })());
  }
});
