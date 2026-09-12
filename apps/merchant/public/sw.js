// Service worker for the merchant app (C1). Plain JavaScript in `public/`, so it is copied verbatim to
// a stable URL with root scope. Identical in shape to the payer's: navigations are served from cache,
// which is what makes a cold start in airplane mode show the app instead of a browser error page.

const MANIFEST_URL = './precache-manifest.json';
const FALLBACK_CACHE = 'vadum-fallback';

const cacheNameFor = (version) => `vadum-merchant-${version}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const manifest = await (await fetch(MANIFEST_URL, { cache: 'no-cache' })).json();
      const cache = await caches.open(cacheNameFor(manifest.version));
      await cache.addAll([...manifest.files, MANIFEST_URL]);
      await (await caches.open(FALLBACK_CACHE)).put('active-cache', new Response(cacheNameFor(manifest.version)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const active = await activeCacheName();
      for (const name of await caches.keys()) {
        if (name !== active && name !== FALLBACK_CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

async function activeCacheName() {
  const stored = await (await caches.open(FALLBACK_CACHE)).match('active-cache');
  return stored === undefined ? null : stored.text();
}

async function cachedResponse(request) {
  const name = await activeCacheName();
  if (name === null) return undefined;
  const cache = await caches.open(name);
  return (await cache.match(request)) ?? (await cache.match(new URL(request.url).pathname));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const name = await activeCacheName();
        const cache = name === null ? null : await caches.open(name);
        const shell = cache === null ? undefined : ((await cache.match('./index.html')) ?? (await cache.match('/index.html')));
        try {
          return await fetch(request);
        } catch {
          if (shell !== undefined) return shell;
          throw new Error('offline and no cached shell');
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const hit = await cachedResponse(request);
      return hit ?? fetch(request);
    })(),
  );
});
