import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    manifest: true,
    target: 'es2023',
    // The scanner's .wasm stays a real, same-origin file and goes into the precache list (D10).
    assetsInlineLimit: 0,
  },
  server: { host: true },
});
