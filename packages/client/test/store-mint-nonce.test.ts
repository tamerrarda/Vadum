// B6 offline half: the store seam, the mint cache's mutability-based staleness (D22), and the four
// pre-check verdicts (D21).

import type { Address } from '@solana/kit';
import type { RawMintData } from '@vadum/core';
import { NONCE_VALUE_NEXT } from '@vadum/fixtures';
import { describe, expect, it } from 'vitest';
import { createMintCache, MINT_CACHE_TTL_MS } from '../src/mint.ts';
import { precheckNonce } from '../src/nonce-check.ts';
import { createMemoryStore } from '../src/store.ts';
import { caseNamed, expectVadumError, fakeRpc, paymentOf } from './helpers.ts';

const USDC: RawMintData = {
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address,
  tokenProgram: 'spl-token',
  decimals: 6,
  freezeAuthority: '7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar' as Address,
  extensions: [],
};

const PAXOS = '2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk';
const USDG: RawMintData = {
  mint: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH' as Address,
  tokenProgram: 'token-2022',
  decimals: 6,
  freezeAuthority: PAXOS as Address,
  extensions: [
    { extension: 'transferHook', state: { authority: PAXOS, programId: null } },
    {
      extension: 'transferFeeConfig',
      state: { olderTransferFee: { transferFeeBasisPoints: 0 }, newerTransferFee: { transferFeeBasisPoints: 0 }, transferFeeConfigAuthority: PAXOS },
    },
  ],
};

describe('createMemoryStore', () => {
  it('isolates stored values from the caller’s object', async () => {
    const store = createMemoryStore();
    const value = { slots: [{ index: 0, state: 'unspent' }] };
    await store.set('pool:x', value);
    value.slots[0]!.state = 'spent';
    expect(await store.get<typeof value>('pool:x')).toEqual({ slots: [{ index: 0, state: 'unspent' }] });
  });

  it('lists keys by prefix and deletes', async () => {
    const store = createMemoryStore();
    await store.set('queue:payment:b', 1);
    await store.set('queue:payment:a', 2);
    await store.set('mint:x', 3);
    expect(await store.keys('queue:payment:')).toEqual(['queue:payment:a', 'queue:payment:b']);
    await store.delete('queue:payment:a');
    expect(await store.keys('queue:')).toEqual(['queue:payment:b']);
    expect(await store.get('queue:payment:a')).toBeUndefined();
  });
});

describe('createMintCache', () => {
  it('stores what core evaluates and reloads it from the store', async () => {
    const store = createMemoryStore();
    const cache = createMintCache(fakeRpc({ mint: USDC, fetchedAt: 1_000 }), store);
    expect(cache.get(USDC.mint)).toBeUndefined();
    const record = await cache.refresh(USDC.mint);
    expect(record).toMatchObject({ compatible: true, mutable: false, warnings: ['freeze-authority'], checkedAt: 1_000 });
    expect(cache.entries()).toEqual([record]);

    const reloaded = createMintCache(fakeRpc(), store);
    expect(await reloaded.load()).toEqual([record]);
    expect(reloaded.get(USDC.mint)).toEqual(record);
  });

  it('never stales an immutable mint, and stales a mutable one at the TTL (D22)', async () => {
    const usdc = createMintCache(fakeRpc({ mint: USDC, fetchedAt: 0 }), createMemoryStore());
    await usdc.refresh(USDC.mint);
    expect(usdc.staleness(USDC.mint, MINT_CACHE_TTL_MS * 365)).toBe('fresh');

    const usdg = createMintCache(fakeRpc({ mint: USDG, fetchedAt: 0 }), createMemoryStore());
    const record = await usdg.refresh(USDG.mint);
    expect(record.mutable).toBe(true);
    expect(usdg.staleness(USDG.mint, MINT_CACHE_TTL_MS - 1)).toBe('fresh');
    expect(usdg.staleness(USDG.mint, MINT_CACHE_TTL_MS)).toBe('stale-mutable');
    expect(usdg.staleness(USDC.mint, 0)).toBe('unknown');
  });

  it('propagates a mint that is not usable at all', async () => {
    const cache = createMintCache(fakeRpc(), createMemoryStore());
    await expectVadumError(() => cache.refresh(USDC.mint), 'MINT_INCOMPATIBLE');
  });
});

describe('precheckNonce (D21)', () => {
  const fixture = caseNamed('nonce-dynamic-spl-no-ata');

  const at = async (state: Parameters<typeof fakeRpc>[0] extends undefined ? never : NonNullable<Parameters<typeof fakeRpc>[0]>['nonceAccounts']) =>
    fakeRpc({ nonceAccounts: state });

  it('passes when the account holds exactly the claimed value', async () => {
    const payment = await paymentOf(fixture);
    const nonceRef = payment.input.nonceRef;
    if (nonceRef === null) throw new Error('expected a nonce-path fixture');
    const address = fixture.derived.nonceAddress;
    if (address === null) throw new Error('the fixture has no nonce address');
    const rpc = await at({ [address]: { kind: 'initialized', authority: payment.input.payer, value: nonceRef.value, lamports: 1_056_640n } });
    expect(await precheckNonce(rpc, payment)).toEqual({ ok: true, onChainValue: nonceRef.value });
  });

  it('separates a race from fraud', async () => {
    const payment = await paymentOf(fixture);
    const address = fixture.derived.nonceAddress as string;
    // The slot has advanced to the next value in the committed sequence: a race, not fraud.
    const moved = await at({
      [address]: { kind: 'initialized', authority: payment.input.payer, value: NONCE_VALUE_NEXT as never, lamports: 1n },
    });
    expect(await precheckNonce(moved, payment)).toEqual({ ok: false, reason: 'stale', onChainValue: NONCE_VALUE_NEXT });

    expect(await precheckNonce(await at({}), payment)).toEqual({ ok: false, reason: 'absent' });
    expect(await precheckNonce(await at({ [address]: { kind: 'uninitialized' } }), payment)).toEqual({ ok: false, reason: 'uninitialized' });

    const hijacked = await at({
      [address]: { kind: 'initialized', authority: payment.input.intent.merchant, value: payment.input.nonceRef?.value as never, lamports: 1n },
    });
    expect(await precheckNonce(hijacked, payment)).toEqual({ ok: false, reason: 'wrong-authority' });
  });

  it('does not apply to a fresh-blockhash payment', async () => {
    const payment = await paymentOf(caseNamed('fresh-dynamic-spl-no-ata'));
    await expectVadumError(() => precheckNonce(fakeRpc(), payment), 'INTERNAL_NOT_APPLICABLE');
  });
});
