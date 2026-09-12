// The payer app in a real browser: the gate that decides whether it will ever sign, what a cleared
// storage does to it, and whether the shell and the scanner's .wasm actually come back when the
// network is cut. None of this is visible to a Vitest run, and all of it is what the demo depends on.

import { expect, type Page, test } from '@playwright/test';
import { getBase58Decoder } from '@solana/kit';
import { AS_INSTALLED, exportIdentityPublicKey, MINT_ADDRESS, PAYER_URL, poolLedger, seedStore, SET_EPOCH_MARKER } from './pwa.ts';

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
  // The marker with no `pool:<payer>` record beside it is exactly that state.
  await page.addInitScript(AS_INSTALLED + SET_EPOCH_MARKER);
  await page.goto(PAYER_URL);

  // Held, then refused: the app has to stay on its own screen while a request is outstanding, and the
  // delay is what makes the intermediate state observable instead of transient.
  await page.route(/api\.devnet\.solana\.com/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.abort();
  });

  await expect(page.getByRole('heading', { name: 'Cannot pay offline — reconnect once to restore' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore from the network' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scan a payment request' })).toHaveCount(0);

  // That button used to be a dead end: every Pool method reads the ledger before the chain, so on the
  // one device this screen exists for, it could only ever throw NONCE_LEDGER_MISSING. It now falls
  // through to recovery from the derived addresses, which is a screen that reaches for the network.
  await page.getByRole('button', { name: 'Restore from the network' }).click();
  await expect(page.getByRole('heading', { name: 'Looking for your slots…' })).toBeVisible();
  // And with the network refused, it fails visibly rather than silently doing nothing.
  await expect(page.getByRole('heading', { name: /could not reach the network|that did not work|no record/i })).toBeVisible({ timeout: 30_000 });
});

test('a device with no checked token says so, and offers the screen that fixes it', async ({ page }) => {
  // No test here may reach devnet: if the app tries, the request fails fast rather than making CI
  // depend on a live cluster (D16).
  await page.route(/api\.devnet\.solana\.com/, (route) => route.abort());
  await page.addInitScript(AS_INSTALLED);
  await page.goto(PAYER_URL);

  // First boot creates the device identity, and its address names the pool ledger — so read the public
  // half back and seed a ledger. The alternative route to the home screen is onboarding, which needs
  // the network this test has just cut off.
  const publicKey = await page.evaluate(exportIdentityPublicKey);
  if (publicKey === null) throw new Error('the app did not create a device identity');
  const payer = getBase58Decoder().decode(new Uint8Array(publicKey));
  const records: readonly (readonly [string, unknown])[] = [[`pool:${payer}`, poolLedger(payer)]];
  await page.evaluate(seedStore, records);
  await page.addInitScript(SET_EPOCH_MARKER);
  await page.reload();

  await expect(page.getByText('No tokens checked yet')).toBeVisible();
  // Scanning a request with an empty mint cache could only ever end in MINT_UNKNOWN, so it is not
  // offered. Scanning a recovery code needs no mint and stays available.
  await expect(page.getByRole('button', { name: 'Scan a payment request' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Scan a recovery code' })).toBeEnabled();

  await page.getByRole('button', { name: 'Check a token' }).click();
  await expect(page.getByRole('heading', { name: 'Tokens you can pay with' })).toBeVisible();
  await expect(page.getByText('This device can only pay with a token it has checked online')).toBeVisible();

  // The button is wired to the network, which is blocked here: it must fail visibly rather than hang
  // or silently do nothing.
  await page.getByLabel('Mint address').fill(MINT_ADDRESS);
  await page.getByRole('button', { name: 'Check this token' }).click();
  await expect(page.getByRole('heading', { name: /could not reach the network|that did not work/i })).toBeVisible({ timeout: 30_000 });
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
