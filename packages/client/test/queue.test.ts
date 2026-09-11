// B9: receive rule 13 across every state (D31), the mandatory T1 pre-check (D30), and every cap in
// 31-PARAMETERS enforced at its boundary.

import { createKeyPairFromPrivateKeyBytes, type Address, type Nonce } from '@solana/kit';
import type { PaymentTier, VadumErrorCode, VerifiedPayment } from '@vadum/core';
import { fixtures, MERCHANT_SEED, type CanonicalInputJson, type NegativeCase } from '@vadum/fixtures';
import { describe, expect, it } from 'vitest';
import { createQueue, DEFAULT_QUEUE_LIMITS, paymentId, remainingExposure, type QueuedPayment, type QueueLimits } from '../src/queue.ts';
import { createMemoryStore, type KeyValueStore } from '../src/store.ts';
import { authFrom, caseNamed, expectVadumError, fakeRpc, fromBase64, intentFrom, paymentOf } from './helpers.ts';

const NONCE_FIXTURE = caseNamed('nonce-dynamic-spl-no-ata');
const merchantKey = () => createKeyPairFromPrivateKeyBytes(MERCHANT_SEED);

const inputFrom = (json: CanonicalInputJson): VerifiedPayment['input'] => ({
  intent: intentFrom(json.intent),
  payer: json.payer as Address,
  nonceRef: json.nonceRef === null ? null : { index: json.nonceRef.index, value: json.nonceRef.value as Nonce },
  amount: BigInt(json.amount),
});

interface PaymentJson {
  readonly input: CanonicalInputJson;
  readonly messageBytes: string;
  readonly auth: Parameters<typeof authFrom>[0];
}
const paymentFromJson = (json: PaymentJson): VerifiedPayment => ({
  input: inputFrom(json.input),
  messageBytes: fromBase64(json.messageBytes),
  auth: authFrom(json.auth),
});

interface LimitsJson {
  readonly receiptCapByTier: Readonly<Record<PaymentTier, string>>;
  readonly queueExposureCap: string;
  readonly maxConsecutiveFailedSends: number;
  readonly sendWindowMs: number;
}
const limitsFrom = (json: LimitsJson): QueueLimits => ({
  receiptCapByTier: { T0: BigInt(json.receiptCapByTier.T0), T1: BigInt(json.receiptCapByTier.T1), T2: BigInt(json.receiptCapByTier.T2) },
  queueExposureCap: BigInt(json.queueExposureCap),
  maxConsecutiveFailedSends: json.maxConsecutiveFailedSends,
  sendWindowMs: json.sendWindowMs,
});

interface SeedEntry {
  readonly id: string;
  readonly state: QueuedPayment['state'];
  readonly tier: PaymentTier;
  readonly amount: string;
}
async function seed(store: KeyValueStore, entries: readonly SeedEntry[], payment: VerifiedPayment): Promise<void> {
  for (const entry of entries) {
    const record: QueuedPayment = { id: entry.id, payment, tier: entry.tier, acceptedAt: 0, amount: BigInt(entry.amount), attempts: 0, state: entry.state };
    await store.set(`queue:payment:${entry.id}`, record);
  }
}

/** The same payment against another slot: a distinct dedupe key, which is what the caps need. */
const onSlot = (payment: VerifiedPayment, index: number): VerifiedPayment => ({
  ...payment,
  input: { ...payment.input, nonceRef: payment.input.nonceRef === null ? null : { ...payment.input.nonceRef, index } },
});

const targetsOf = (fixture: NegativeCase): readonly string[] => [fixture.target].flat().map(String);
const clientNegatives = fixtures.negative.filter((fixture) => targetsOf(fixture).some((target) => target.startsWith('client.')));

describe('negative fixtures owned by client', () => {
  it('covers all three cases', () => {
    expect(clientNegatives.length).toBe(3);
  });

  it.each(clientNegatives.map((fixture) => [fixture.name, fixture] as const))('%s', async (_name, fixture) => {
    const input = fixture.input as unknown as { payment: PaymentJson; tier: PaymentTier; amount: string; precheck: { ok: boolean } | null };
    const context = fixture.context as unknown as { limits: LimitsJson; queue: readonly SeedEntry[] };
    const payment = paymentFromJson(input.payment);
    const store = createMemoryStore();
    await seed(store, context.queue, payment);
    const queue = createQueue(fakeRpc(), store, limitsFrom(context.limits));
    await queue.load();

    // The committed ids are the D31 keys; if this drifts, dedupe silently stops matching.
    for (const entry of context.queue) expect(await paymentId(payment)).toBe(entry.id);

    await expectVadumError(
      () => queue.accept(payment, input.tier, BigInt(input.amount), input.precheck as never),
      fixture.expectedError as VadumErrorCode,
    );
  });
});

describe('dedupe keys (D31)', () => {
  it('keys the nonce path on payer, slot and value', async () => {
    const payment = await paymentOf(NONCE_FIXTURE);
    const nonceRef = payment.input.nonceRef;
    expect(await paymentId(payment)).toBe(`nonce:${payment.input.payer}:${nonceRef?.index}:${nonceRef?.value}`);
  });

  it('keys the fresh path on the message, not the signature', async () => {
    const payment = await paymentOf(caseNamed('fresh-dynamic-spl-no-ata'));
    const id = await paymentId(payment);
    expect(id.startsWith(`fresh:${payment.input.payer}:`)).toBe(true);
    // Another valid signature over the same message must not create a second key (Safari, D31).
    const resigned = { ...payment, auth: { ...payment.auth, signature: new Uint8Array(64) } };
    expect(await paymentId(resigned)).toBe(id);
  });

  it('refuses a replay in every state, including voided', async () => {
    const queue = createQueue(fakeRpc(), createMemoryStore());
    const payment = await paymentOf(NONCE_FIXTURE);
    await queue.accept(payment, 'T2', 2_500_000n);
    queue.expire(Date.now() + DEFAULT_QUEUE_LIMITS.sendWindowMs);
    expect(queue.list()[0]?.state).toBe('voided');
    await expectVadumError(() => queue.accept(payment, 'T2', 2_500_000n), 'WIRE_DUPLICATE_AUTH', { state: 'voided' });
  });
});

describe('tiers (D30)', () => {
  it('requires a passing pre-check for T1 on the nonce path', async () => {
    const queue = createQueue(fakeRpc(), createMemoryStore());
    const payment = await paymentOf(NONCE_FIXTURE);
    await expectVadumError(() => queue.accept(payment, 'T1', 2_500_000n), 'LIMIT_PRECHECK_REQUIRED');
    await expectVadumError(() => queue.accept(payment, 'T1', 2_500_000n, { ok: false, reason: 'absent' }), 'LIMIT_PRECHECK_REQUIRED');
    await expectVadumError(
      () => queue.accept(payment, 'T1', 2_500_000n, { ok: false, reason: 'stale', onChainValue: payment.input.nonceRef!.value }),
      'LIMIT_PRECHECK_REQUIRED',
    );
    const accepted = await queue.accept(payment, 'T1', 2_500_000n, { ok: true, onChainValue: payment.input.nonceRef!.value });
    expect(accepted.state).toBe('queued');
  });

  it('accepts T2 without a pre-check, because T2 cannot perform one', async () => {
    const queue = createQueue(fakeRpc(), createMemoryStore());
    expect((await queue.accept(await paymentOf(NONCE_FIXTURE), 'T2', 5_000_000n)).tier).toBe('T2');
  });

  it('does not demand a pre-check on the fresh path, which has no nonce account', async () => {
    const queue = createQueue(fakeRpc(), createMemoryStore());
    expect((await queue.accept(await paymentOf(caseNamed('fresh-dynamic-spl-no-ata')), 'T1', 2_500_000n)).state).toBe('queued');
  });
});

describe('caps (D23)', () => {
  it('enforces the per-receipt cap at its boundary', async () => {
    const queue = createQueue(fakeRpc(), createMemoryStore());
    const payment = await paymentOf(NONCE_FIXTURE);
    await expectVadumError(() => queue.accept(payment, 'T2', 5_000_001n), 'LIMIT_RECEIPT_CAP', { cap: '5000000', amount: '5000001' });
    await expectVadumError(() => queue.accept(onSlot(payment, 1), 'T1', 20_000_001n, { ok: true, onChainValue: payment.input.nonceRef!.value }), 'LIMIT_RECEIPT_CAP');
    expect((await queue.accept(onSlot(payment, 2), 'T2', 5_000_000n)).amount).toBe(5_000_000n);
    // T0 waits for confirmation, so nothing is at risk and no cap applies.
    expect((await queue.accept(onSlot(payment, 3), 'T0', 10_000_000_000n)).tier).toBe('T0');
  });

  it('enforces the queue exposure cap on unsettled payments only', async () => {
    const store = createMemoryStore();
    const rpc = fakeRpc({ sendPayment: async () => 'sig' });
    const queue = createQueue(rpc, store, { ...DEFAULT_QUEUE_LIMITS, queueExposureCap: 10_000_000n });
    const payment = await paymentOf(NONCE_FIXTURE);
    for (let index = 0; index < 2; index++) await queue.accept(onSlot(payment, index), 'T2', 5_000_000n);
    expect(queue.exposure()).toBe(10_000_000n);
    expect(remainingExposure(queue, { ...DEFAULT_QUEUE_LIMITS, queueExposureCap: 10_000_000n })).toBe(0n);
    await expectVadumError(() => queue.accept(onSlot(payment, 2), 'T2', 1n), 'LIMIT_QUEUE_EXPOSURE');

    // Draining settles both, which frees the whole exposure again.
    await queue.drain(await merchantKey());
    expect(queue.exposure()).toBe(0n);
    expect((await queue.accept(onSlot(payment, 2), 'T2', 5_000_000n)).state).toBe('queued');
  });
});

describe('drain and the failed-send counter (D21)', () => {
  const executionFailure = async (): Promise<string> => {
    throw new Error('InstructionError [2, {"Custom": 1}]');
  };

  it('stops accepting after three consecutive execution failures', async () => {
    const rpc = fakeRpc({ sendPayment: executionFailure });
    const queue = createQueue(rpc, createMemoryStore(), DEFAULT_QUEUE_LIMITS);
    const payment = await paymentOf(NONCE_FIXTURE);
    for (let index = 0; index < 3; index++) await queue.accept(onSlot(payment, index), 'T2', 1_000_000n);

    const outcomes = await queue.drain(await merchantKey());
    expect(outcomes.map((outcome) => (outcome.kind === 'failed' ? [outcome.code, outcome.feeCharged] : 'settled'))).toEqual(
      Array.from({ length: 3 }, () => ['SUBMIT_EXECUTION_FAILED', true]),
    );
    expect(queue.consecutiveFailedSends()).toBe(3);
    await expectVadumError(() => queue.accept(onSlot(payment, 4), 'T2', 1n), 'LIMIT_FAILED_SENDS');
    expect(queue.list().every((entry) => entry.state === 'failed' && entry.lastError === 'SUBMIT_EXECUTION_FAILED' && entry.attempts === 1)).toBe(true);
  });

  it('resets the counter on a settlement, and keeps retrying a failed payment', async () => {
    let fail = true;
    const rpc = fakeRpc({
      sendPayment: async () => {
        if (fail) throw new Error('InstructionError [2, {"Custom": 1}]');
        return 'sig';
      },
    });
    const queue = createQueue(rpc, createMemoryStore());
    const payment = await paymentOf(NONCE_FIXTURE);
    await queue.accept(payment, 'T2', 1_000_000n);
    await queue.drain(await merchantKey());
    expect(queue.consecutiveFailedSends()).toBe(1);

    fail = false;
    expect(await queue.drain(await merchantKey())).toEqual([{ kind: 'settled', signature: 'sig', newNonceValue: null }]);
    expect(queue.consecutiveFailedSends()).toBe(0);
    expect(queue.list()[0]).toMatchObject({ state: 'settled', attempts: 2 });
  });

  it('never counts a stale nonce or a dead connection as a failed send', async () => {
    const payment = await paymentOf(NONCE_FIXTURE);
    const advanced = 'AdVaNcEdVaLuE111111111111111111111111111119' as string as Nonce;
    const rpc = fakeRpc({
      nonceAccounts: { [NONCE_FIXTURE.derived.nonceAddress as string]: { kind: 'initialized', authority: payment.input.payer, value: advanced, lamports: 1n } },
      sendPayment: async () => {
        throw new Error('SolanaError: transaction failed to confirm');
      },
    });
    const queue = createQueue(rpc, createMemoryStore());
    await queue.accept(payment, 'T2', 1_000_000n);
    expect(await queue.drain(await merchantKey())).toMatchObject([{ kind: 'failed', code: 'SUBMIT_NONCE_STALE', feeCharged: false }]);
    expect(queue.consecutiveFailedSends()).toBe(0);
  });

  it('settles oldest first and survives a reload', async () => {
    const store = createMemoryStore();
    const signatures = ['sig-a', 'sig-b'];
    const rpc = fakeRpc({ sendPayment: async () => signatures.shift() ?? 'sig-z' });
    const queue = createQueue(rpc, store);
    const payment = await paymentOf(NONCE_FIXTURE);
    const first = await queue.accept(onSlot(payment, 0), 'T2', 1_000_000n);
    const second = await queue.accept(onSlot(payment, 1), 'T2', 2_000_000n);
    expect(queue.list().map((entry) => entry.id)).toEqual([first.id, second.id]);

    const outcomes = await queue.drain(await merchantKey());
    expect(outcomes.map((outcome) => (outcome.kind === 'settled' ? outcome.signature : outcome.code))).toEqual(['sig-a', 'sig-b']);
    expect(queue.list().every((entry) => entry.state === 'settled')).toBe(true);

    const reopened = createQueue(rpc, store);
    expect((await reopened.load()).map((entry) => entry.state)).toEqual(['settled', 'settled']);
    expect(reopened.exposure()).toBe(0n);
  });

  it('voids what the send window has outlived, and submits nothing after that', async () => {
    const rpc = fakeRpc({ sendPayment: async () => 'sig' });
    const queue = createQueue(rpc, createMemoryStore());
    await queue.accept(await paymentOf(NONCE_FIXTURE), 'T2', 1_000_000n);
    const expired = queue.expire(Date.now() + DEFAULT_QUEUE_LIMITS.sendWindowMs);
    expect(expired.map((entry) => entry.lastError)).toEqual(['LIMIT_SEND_WINDOW_EXPIRED']);
    expect(await queue.drain(await merchantKey())).toEqual([]);
    expect(rpc.sent.length).toBe(0);
    expect(queue.exposure()).toBe(0n);
  });
});
