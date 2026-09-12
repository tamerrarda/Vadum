// D40. Chromium only, against the *built* apps: the service worker, the precache manifest and the
// hashed asset names only exist after `pnpm build`, and they are most of what is worth testing here.
//
// Two preview servers, because each app is its own origin and a service worker's scope is rooted at
// the origin. Serving both from one static root would put `sw.js` on a subpath and the install would
// fetch the wrong `precache-manifest.json`.

import { defineConfig, devices } from '@playwright/test';

export const PAYER_PORT = 4173;
export const MERCHANT_PORT = 4174;

export default defineConfig({
  testDir: './test',
  // The offline tests reload one origin and inspect its caches, so they are not run concurrently
  // against each other.
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  reporter: process.env.CI !== undefined ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: { ...devices['Desktop Chrome'], serviceWorkers: 'allow', trace: 'retain-on-failure' },
  webServer: [
    {
      command: `pnpm -C ../payer exec vite preview --port ${PAYER_PORT} --strictPort`,
      url: `http://127.0.0.1:${PAYER_PORT}/`,
      reuseExistingServer: process.env.CI === undefined,
      timeout: 60_000,
    },
    {
      command: `pnpm -C ../merchant exec vite preview --port ${MERCHANT_PORT} --strictPort`,
      url: `http://127.0.0.1:${MERCHANT_PORT}/`,
      reuseExistingServer: process.env.CI === undefined,
      timeout: 60_000,
    },
  ],
});
