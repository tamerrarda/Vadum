// Shared rigging for the browser tests. Nothing here is a test hook inside the apps: both apps ship
// with no `data-testid`, no `?debug=` flag and no `window.*` export, so the tests drive them exactly
// as a user does — by role and by the copy on screen — and set up state through the same browser
// storage the apps themselves use.

export const PAYER_URL = 'http://127.0.0.1:4173/';
export const MERCHANT_URL = 'http://127.0.0.1:4174/';

/**
 * Makes the page look like an installed PWA. `apps/shared/src/standalone.ts` decides with
 * `navigator.standalone` and `matchMedia('(display-mode: standalone|fullscreen|minimal-ui)')`, which
 * is what this overrides — the same two signals, not a bypass of the gate itself.
 *
 * Runs as an init script, so it is in place before the app's module executes.
 */
export const AS_INSTALLED = `
  Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
  const realMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query) =>
    String(query).includes('display-mode: standalone')
      ? {
          matches: true,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent: () => false,
        }
      : realMatchMedia(query);
`;

/** The epoch marker without any pool ledger: `assessLedger` calls that RECOVERY (C3, checklist 10). */
export const MARKER_WITHOUT_LEDGER = `localStorage.setItem('vadum:pool-epoch', 'e2e-epoch');`;

/**
 * Writes records into the apps' own IndexedDB (`vadum` / `kv`, as `apps/shared/src/store.ts` opens
 * it). Called after a first load and followed by a reload, rather than from an init script: the app's
 * boot opens the same database, and a write racing that boot would be flaky rather than deterministic.
 */
export async function seedStore(records: readonly (readonly [string, unknown])[]): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open('vadum', 1);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains('kv')) opening.result.createObjectStore('kv');
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('kv', 'readwrite');
    const store = transaction.objectStore('kv');
    for (const [key, value] of records) store.put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

/** A devnet-shaped address. Never contacted: every test here runs with no network at all. */
export const MINT_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** What `evaluateMint` would have produced for a plain, compatible 6-decimal mint (`MintRecord`). */
export const compatibleMintRecord = (mint = MINT_ADDRESS) => ({
  mint,
  tokenProgram: 'spl-token',
  decimals: 6,
  compatible: true,
  blockers: [],
  warnings: [],
  // Immutable, so the cache never treats it as stale (D22) and the test needs no clock control.
  mutable: false,
  checkedAt: Date.now(),
});
