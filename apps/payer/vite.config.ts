import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths so the app works under any origin path, including a static preview.
  base: './',
  build: {
    // scripts/build-precache.mjs reads this to build the service worker's precache list (C1).
    manifest: true,
    target: 'es2023',
    // The zxing .wasm must stay a real file, served same-origin and precached — never inlined and
    // never fetched from a CDN, which is what leaves the iOS scanner dead in airplane mode (D10).
    assetsInlineLimit: 0,
  },
  server: { host: true },
});
