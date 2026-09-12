// The merchant till in a real browser: what it asks for before it will take money, what it warns
// about in a tab, and that the tier cap is refused in the DOM and not only in `client/queue.ts`.

import { expect, test } from '@playwright/test';
import { AS_INSTALLED, compatibleMintRecord, MERCHANT_URL, MINT_ADDRESS, seedStore } from './pwa.ts';

test('a till in a browser tab is told the queue can be deleted, and is not blocked (T4)', async ({ page }) => {
  await page.goto(MERCHANT_URL);

  // The merchant never signs, so the standalone gate does not block it — it warns, because a tab can
  // lose the queue of payments waiting to settle.
  await expect(page.getByRole('heading', { name: 'Add this till to your home screen' })).toBeVisible();
  await expect(page.getByText('the phone can delete the queue of payments waiting to settle')).toBeVisible();

  await page.getByRole('button', { name: 'Continue anyway' }).click();
  await expect(page.getByRole('heading', { name: 'Which token do you accept?' })).toBeVisible();
});

test('a till with no token chosen asks for one before it will take a payment', async ({ page }) => {
  await page.addInitScript(AS_INSTALLED);
  await page.goto(MERCHANT_URL);

  await expect(page.getByRole('heading', { name: 'Which token do you accept?' })).toBeVisible();
  await expect(page.getByText('Checking a token needs a connection once')).toBeVisible();
  // No way to enter an amount until a token is settled on.
  await expect(page.getByLabel('Amount')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show the request' })).toHaveCount(0);
});

test('the offline tier refuses a sale above its cap, before any code is shown (D23)', async ({ page }) => {
  await page.addInitScript(AS_INSTALLED);
  await page.goto(MERCHANT_URL);
  const records: readonly (readonly [string, unknown])[] = [
    [`mint:${MINT_ADDRESS}`, compatibleMintRecord()],
    ['settings:merchant', { mint: MINT_ADDRESS, tier: 'T2', includeCreateAta: true }],
  ];
  await page.evaluate(seedStore, records);
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Take a payment' })).toBeVisible();
  // T2's copy must state the unmitigated fraud path in plain words (31-PARAMETERS, caveat 3).
  await expect(page.getByText('A valid-looking code can be produced by someone with no account behind it')).toBeVisible();

  // The T2 cap is 5_000_000 base units, which formatAmount renders as "5" — trailing zeros trimmed.
  await page.getByLabel('Amount').fill('6');
  await page.getByRole('button', { name: 'Show the request' }).click();

  await expect(page.getByText('Accept offline allows at most 5.')).toBeVisible();
  // Refused before anything is rendered for the customer to scan.
  await expect(page.locator('img.qr')).toHaveCount(0);

  // And the same till takes a sale under the cap.
  await page.getByLabel('Amount').fill('4.50');
  await page.getByRole('button', { name: 'Show the request' }).click();
  await expect(page.locator('img.qr')).toBeVisible();
  await expect(page.getByRole('heading', { name: '4.5' })).toBeVisible();
});
