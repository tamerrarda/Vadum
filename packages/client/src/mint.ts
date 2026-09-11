// The mint compatibility cache. Staleness follows mint mutability, not the clock (D22): a flat TTL
// would mean a payer can pay offline only within a day of last being online, which deletes the
// disaster-zone and rural-vendor scenarios the project exists for.

import type { Address } from '@solana/kit';
import { evaluateMint, type MintRecord } from '@vadum/core';
import type { VadumRpc } from './rpc.ts';
import type { KeyValueStore } from './store.ts';

/** 24 h, and it applies to mutable mints only — where it warns and caps rather than hard-blocking. */
export const MINT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type MintStaleness = 'fresh' | 'stale-mutable' | 'unknown';

export interface MintCache {
  get(mint: Address): MintRecord | undefined;
  /** Online. Fetches with encoding 'jsonParsed' and calls core.evaluateMint(raw, fetchedAt) (D34). */
  refresh(mint: Address): Promise<MintRecord>;
  staleness(mint: Address, now: number): MintStaleness;
  entries(): readonly MintRecord[];
  /** Loads what the store already holds; the payer app calls it before going offline. */
  load(): Promise<readonly MintRecord[]>;
}

const KEY_PREFIX = 'mint:';

export function createMintCache(rpc: VadumRpc, store: KeyValueStore): MintCache {
  const records = new Map<Address, MintRecord>();

  return {
    get(mint) {
      return records.get(mint);
    },

    async refresh(mint) {
      const { raw, fetchedAt } = await rpc.getMintAccount(mint);
      const record = evaluateMint(raw, fetchedAt);
      records.set(mint, record);
      await store.set(`${KEY_PREFIX}${mint}`, record);
      return record;
    },

    staleness(mint, now) {
      const record = records.get(mint);
      if (record === undefined) return 'unknown';
      // An immutable mint's verdict cannot change without a mint upgrade, so it never goes stale.
      if (!record.mutable) return 'fresh';
      return now - record.checkedAt >= MINT_CACHE_TTL_MS ? 'stale-mutable' : 'fresh';
    },

    entries() {
      return [...records.values()];
    },

    async load() {
      for (const key of await store.keys(KEY_PREFIX)) {
        const record = await store.get<MintRecord>(key);
        if (record !== undefined) records.set(record.mint, record);
      }
      return [...records.values()];
    },
  };
}
