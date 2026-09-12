// The payer app in a real browser: the gate that decides whether it will ever sign, what a cleared
// storage does to it, and whether the shell and the scanner's .wasm actually come back when the
// network is cut. None of this is visible to a Vitest run, and all of it is what the demo depends on.

import { expect, type Page, test } from '@playwright/test';
import { AS_INSTALLED, MARKER_WITHOUT_LEDGER, PAYER_URL } from './pwa.ts';

/** The worker is registered and never awaited at boot, so a test must wait for it to activate. */
const waitForActiveWorker = (page: Page): Promise<unknown> =>
  page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated', undefined, {
    timeout: 30_000,
  });

test('a browser tab offers no way to sign (T4, checklist step 9)', async ({ page }) => {
  await page.goto(PAYER_URL);

  await expect(page.getByRole('heading', { name: 'Install the app to pay offline' })).toBeVisible();
  await expect(page.getByText('In a browser tab the phone can delete this app')).toBeVisible();

  // The checklist is explicit that this is a check on the app, not on the platform: if a tab offers a
  // way to sign, that is a bug to fix before filming.
  await expect(page.getByRole('button', { name: 'Scan a payment request' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Scan a recovery code' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(sign|confirm and sign)$/i })).toHaveCount(0);
});

test('a marker with no ledger enters RECOVERY and still refuses to sign (C3, checklist step 10)', async ({ page }) => {
  // Exactly the state clearing site data leaves behind: the epoch marker in localStorage survives in
  // the mirror, the pool ledger in IndexedDB does not. `assessLedger` must call that RECOVERY rather
  // than treating it as a fresh device.
  await page.addInitScript(AS_INSTALLED + MARKER_WITHOUT_LEDGER);
  await page.goto(PAYER_URL);

  await expect(page.getByRole('heading', { name: 'Cannot pay offline — reconnect once to restore' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore from the network' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scan a payment request' })).toHaveCount(0);
});

test('the shell and every precached file survive the network being cut (D10, checklist step 3)', async ({ context, page }) => {
  await page.goto(PAYER_URL);
  await expect(page.getByRole('heading', { name: 'Install the app to pay offline' })).toBeVisible();
  await waitForActiveWorker(page);

  // D10's offline guarantee is precisely this: everything the build listed is in the cache, including
  // the scanner's .wasm, whose CDN default is what leaves the iOS scanner dead in airplane mode.
  const precached = await page.evaluate(async () => {
    const response = await caches.match('./precache-manifest.json');
    if (response === undefined) return null;
    const manifest = (await response.json()) as { readonly files: readonly string[] };
    const missing: string[] = [];
    for (const file of manifest.files) if ((await caches.match(file)) === undefined) missing.push(file);
    // A control: if `caches.match` resolved for anything at all, "nothing is missing" would be
    // meaningless. This path is in no manifest any build can produce.
    const bogusIsCached = (await caches.match('/no-build-ever-emits-this.js')) !== undefined;
    return { files: manifest.files, missing, bogusIsCached };
  });
  if (precached === null) throw new Error('the service worker never cached its own precache manifest');
  expect(precached.bogusIsCached).toBe(false);
  expect(precached.missing).toEqual([]);
  expect(precached.files).toContain('/index.html');
  expect(precached.files.some((file) => file.endsWith('.wasm'))).toBe(true);

  await context.setOffline(true);
  await page.reload();

  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  // A navigation request served from cache — the case that shows a browser error page when it fails.
  await expect(page.getByRole('heading', { name: 'Install the app to pay offline' })).toBeVisible();
});
