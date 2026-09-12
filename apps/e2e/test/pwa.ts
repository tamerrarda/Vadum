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

/**
 * Writes the epoch marker. With no `pool:<payer>` record beside it, `assessLedger` calls that RECOVERY
 * (C3, checklist step 10); with one, the app reaches its home screen.
 */
export const SET_EPOCH_MARKER = `localStorage.setItem('vadum:pool-epoch', 'e2e-epoch');`;

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

/**
 * Reads back the device identity's **public** key. The private half is generated non-extractable
 * (`apps/shared/src/keys.ts`) and stays that way; the public half exports fine, and its 32 bytes are
 * the payer address every `pool:<payer>` key is named after. Without this a test cannot seed a pool
 * ledger, because the address is generated in the browser and shown only in truncated form.
 */
export async function exportIdentityPublicKey(): Promise<readonly number[] | null> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open('vadum', 1);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains('kv')) opening.result.createObjectStore('kv');
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  const pair = await new Promise<CryptoKeyPair | undefined>((resolve, reject) => {
    const request = database.transaction('kv', 'readonly').objectStore('kv').get('identity:keypair');
    request.onsuccess = () => resolve(request.result as CryptoKeyPair | undefined);
    request.onerror = () => reject(request.error);
  });
  database.close();
  if (pair?.publicKey === undefined) return null;
  return [...new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))];
}

/**
 * A pool ledger in the shape `client/pool.ts` persists. Slot addresses are the payer's own, which is
 * never read: nothing in these tests goes on chain, and an offline home screen only counts states.
 */
export const poolLedger = (payer: string, size = 5) => ({
  payer,
  size,
  epoch: 'e2e-epoch',
  slots: Array.from({ length: size }, (_unused, index) => ({ index, address: payer, value: null, state: 'unspent' })),
});

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
