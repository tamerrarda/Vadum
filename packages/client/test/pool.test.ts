// B8: pool lifecycle and slot state, the one owner of "is this slot spent" (D32).

import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getBase58Decoder, type Address, type Nonce } from '@solana/kit';
import { deriveNonceAddress, signNonceReturn } from '@vadum/core';
import { MERCHANT_SEED, PAYER_SEED, PAYER2_SEED } from '@vadum/fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPool, DEFAULT_SPEND_LIMIT, LAMPORTS_PER_SIGNATURE, POOL_LOW_WATER_MARK, SEND_WINDOW_MS, SPEND_LIMIT_WINDOW_MS, type Pool } from '../src/pool.ts';
import type { NonceAccountState } from '../src/rpc.ts';
import { createMemoryStore, type KeyValueStore } from '../src/store.ts';
import { expectVadumError, fakeRpc, type FakeRpc } from './helpers.ts';

const NONCE_RENT = 1_056_640n;
const WALLET_RENT = 890_880n;
const SIZE = 3;
/** One base-unit amount per reservation, far inside the default spend limit. */
const PAY = 1_000_000n;

/** A distinct, real 32-byte nonce value: the recovery statement decodes these, so they must be valid. */
const value = (seed: number): Nonce =>
  getBase58Decoder().decode(Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? seed : index + 1))) as string as Nonce;

let payerKey: CryptoKeyPair;
let payer: Address;
let merchantKey: CryptoKeyPair;
let merchant: Address;
let addresses: Address[];

beforeEach(async () => {
  payerKey = await createKeyPairFromPrivateKeyBytes(PAYER_SEED);
  payer = await getAddressFromPublicKey(payerKey.publicKey);
  merchantKey = await createKeyPairFromPrivateKeyBytes(MERCHANT_SEED);
  merchant = await getAddressFromPublicKey(merchantKey.publicKey);
  addresses = await Promise.all([0, 1, 2].map((index) => deriveNonceAddress(payer, index)));
});

const initialized = (address: Address, nonce: Nonce, authority: Address = payer): Record<string, NonceAccountState> => ({
  [address]: { kind: 'initialized', authority, value: nonce, lamports: NONCE_RENT },
});

const liveAccounts = (): Record<string, NonceAccountState> =>
  Object.assign({}, ...addresses.map((address, index) => initialized(address, value(index)))) as Record<string, NonceAccountState>;

/** A created, funded pool of three slots, each holding a distinct value. */
async function createdPool(
  store: KeyValueStore = createMemoryStore(),
  options?: Parameters<typeof createPool>[3],
): Promise<{ pool: Pool; rpc: FakeRpc; store: KeyValueStore }> {
  const rpc = fakeRpc({ balance: NONCE_RENT * BigInt(SIZE) + LAMPORTS_PER_SIGNATURE, nonceRent: NONCE_RENT, walletRent: WALLET_RENT, nonceAccounts: liveAccounts() });
  const pool = createPool(rpc, payer, store, options);
  await pool.create(SIZE, payerKey);
  return { pool, rpc, store };
}

describe('recover', () => {
  it('rebuilds a lost ledger from the derived addresses, and every slot comes back unknown', async () => {
    const rpc = fakeRpc({ nonceAccounts: liveAccounts(), nonceRent: NONCE_RENT, walletRent: WALLET_RENT, balance: WALLET_RENT + LAMPORTS_PER_SIGNATURE });
    // An empty store is the state a wiped device is in: the chain still holds the slots.
    const pool = createPool(rpc, payer, createMemoryStore());
    await expectVadumError(() => pool.load(), 'NONCE_LEDGER_MISSING');

    const status = await pool.recover();
    expect(status.slots.map((slot) => slot.state)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(status.slots.map((slot) => slot.value)).toEqual([value(0), value(1), value(2)]);
    expect(status.unspentCount).toBe(0);

    // Unknown history, so nothing may be signed against it…
    await expectVadumError(() => pool.reserveSlot(merchant, 0, PAY), 'NONCE_POOL_EXHAUSTED');
    // …but the deposit comes back, which is what was impossible while `close` threw on a lost ledger.
    expect((await pool.close(payerKey)).refundedLamports).toBe(NONCE_RENT * BigInt(SIZE));
  });

  it('skips an account whose authority is no longer the payer', async () => {
    const rpc = fakeRpc({
      // The second slot's authority was moved away: this pool can neither advance nor withdraw it, so
      // adopting it would promise a refund that cannot happen.
      nonceAccounts: { ...initialized(addresses[0]!, value(0)), ...initialized(addresses[1]!, value(1), merchant) },
      nonceRent: NONCE_RENT,
    });
    const status = await createPool(rpc, payer, createMemoryStore()).recover();
    expect(status.slots.map((slot) => slot.index)).toEqual([0]);
  });

  it('throws rather than persisting an empty pool when the payer has no slots on chain', async () => {
    const pool = createPool(fakeRpc({ nonceRent: NONCE_RENT }), payer, createMemoryStore());
    await expectVadumError(() => pool.recover(), 'NONCE_LEDGER_MISSING', { payer });
  });
});

describe('estimateSetupCost', () => {
  it('reads rent at call time and prices one signature (D7, D26)', async () => {
    const pool = createPool(fakeRpc({ nonceRent: NONCE_RENT, walletRent: WALLET_RENT }), payer, createMemoryStore());
    expect(await pool.estimateSetupCost(5)).toEqual({ nonceRent: NONCE_RENT * 5n, fee: LAMPORTS_PER_SIGNATURE, walletMinimum: WALLET_RENT });
  });
});

describe('create', () => {
  it('sends two instructions per slot, and the payer is the only signer (D26)', async () => {
    const { pool, rpc } = await createdPool();
    expect(rpc.setups.length).toBe(1);
    expect(rpc.setups[0]?.instructions.length).toBe(SIZE * 2);
    expect(rpc.setups[0]?.feePayerKey).toBe(payerKey);
    // Nothing but the payer signs: no sponsor, no two-party ceremony (D26, SOL-5b).
    const signerAddresses = new Set(
      (rpc.setups[0]?.instructions ?? []).flatMap((instruction) =>
        (instruction.accounts ?? []).filter((account) => account.role === 2 || account.role === 3).map((account) => account.address),
      ),
    );
    expect([...signerAddresses]).toEqual([payer]);
    const status = pool.status();
    expect(status.size).toBe(SIZE);
    expect(status.slots.map((slot) => slot.address)).toEqual(addresses);
    expect(status.slots.map((slot) => slot.value)).toEqual([value(0), value(1), value(2)]);
    expect(status.unspentCount).toBe(SIZE);
    expect(status.belowLowWaterMark).toBe(SIZE <= POOL_LOW_WATER_MARK);
    expect(status.epoch).not.toBe('');
  });

  it('refuses to send when the wallet cannot end the transaction at zero or rent-exempt (D38)', async () => {
    const required = NONCE_RENT * BigInt(SIZE) + LAMPORTS_PER_SIGNATURE;
    for (const balance of [0n, required - 1n, required + 1n, required + WALLET_RENT - 1n]) {
      const rpc = fakeRpc({ balance, nonceRent: NONCE_RENT, walletRent: WALLET_RENT });
      const pool = createPool(rpc, payer, createMemoryStore());
      await expectVadumError(() => pool.create(SIZE, payerKey), 'NONCE_POOL_UNDERFUNDED', { balance: balance.toString() });
      expect(rpc.setups.length, 'nothing may be sent').toBe(0);
    }
  });

  it('accepts a wallet that ends at zero and one that stays rent-exempt', async () => {
    const required = NONCE_RENT * BigInt(SIZE) + LAMPORTS_PER_SIGNATURE;
    for (const balance of [required, required + WALLET_RENT]) {
      const rpc = fakeRpc({ balance, nonceRent: NONCE_RENT, walletRent: WALLET_RENT, nonceAccounts: liveAccounts() });
      const pool = createPool(rpc, payer, createMemoryStore());
      expect((await pool.create(SIZE, payerKey)).size).toBe(SIZE);
    }
  });

  it('refuses a key that is not the pool’s payer', async () => {
    const rpc = fakeRpc({ balance: 10n ** 12n, nonceRent: NONCE_RENT, walletRent: WALLET_RENT });
    const pool = createPool(rpc, payer, createMemoryStore());
    await expectVadumError(async () => pool.create(SIZE, await createKeyPairFromPrivateKeyBytes(PAYER2_SEED)), 'CANON_ACCOUNT_MISMATCH');
    expect(rpc.setups.length).toBe(0);
  });
});

describe('reserveSlot', () => {
  it('takes the lowest unspent slot and persists before resolving (D32)', async () => {
    const store = createMemoryStore();
    const { pool } = await createdPool(store);
    const reserved = await pool.reserveSlot(merchant, 1_000, PAY);
    expect(reserved).toEqual({ index: 0, value: value(0) });

    // What a crash right after signing would leave behind: the store already says spent.
    const persisted = await store.get<{ slots: { index: number; state: string; spentAgainst?: { merchant: string } }[] }>(`pool:${payer}`);
    expect(persisted?.slots[0]).toMatchObject({ state: 'spent', spentAgainst: { merchant, at: 1_000 } });
    expect((await pool.reserveSlot(merchant, 1_001, PAY)).index).toBe(1);
    expect(pool.status().unspentCount).toBe(1);
  });

  it('throws NONCE_POOL_EXHAUSTED when every slot is spent, and NONCE_LEDGER_MISSING with no ledger', async () => {
    const { pool } = await createdPool();
    for (let index = 0; index < SIZE; index++) await pool.reserveSlot(merchant, index, PAY);
    await expectVadumError(() => pool.reserveSlot(merchant, 9, PAY), 'NONCE_POOL_EXHAUSTED');

    const empty = createPool(fakeRpc(), payer, createMemoryStore());
    await expectVadumError(() => empty.reserveSlot(merchant, 0, PAY), 'NONCE_LEDGER_MISSING');
    await expectVadumError(() => empty.load(), 'NONCE_LEDGER_MISSING');
    expect(() => empty.status()).toThrow();
  });
});

describe('the spend limit (T12, REV-17)', () => {
  /** Every slot's value moves on chain, as it does when a merchant settles each payment. */
  const settleAll = (rpc: FakeRpc, seed: number): void => {
    rpc.nonceAccounts = Object.assign({}, ...addresses.map((address, index) => initialized(address, value(seed + index)))) as Record<string, NonceAccountState>;
  };

  it('is not refilled by reconnecting — the loop that made the old bound false', async () => {
    // Default limit and the payer app's own cap, so the numbers are the published ones.
    const CAP = 20_000_000n;
    const { pool, rpc, store } = await createdPool();
    for (let index = 0; index < SIZE; index++) await pool.reserveSlot(merchant, 0, CAP);

    // What a thief holding the phone does: runs the merchant app, settles, taps "Refresh from the
    // network". Every slot comes back — and under the old bound, so did every cap's worth of allowance.
    settleAll(rpc, 10);
    expect((await pool.reconcile(1)).settled).toEqual([0, 1, 2]);
    expect(pool.status().unspentCount).toBe(SIZE);

    await pool.reserveSlot(merchant, 2, CAP);
    await pool.reserveSlot(merchant, 3, CAP);
    expect(await pool.allowance(3)).toEqual({ limit: DEFAULT_SPEND_LIMIT, spent: DEFAULT_SPEND_LIMIT, remaining: 0n, nextRefillAt: SPEND_LIMIT_WINDOW_MS });

    // A slot is free, the payment is one base unit, and it is still refused — before anything is
    // persisted, so the refusal costs the payer no slot.
    const before = await store.get(`pool:${payer}`);
    await expectVadumError(() => pool.reserveSlot(merchant, 4, 1n), 'LIMIT_PAYER_ALLOWANCE', { spent: '100000000', limit: '100000000' });
    expect(pool.status().unspentCount).toBe(1);
    expect(await store.get(`pool:${payer}`)).toEqual(before);
  });

  it('is not refilled by a nonce return, by closing and re-creating the pool, or by recovering it', async () => {
    const store = createMemoryStore();
    const { pool } = await createdPool(store, { spendLimit: 2n * PAY });
    await pool.reserveSlot(merchant, 1_000, PAY);
    await pool.reserveSlot(merchant, 1_000, PAY);

    const signature = await signNonceReturn({ payer, nonceIndex: 0, spentAgainstValue: value(0), newNonceValue: value(9) }, merchantKey);
    await pool.applyNonceReturn({ nonceIndex: 0, newNonceValue: value(9), signature });
    expect((await pool.allowance(1_000)).remaining).toBe(0n);

    // The refunded rent lands in the wallet the thief is holding, so a fresh pool costs them nothing.
    await pool.close(payerKey);
    await pool.create(SIZE, payerKey);
    expect((await pool.allowance(1_000)).remaining).toBe(0n);
    await expectVadumError(() => pool.reserveSlot(merchant, 1_000, PAY), 'LIMIT_PAYER_ALLOWANCE');

    await pool.recover();
    expect((await createPool(fakeRpc(), payer, store, { spendLimit: 2n * PAY }).allowance(1_000)).spent).toBe(2n * PAY);
  });

  it('refills only as payments leave the window, and winding the clock back gives nothing back', async () => {
    const { pool } = await createdPool(createMemoryStore(), { spendLimit: 2n * PAY });
    await pool.reserveSlot(merchant, 1_000, PAY);
    await pool.reserveSlot(merchant, 5_000, PAY);
    expect(await pool.allowance(5_000)).toEqual({ limit: 2n * PAY, spent: 2n * PAY, remaining: 0n, nextRefillAt: 1_000 + SPEND_LIMIT_WINDOW_MS });

    // Exactly a window after the first payment it no longer counts, and the whole remainder is usable.
    const later = 1_000 + SPEND_LIMIT_WINDOW_MS;
    expect(await pool.allowance(later)).toMatchObject({ spent: PAY, remaining: PAY, nextRefillAt: 5_000 + SPEND_LIMIT_WINDOW_MS });
    await pool.reserveSlot(merchant, later, PAY);

    // Set the clock back to before any of it: entries in the future still count.
    expect((await pool.allowance(0)).remaining).toBe(0n);
  });

  it('refuses a zero or negative amount, which would lower the total instead of adding to it', async () => {
    const { pool } = await createdPool();
    for (const amount of [0n, -PAY]) await expectVadumError(() => pool.reserveSlot(merchant, 0, amount), 'LIMIT_PAYER_ALLOWANCE');
    expect(pool.status().unspentCount).toBe(SIZE);
    expect((await pool.allowance(0)).spent).toBe(0n);
  });

  it('treats a ledger written before the limit existed as having spent nothing', async () => {
    const store = createMemoryStore();
    await store.set(`pool:${payer}`, { payer, size: 1, epoch: 'old', slots: [{ index: 0, address: addresses[0], value: value(0), state: 'unspent' }] });
    const pool = createPool(fakeRpc(), payer, store);
    expect(await pool.allowance(0)).toEqual({ limit: DEFAULT_SPEND_LIMIT, spent: 0n, remaining: DEFAULT_SPEND_LIMIT, nextRefillAt: null });
    expect((await pool.reserveSlot(merchant, 0, PAY)).index).toBe(0);
  });
});

describe('applyNonceReturn (rule 12, D28)', () => {
  const payload = async (index: number, spentAgainst: Nonce, newValue: Nonce, key = merchantKey) => ({
    nonceIndex: index,
    newNonceValue: newValue,
    signature: await signNonceReturn({ payer, nonceIndex: index, spentAgainstValue: spentAgainst, newNonceValue: newValue }, key),
  });

  it('re-arms the slot only for a return signed by the recorded merchant', async () => {
    const { pool } = await createdPool();
    await pool.reserveSlot(merchant, 1_000, PAY);
    const status = await pool.applyNonceReturn(await payload(0, value(0), value(9)));
    expect(status.slots[0]).toEqual({ index: 0, address: addresses[0], value: value(9), state: 'unspent' });
    expect(status.unspentCount).toBe(SIZE);
  });

  it('changes nothing when the signature, payer or prior value is wrong', async () => {
    const { pool } = await createdPool();
    await pool.reserveSlot(merchant, 1_000, PAY);
    const otherKey = await createKeyPairFromPrivateKeyBytes(PAYER2_SEED);

    for (const bad of [
      await payload(0, value(0), value(9), otherKey), // another signer
      await payload(0, value(5), value(9)), // another prior value
      await payload(0, value(0), value(0)), // unchanged value (SOL-8)
    ]) {
      await expectVadumError(() => pool.applyNonceReturn(bad), 'NONCE_RETURN_UNTRUSTED');
      expect(pool.status().slots[0]).toMatchObject({ state: 'spent' });
    }
  });

  it('refuses a return for a slot the ledger does not record as spent', async () => {
    const { pool } = await createdPool();
    const forUnspentSlot = await payload(1, value(1), value(9));
    const forMissingSlot = await payload(7, value(1), value(9));
    await expectVadumError(() => pool.applyNonceReturn(forUnspentSlot), 'NONCE_RETURN_UNTRUSTED');
    await expectVadumError(() => pool.applyNonceReturn(forMissingSlot), 'NONCE_RETURN_UNTRUSTED');
  });
});

describe('refresh and close', () => {
  it('re-reads values without touching slot state', async () => {
    const { pool, rpc } = await createdPool();
    await pool.reserveSlot(merchant, 1_000, PAY);
    rpc.nonceAccounts = { ...rpc.nonceAccounts, ...initialized(addresses[0]!, value(42)) };
    const status = await pool.refresh();
    expect(status.slots[0]).toMatchObject({ value: value(42), state: 'spent' });
    expect(status.unspentCount).toBe(SIZE - 1);
  });

  it('withdraws every live slot and reports the refund (D26)', async () => {
    const { pool, rpc } = await createdPool();
    const { refundedLamports } = await pool.close(payerKey);
    expect(refundedLamports).toBe(NONCE_RENT * BigInt(SIZE));
    expect(rpc.setups.length).toBe(2);
    expect(rpc.setups[1]?.instructions.length).toBe(SIZE);
    // A closed pool is not a missing ledger (T7).
    expect(pool.status().slots.every((slot) => slot.state === 'unknown' && slot.value === null)).toBe(true);
  });
});

describe('reconcile (NONCE_DESYNC, D32)', () => {
  it('re-arms settled slots, releases abandoned ones, and keeps pending ones spent', async () => {
    const { pool, rpc } = await createdPool();
    await pool.reserveSlot(merchant, 0, PAY); // slot 0 — will be settled
    await pool.reserveSlot(merchant, 0, PAY); // slot 1 — abandoned past the window
    await pool.reserveSlot(merchant, SEND_WINDOW_MS, PAY); // slot 2 — still inside the window

    rpc.nonceAccounts = { ...rpc.nonceAccounts, ...initialized(addresses[0]!, value(7)) };
    const outcome = await pool.reconcile(SEND_WINDOW_MS + 1);
    expect(outcome).toEqual({ settled: [0], released: [1], stillPending: [2] });

    const slots = pool.status().slots;
    expect(slots[0]).toEqual({ index: 0, address: addresses[0], value: value(7), state: 'unspent' });
    // Released rather than settled: the value never moved, so the slot is marked and reused last.
    expect(slots[1]).toEqual({ index: 1, address: addresses[1], value: value(1), state: 'unspent', releasedAt: SEND_WINDOW_MS + 1 });
    expect(slots[2]).toMatchObject({ state: 'spent' });
    expect(pool.status().unspentCount).toBe(2);
  });

  it('releases a slot whose account the payer has closed (T7)', async () => {
    const { pool, rpc } = await createdPool();
    await pool.reserveSlot(merchant, 0, PAY);
    rpc.nonceAccounts = {};
    expect(await pool.reconcile(1)).toEqual({ settled: [], released: [0], stillPending: [] });
    expect(pool.status().slots[0]).toEqual({ index: 0, address: addresses[0], value: null, state: 'unknown' });
  });

  it('survives a reload: slot state lives in the store, not in memory', async () => {
    const store = createMemoryStore();
    const { pool, rpc } = await createdPool(store);
    await pool.reserveSlot(merchant, 1_000, PAY);
    const reopened = createPool(rpc, payer, store);
    expect((await reopened.load()).slots[0]).toMatchObject({ state: 'spent', spentAgainst: { merchant } });
  });
});

describe('released slots are reused last (NONCE-9)', () => {
  it('prefers a slot that was never released', async () => {
    const { pool } = await createdPool();
    // Slot 0 is spent and then abandoned: the merchant never submitted, so reconciliation releases it
    // with its value unchanged — and that merchant can still submit the payment it holds.
    await pool.reserveSlot(merchant, 0, PAY);
    expect((await pool.reconcile(SEND_WINDOW_MS)).released).toEqual([0]);

    // Handing slot 0 straight back out would make that late submission race the next payment. It goes
    // last instead, so slots 1 and 2 are used first.
    expect((await pool.reserveSlot(merchant, SEND_WINDOW_MS, PAY)).index).toBe(1);
    expect((await pool.reserveSlot(merchant, SEND_WINDOW_MS, PAY)).index).toBe(2);
    expect((await pool.reserveSlot(merchant, SEND_WINDOW_MS, PAY)).index).toBe(0);
  });

  it('takes the least recently released slot when every slot has been released', async () => {
    const { pool } = await createdPool();
    await pool.reserveSlot(merchant, 0, PAY);
    await pool.reserveSlot(merchant, 0, PAY);
    await pool.reserveSlot(merchant, 5_000, PAY);
    expect((await pool.reconcile(SEND_WINDOW_MS)).released).toEqual([0, 1]);
    expect((await pool.reconcile(SEND_WINDOW_MS + 5_000)).released).toEqual([2]);

    // Slots 0 and 1 were released first, so one of them comes before slot 2.
    expect([0, 1]).toContain((await pool.reserveSlot(merchant, SEND_WINDOW_MS + 6_000, PAY)).index);
  });

  it('clears the mark once the slot settles, because its value has moved', async () => {
    const { pool, rpc } = await createdPool();
    await pool.reserveSlot(merchant, 0, PAY);
    await pool.reconcile(SEND_WINDOW_MS);
    expect(pool.status().slots[0]).toMatchObject({ releasedAt: SEND_WINDOW_MS });

    // Use up the unreleased slots so the released one comes round again, then let it settle.
    await pool.reserveSlot(merchant, SEND_WINDOW_MS, PAY);
    await pool.reserveSlot(merchant, SEND_WINDOW_MS, PAY);
    expect((await pool.reserveSlot(merchant, SEND_WINDOW_MS, PAY)).index).toBe(0);

    rpc.nonceAccounts = { ...rpc.nonceAccounts, ...initialized(addresses[0]!, value(9)) };
    expect((await pool.reconcile(SEND_WINDOW_MS)).settled).toContain(0);
    // Nothing can race a value that has moved, so the slot is an ordinary first-choice slot again.
    expect(pool.status().slots[0]?.releasedAt).toBeUndefined();
  });
});
