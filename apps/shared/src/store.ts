// Durability, and detecting its loss (C3, D32). Slot state belongs to client/pool.ts; the app makes it
// durable through this store and keeps NO second record of which slots are spent.
//
// The epoch marker lives in localStorage while the ledger lives in IndexedDB, so that losing one of
// the two is *detectable* rather than invisible: a marker without a ledger is exactly the state that
// must block offline signing (13-RESEARCH-pwa.md rules 3–5).

import type { KeyValueStore } from '@vadum/client';

export const POOL_EPOCH_KEY = 'vadum:pool-epoch';
export const POOL_STATE_PREFIX = 'pool:';

/** The slice of `localStorage` this module uses, so the gate is testable without a browser. */
export interface MarkerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type LedgerState =
  /** No pool has ever been created on this device: onboarding, not recovery. */
  | 'empty'
  /** Marker and ledger agree: offline signing is allowed. */
  | 'ready'
  /** A pool is known to exist but its slot state is gone — RECOVERY (C3, T4). */
  | 'recovery';

/**
 * Pure: what the two records say together. Never guesses in the safe direction — a marker with no
 * ledger is RECOVERY, and signing a dead transaction is the one outcome that must not happen.
 */
export function assessLedger(input: { readonly epoch: string | null; readonly hasPoolState: boolean }): LedgerState {
  if (input.epoch === null) return input.hasPoolState ? 'recovery' : 'empty';
  return input.hasPoolState ? 'ready' : 'recovery';
}

export const readEpochMarker = (storage: MarkerStorage): string | null => storage.getItem(POOL_EPOCH_KEY);
export const writeEpochMarker = (storage: MarkerStorage, epoch: string): void => storage.setItem(POOL_EPOCH_KEY, epoch);
export const clearEpochMarker = (storage: MarkerStorage): void => storage.removeItem(POOL_EPOCH_KEY);

/** True when the store holds pool state for this payer. */
export const hasPoolState = async (store: KeyValueStore, payer: string): Promise<boolean> =>
  (await store.get(`${POOL_STATE_PREFIX}${payer}`)) !== undefined;

const request = <T>(operation: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error ?? new Error('IndexedDB request failed'));
  });

/**
 * IndexedDB, because it stores a non-extractable `CryptoKey` and structured-cloneable state as they
 * are (APP-2). `navigator.storage.persist()` is requested elsewhere, on first run.
 */
export function createIndexedDbStore(databaseName = 'vadum', storeName = 'kv'): KeyValueStore {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is unavailable: this build must run in a browser');

  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const opening = indexedDB.open(databaseName, 1);
      opening.onupgradeneeded = () => {
        if (!opening.result.objectStoreNames.contains(storeName)) opening.result.createObjectStore(storeName);
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error ?? new Error('IndexedDB could not be opened'));
    });

  const transact = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T> => {
    const database = await open();
    try {
      return await run(database.transaction(storeName, mode).objectStore(storeName));
    } finally {
      database.close();
    }
  };

  return {
    async get<T>(key: string): Promise<T | undefined> {
      return transact('readonly', async (store) => (await request<unknown>(store.get(key))) as T | undefined);
    },
    async set<T>(key: string, value: T): Promise<void> {
      await transact('readwrite', async (store) => request(store.put(value as unknown as IDBValidKey, key)));
    },
    async delete(key: string): Promise<void> {
      await transact('readwrite', async (store) => request(store.delete(key)));
    },
    async keys(prefix: string): Promise<readonly string[]> {
      return transact('readonly', async (store) => {
        const all = await request<IDBValidKey[]>(store.getAllKeys());
        return all.map(String).filter((key) => key.startsWith(prefix));
      });
    },
  };
}

/** Free, promptless, and granted automatically to an installed app (13-RESEARCH-pwa.md rule 2). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
