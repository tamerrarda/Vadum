// The integration tests plan/50-INTEGRATION.md lists, minus the ones that need devices. Numbered as
// that file numbers them, because tests 3, 4 and 5 are the three a reviewer would ask about.
//
// Every scenario runs against `fake-chain.ts` rather than devnet, so they run in CI on every push;
// `tools/devnet-b` runs the same paths against the live cluster.

import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, type Address, type Nonce } from '@solana/kit';
import { createMemoryStore, createPool, createQueue, DEFAULT_QUEUE_LIMITS, precheckNonce, submit, type NonceVerdict } from '@vadum/client';
import { assertMintCompatible, evaluateMint, signNonceReturn, VadumError, type RawMintData } from '@vadum/core';
import { NONCE_VALUE, PAYER2_SEED } from '@vadum/fixtures';
import { decodeIntent, encodeIntent, encodeNonceReturn } from '@vadum/wire';
import { describe, expect, it } from 'vitest';
import { nextValue } from './fake-chain.ts';
import { AMOUNT, intentFor, MINT, mintCache, POOL_SIZE, signedPayment, twoDevices } from './devices.ts';

const SEND_WINDOW_MS = DEFAULT_QUEUE_LIMITS.sendWindowMs;

async function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${code}`).toBeInstanceOf(VadumError);
  expect((caught as VadumError).code).toBe(code);
}

describe('3 · race — one nonce value, two different payments, two merchants', () => {
  it('lets exactly one land and charges the loser nothing (D35)', async () => {
    const devices = await twoDevices();
    const merchant2Key = await createKeyPairFromPrivateKeyBytes(PAYER2_SEED);
    const merchant2 = await getAddressFromPublicKey(merchant2Key.publicKey);

    // The payer signs twice against the SAME slot value: two different payments, to two merchants.
    const slot = await devices.pool.reserveSlot(devices.merchant, Date.now());
    const first = await signedPayment(intentFor(devices.merchant, AMOUNT), devices.payerKey, slot, AMOUNT);
    const second = await signedPayment(intentFor(merchant2, 1_000_000n), devices.payerKey, slot, 1_000_000n);
    expect(first.messageBytes).not.toEqual(second.messageBytes);

    // Both verify offline — that is the precondition the whole risk model is built on.
    expect(first.auth.nonceRef?.value).toBe(second.auth.nonceRef?.value);

    const winner = await submit(devices.chain, first, devices.merchantKey);
    expect(winner.kind).toBe('settled');

    const loser = await submit(devices.chain, second, merchant2Key);
    expect(loser).toMatchObject({ kind: 'failed', code: 'SUBMIT_NONCE_STALE', feeCharged: false });

    // And the loser's queue does not treat an honest race as a reason to stop trading (D21).
    const queue2 = createQueue(devices.chain, createMemoryStore(), DEFAULT_QUEUE_LIMITS);
    await queue2.accept(second, 'T2', 1_000_000n);
    await queue2.drain(merchant2Key);
    expect(queue2.consecutiveFailedSends()).toBe(0);
  });
});

describe('4 · execution failure — the payer cannot cover it', () => {
  it('charges the merchant, consumes the nonce, and counts against the failed-send limit', async () => {
    const devices = await twoDevices();
    const slot = await devices.pool.reserveSlot(devices.merchant, Date.now());
    const payment = await signedPayment(intentFor(devices.merchant, AMOUNT), devices.payerKey, slot, AMOUNT);

    // What the chain does with an overdraft that reaches execution: it lands, it fails, the fee is
    // taken, and the nonce is gone (SOL-7, Phase 0 step 14). `failLands` is what makes the fee real —
    // `feeCharged` is read from the signature's outcome, never from the error text.
    devices.chain.failLands = true;
    devices.chain.failNext = new Error('Error processing Instruction 2: custom program error: 0x1');
    await devices.queue.accept(payment, 'T2', AMOUNT);
    const [outcome] = await devices.queue.drain(devices.merchantKey);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'SUBMIT_EXECUTION_FAILED', feeCharged: true });
    expect(devices.queue.consecutiveFailedSends()).toBe(1);

    await devices.chain.advance(devices.payer, slot.index, nextValue(slot.value));
    const reconciled = await devices.pool.reconcile(Date.now());
    // The slot is not lost to the payer: the value moved, so reconciliation re-arms it (D32).
    expect(reconciled.settled).toEqual([slot.index]);
    expect(devices.pool.status().slots[slot.index]).toMatchObject({ state: 'unspent' });
  });
});

describe('5 · fabricated nonce — the cheapest attack in the system (T6, D21)', () => {
  it('verifies offline, is refused at T1, and settles as SUBMIT_NONCE_ABSENT', async () => {
    const devices = await twoDevices();
    const ghostKey = await createKeyPairFromPrivateKeyBytes(PAYER2_SEED);
    const invented = nextValue(nextValue(NONCE_VALUE as Nonce));

    // No pool, no accounts, an invented value — and it still verifies offline.
    const payment = await signedPayment(intentFor(devices.merchant, AMOUNT), ghostKey, { index: 0, value: invented }, AMOUNT);
    expect(payment.auth.nonceRef?.value).toBe(invented);

    const verdict = await precheckNonce(devices.chain, payment);
    expect(verdict).toEqual({ ok: false, reason: 'absent' });

    // T1 without a passing verdict is refused before handover (D30) — this is the mitigation.
    await expectCode(() => devices.queue.accept(payment, 'T1', AMOUNT), 'LIMIT_PRECHECK_REQUIRED');
    await expectCode(() => devices.queue.accept(payment, 'T1', AMOUNT, verdict as NonceVerdict), 'LIMIT_PRECHECK_REQUIRED');

    // T2 cannot pre-check at all, so it accepts and finds out at submission.
    await devices.queue.accept(payment, 'T2', AMOUNT);
    const [outcome] = await devices.queue.drain(devices.merchantKey);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'SUBMIT_NONCE_ABSENT', feeCharged: false });
    expect(devices.queue.consecutiveFailedSends()).toBe(1);
  });
});

describe('6 · duplicate AUTH — while queued and after settlement (D31)', () => {
  it('refuses the same payment in both states', async () => {
    const devices = await twoDevices();
    const slot = await devices.pool.reserveSlot(devices.merchant, Date.now());
    const payment = await signedPayment(intentFor(devices.merchant, AMOUNT), devices.payerKey, slot, AMOUNT);

    await devices.queue.accept(payment, 'T2', AMOUNT);
    await expectCode(() => devices.queue.accept(payment, 'T2', AMOUNT), 'WIRE_DUPLICATE_AUTH');

    const [outcome] = await devices.queue.drain(devices.merchantKey);
    expect(outcome?.kind).toBe('settled');
    // Settled is not "no longer live": the key is kept forever, so a re-shown QR is still refused.
    await expectCode(() => devices.queue.accept(payment, 'T2', AMOUNT), 'WIRE_DUPLICATE_AUTH');
  });
});

describe('7 · eviction — the ledger is gone', () => {
  it('refuses to hand out a slot rather than signing against an unknown one (C3, T4)', async () => {
    const devices = await twoDevices();
    await devices.pool.reserveSlot(devices.merchant, Date.now());

    // Exactly what clearing site data does to the payer's device.
    await devices.payerStore.delete(`pool:${devices.payer}`);
    const reopened = createPool(devices.chain, devices.payer, devices.payerStore);
    await expectCode(() => reopened.reserveSlot(devices.merchant, Date.now()), 'NONCE_LEDGER_MISSING');
    await expectCode(() => reopened.load(), 'NONCE_LEDGER_MISSING');

    // One online session restores it, and reconciliation decides what each slot is.
    const status = await reopened.create(POOL_SIZE, devices.payerKey);
    expect(status.unspentCount).toBe(POOL_SIZE);
  });
});

describe('8 · nonce return — offline recovery (D28)', () => {
  it('re-arms the slot for this payer only', async () => {
    const devices = await twoDevices();
    const slot = await devices.pool.reserveSlot(devices.merchant, Date.now());
    const payment = await signedPayment(intentFor(devices.merchant, AMOUNT), devices.payerKey, slot, AMOUNT);
    const outcome = await submit(devices.chain, payment, devices.merchantKey);
    if (outcome.kind !== 'settled' || outcome.newNonceValue === null) throw new Error('expected a settled payment with a new value');

    const statement = { payer: devices.payer, nonceIndex: slot.index, spentAgainstValue: slot.value, newNonceValue: outcome.newNonceValue };
    const payload = encodeNonceReturn({ nonceIndex: slot.index, newNonceValue: outcome.newNonceValue, signature: await signNonceReturn(statement, devices.merchantKey) });
    expect(payload.length).toBe(100);

    // A return issued to a different payer changes nothing, even though its signature is real.
    const strangerKey = await createKeyPairFromPrivateKeyBytes(PAYER2_SEED);
    const stranger = await getAddressFromPublicKey(strangerKey.publicKey);
    const forStranger = await signNonceReturn({ ...statement, payer: stranger }, devices.merchantKey);
    await expectCode(
      () => devices.pool.applyNonceReturn({ nonceIndex: slot.index, newNonceValue: outcome.newNonceValue as Nonce, signature: forStranger }),
      'NONCE_RETURN_UNTRUSTED',
    );
    expect(devices.pool.status().slots[slot.index]).toMatchObject({ state: 'spent' });

    const status = await devices.pool.applyNonceReturn({ nonceIndex: slot.index, newNonceValue: outcome.newNonceValue, signature: await signNonceReturn(statement, devices.merchantKey) });
    expect(status.slots[slot.index]).toMatchObject({ state: 'unspent', value: outcome.newNonceValue });
  });
});

describe('9 · reconciliation (D32)', () => {
  it('releases an abandoned slot only after the send window, and re-arms a settled one', async () => {
    const devices = await twoDevices();
    const settled = await devices.pool.reserveSlot(devices.merchant, 0);
    const abandoned = await devices.pool.reserveSlot(devices.merchant, 0);
    await devices.chain.advance(devices.payer, settled.index, nextValue(settled.value));

    // Inside the window the merchant may still submit, so the slot stays spent.
    const inside = await devices.pool.reconcile(SEND_WINDOW_MS - 1);
    expect(inside.settled).toEqual([settled.index]);
    expect(inside.stillPending).toEqual([abandoned.index]);
    expect(devices.pool.status().slots[abandoned.index]).toMatchObject({ state: 'spent' });

    const after = await devices.pool.reconcile(SEND_WINDOW_MS);
    expect(after.released).toEqual([abandoned.index]);
    expect(devices.pool.status().unspentCount).toBe(POOL_SIZE);
  });
});

describe('10 · mint hard block', () => {
  const hookMint: RawMintData = {
    mint: MINT,
    tokenProgram: 'token-2022',
    decimals: 6,
    freezeAuthority: null,
    extensions: [{ extension: 'transferHook', state: { authority: null, programId: MINT } }],
  };

  it('refuses a mint with an active transfer hook, and an intent for a mint the payer has never checked', async () => {
    const record = evaluateMint(hookMint, 0);
    expect(record.blockers).toEqual(['transfer-hook-active']);
    await expectCode(async () => assertMintCompatible(record), 'MINT_INCOMPATIBLE');

    // Receive rule 4, on the payer's side of the air gap: no cache entry, no signature.
    const unknown = intentFor('9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu' as Address, AMOUNT);
    const bytes = encodeIntent({ ...unknown, mint: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH' as Address });
    await expectCode(async () => decodeIntent(bytes, { mintCache }), 'MINT_UNKNOWN');
  });
});

describe('11 · cap enforcement at every boundary (D23)', () => {
  it('blocks the receipt cap, the exposure cap, the failed-send counter and the send window', async () => {
    const devices = await twoDevices();
    const slots = [await devices.pool.reserveSlot(devices.merchant, Date.now()), await devices.pool.reserveSlot(devices.merchant, Date.now())];
    const payments = await Promise.all(slots.map((slot) => signedPayment(intentFor(devices.merchant, AMOUNT), devices.payerKey, slot, AMOUNT)));
    const [first, second] = payments as [Awaited<ReturnType<typeof signedPayment>>, Awaited<ReturnType<typeof signedPayment>>];

    // Per-receipt cap: T2 is 5, T1 is 20, and T0 needs none because it waits for confirmation.
    await expectCode(() => devices.queue.accept(first, 'T2', 5_000_001n), 'LIMIT_RECEIPT_CAP');
    await expectCode(() => devices.queue.accept(first, 'T1', 20_000_001n, { ok: true, onChainValue: first.auth.nonceRef?.value as Nonce }), 'LIMIT_RECEIPT_CAP');

    // Exposure cap, on a queue whose cap is small enough to reach.
    const tight = createQueue(devices.chain, createMemoryStore(), { ...DEFAULT_QUEUE_LIMITS, queueExposureCap: AMOUNT });
    await tight.accept(first, 'T2', AMOUNT);
    await expectCode(() => tight.accept(second, 'T2', AMOUNT), 'LIMIT_QUEUE_EXPOSURE');

    // Failed-send counter: three execution failures in a row and the till stops accepting offline.
    const failing = createQueue(devices.chain, createMemoryStore(), DEFAULT_QUEUE_LIMITS);
    devices.chain.failLands = true;
    devices.chain.failAlways = new Error('Error processing Instruction 2: custom program error: 0x1');
    const third = await signedPayment(intentFor(devices.merchant, AMOUNT), devices.payerKey, await devices.pool.reserveSlot(devices.merchant, Date.now()), AMOUNT);
    for (const payment of [first, second, third]) await failing.accept(payment, 'T2', AMOUNT);
    const failures = await failing.drain(devices.merchantKey);
    expect(failures.map((outcome) => (outcome.kind === 'failed' ? outcome.code : 'settled'))).toEqual(['SUBMIT_EXECUTION_FAILED', 'SUBMIT_EXECUTION_FAILED', 'SUBMIT_EXECUTION_FAILED']);
    expect(failing.consecutiveFailedSends()).toBe(DEFAULT_QUEUE_LIMITS.maxConsecutiveFailedSends);

    const fourth = await signedPayment(intentFor(devices.merchant, AMOUNT), devices.payerKey, await devices.pool.reserveSlot(devices.merchant, Date.now()), AMOUNT);
    await expectCode(() => failing.accept(fourth, 'T2', AMOUNT), 'LIMIT_FAILED_SENDS');
    devices.chain.failAlways = null;
    devices.chain.failLands = false;

    // Send window: what sat unsent for a day is voided rather than submitted.
    const expiring = createQueue(devices.chain, createMemoryStore(), DEFAULT_QUEUE_LIMITS);
    await expiring.accept(second, 'T2', AMOUNT);
    const voided = expiring.expire(Date.now() + SEND_WINDOW_MS);
    expect(voided.map((payment) => payment.lastError)).toEqual(['LIMIT_SEND_WINDOW_EXPIRED']);
    expect(await expiring.drain(devices.merchantKey)).toEqual([]);
  });
});
