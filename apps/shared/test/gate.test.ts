// C3's gate, tested without a browser: what the two storage records say together, and when the app is
// allowed to sign offline at all (T4, 13-RESEARCH-pwa.md).

import { createMemoryStore } from '@vadum/client';
import { describe, expect, it } from 'vitest';
import { canSignOffline, isStandalone, signingBlock, type DisplayEnvironment } from '../src/standalone.ts';
import { assessLedger, hasPoolState, POOL_EPOCH_KEY, readEpochMarker, writeEpochMarker, type MarkerStorage } from '../src/store.ts';

const memoryMarkers = (): MarkerStorage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
};

const environment = (matches: readonly string[], navigatorStandalone?: boolean): DisplayEnvironment => ({
  matchMedia: (query) => ({ matches: matches.includes(query) }),
  navigatorStandalone,
});

describe('assessLedger', () => {
  it('separates a device that never had a pool from one that lost its ledger', () => {
    expect(assessLedger({ epoch: null, hasPoolState: false })).toBe('empty');
    expect(assessLedger({ epoch: 'e1', hasPoolState: true })).toBe('ready');
    // The state C3 exists for: the marker survived, the ledger did not.
    expect(assessLedger({ epoch: 'e1', hasPoolState: false })).toBe('recovery');
    // And the mirror image: a ledger with no marker is just as untrustworthy.
    expect(assessLedger({ epoch: null, hasPoolState: true })).toBe('recovery');
  });

  it('reads pool state through the same store client/pool.ts writes (D32)', async () => {
    const store = createMemoryStore();
    expect(await hasPoolState(store, 'payer1')).toBe(false);
    await store.set('pool:payer1', { size: 5 });
    expect(await hasPoolState(store, 'payer1')).toBe(true);
    expect(await hasPoolState(store, 'payer2')).toBe(false);
  });

  it('mirrors the epoch marker separately from the ledger', () => {
    const markers = memoryMarkers();
    expect(readEpochMarker(markers)).toBeNull();
    writeEpochMarker(markers, 'epoch-1');
    expect(readEpochMarker(markers)).toBe('epoch-1');
    expect(POOL_EPOCH_KEY).toBe('vadum:pool-epoch');
  });
});

describe('standalone detection (APP-6)', () => {
  it('accepts every installed display mode, and iOS’s own flag', () => {
    expect(isStandalone(environment(['(display-mode: standalone)']))).toBe(true);
    expect(isStandalone(environment(['(display-mode: fullscreen)']))).toBe(true);
    expect(isStandalone(environment(['(display-mode: minimal-ui)']))).toBe(true);
    expect(isStandalone(environment([], true))).toBe(true);
  });

  it('treats a browser tab as a browser tab', () => {
    expect(isStandalone(environment(['(display-mode: browser)']))).toBe(false);
    expect(isStandalone(environment([], false))).toBe(false);
    expect(isStandalone({})).toBe(false);
  });
});

describe('signingBlock', () => {
  it('refuses to sign in a tab, whatever the ledger says (T4)', () => {
    expect(signingBlock({ standalone: false, ledger: 'ready' })).toBe('not-installed');
    expect(signingBlock({ standalone: false, ledger: 'recovery' })).toBe('not-installed');
    expect(canSignOffline({ standalone: false, ledger: 'ready' })).toBe(false);
  });

  it('refuses to sign without a ledger, even when installed', () => {
    expect(signingBlock({ standalone: true, ledger: 'recovery' })).toBe('ledger-missing');
    expect(signingBlock({ standalone: true, ledger: 'empty' })).toBe('ledger-missing');
  });

  it('allows signing only when installed with a ledger', () => {
    expect(signingBlock({ standalone: true, ledger: 'ready' })).toBeNull();
    expect(canSignOffline({ standalone: true, ledger: 'ready' })).toBe(true);
  });
});
