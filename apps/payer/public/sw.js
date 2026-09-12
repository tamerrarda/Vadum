// Service worker for the payer app (C1). Plain JavaScript in `public/`, so it is copied verbatim to a
// stable URL with root scope — a bundled, hashed service worker cannot do either.
//
// The two failure modes 13-RESEARCH-pwa.md names are what this file is shaped around:
//   1. a cold start in airplane mode needs the shell already cached and this worker already activated;
//   2. NAVIGATION requests must be served from cache, not just subresources — the single most common
//      cause of a white screen with the radio off.

const MANIFEST_URL = './precache-manifest.json';
const FALLBACK_CACHE = 'vadum-fallback';

const cacheNameFor = (version) => `vadum-${version}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // The build writes the file list and a version digest; nothing here is hand-maintained.
      const response = await fetch(MANIFEST_URL, { cache: 'no-cache' });
      const manifest = await response.json();
      const cache = await caches.open(cacheNameFor(manifest.version));
      await cache.addAll([...manifest.files, MANIFEST_URL]);
      await (await caches.open(FALLBACK_CACHE)).put('active-cache', new Response(cacheNameFor(manifest.version)));
      // Take over immediately: an app installed and then opened offline must not wait for a reload.
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

  // Navigations: cache first, and fall back to the cached shell for any path in scope. This is the
  // line that decides whether a cold start in airplane mode shows the app or a browser error page.
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

  // Everything else: cache first. The app's own assets never change without a new version, and the
  // scanner's .wasm must be served from here rather than from the network (D10).
  event.respondWith(
    (async () => {
      const hit = await cachedResponse(request);
      if (hit !== undefined) return hit;
      return fetch(request);
    })(),
  );
});
