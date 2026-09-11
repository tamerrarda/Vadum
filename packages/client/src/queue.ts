// The merchant queue: receive rule 13, the tier rules, and the caps of 31-PARAMETERS.
//
// Dedupe keys are checked against every payment this queue has ever accepted, in any state, and are
// never pruned in v1 (D31). buildMessage is a pure function of its inputs, so two identical purchases
// produce a byte-identical AUTH — without this rule a payer shows the same QR twice and is served
// twice while one transaction settles.

import { getBase58Decoder } from '@solana/kit';
import { VadumError, type PaymentTier, type VadumErrorCode, type VerifiedPayment } from '@vadum/core';
import type { NonceVerdict } from './nonce-check.ts';
import type { VadumRpc } from './rpc.ts';
import type { KeyValueStore } from './store.ts';
import { submit, type SubmitOutcome } from './submit.ts';

export interface QueuedPayment {
  /** The dedupe key (D31). */
  readonly id: string;
  readonly payment: VerifiedPayment;
  readonly tier: PaymentTier;
  readonly acceptedAt: number;
  /** Base units, never dollars (D23). */
  readonly amount: bigint;
  readonly attempts: number;
  readonly lastError?: VadumErrorCode;
  readonly state: 'queued' | 'submitting' | 'settled' | 'failed' | 'voided';
}

export interface QueueLimits {
  readonly receiptCapByTier: Readonly<Record<PaymentTier, bigint>>;
  readonly queueExposureCap: bigint;
  readonly maxConsecutiveFailedSends: number;
  readonly sendWindowMs: number;
}

/** D23, in base units for a 6-decimal pegged mint. T0 waits for confirmation, so it needs no cap. */
export const DEFAULT_QUEUE_LIMITS: QueueLimits = {
  receiptCapByTier: { T0: (1n << 64n) - 1n, T1: 20_000_000n, T2: 5_000_000n },
  queueExposureCap: 50_000_000n,
  maxConsecutiveFailedSends: 3,
  sendWindowMs: 24 * 60 * 60 * 1000,
};

export interface Queue {
  /**
   * Rule 13 first, then the tier rule, then the caps. A T1 acceptance on the nonce path requires a
   * passing pre-check (D30); T2 cannot perform one, and T0 hands over only after `drain` settles.
   */
  accept(payment: VerifiedPayment, tier: PaymentTier, amount: bigint, precheck?: NonceVerdict | null): Promise<QueuedPayment>;
  list(): readonly QueuedPayment[];
  exposure(): bigint;
  /** Online. Submits everything eligible, oldest first. */
  drain(feePayerKey: CryptoKeyPair): Promise<readonly SubmitOutcome[]>;
  /** Marks payments past the send window voided; submits nothing. */
  expire(now: number): readonly QueuedPayment[];
  /** Hydrates from the store; `list` and `exposure` are synchronous. */
  load(): Promise<readonly QueuedPayment[]>;
  /** Consecutive failed sends, as counted for LIMIT_FAILED_SENDS (D21). */
  consecutiveFailedSends(): number;
}

/** The dedupe key of D31: the slot and value on the nonce path, the message hash on the fresh one. */
export async function paymentId(payment: VerifiedPayment): Promise<string> {
  const { payer, nonceRef } = payment.input;
  if (nonceRef !== null) return `nonce:${payer}:${nonceRef.index}:${nonceRef.value}`;
  // Keyed on the message, not the signature: Safari's Ed25519 is non-deterministic, so one message
  // can arrive with two different valid payer signatures.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', payment.messageBytes as unknown as ArrayBuffer));
  return `fresh:${payer}:${getBase58Decoder().decode(digest)}`;
}

const UNSETTLED: readonly QueuedPayment['state'][] = ['queued', 'submitting', 'failed'];
const KEY_PREFIX = 'queue:payment:';
const META_KEY = 'queue:meta';

/** Failures that mean the merchant should stop accepting offline: never an honest race (D21, D23). */
const COUNTS_AS_FAILED_SEND = (code: VadumErrorCode): boolean => code === 'SUBMIT_EXECUTION_FAILED' || code === 'SUBMIT_NONCE_ABSENT';

export function createQueue(rpc: VadumRpc, store: KeyValueStore, limits: QueueLimits = DEFAULT_QUEUE_LIMITS): Queue {
  const payments = new Map<string, QueuedPayment>();
  let consecutiveFailedSends = 0;

  const save = async (payment: QueuedPayment): Promise<void> => {
    payments.set(payment.id, payment);
    await store.set(`${KEY_PREFIX}${payment.id}`, payment);
  };
  const saveMeta = async (): Promise<void> => store.set(META_KEY, { consecutiveFailedSends });
  const ordered = (): readonly QueuedPayment[] => [...payments.values()].sort((a, b) => a.acceptedAt - b.acceptedAt || a.id.localeCompare(b.id));
  // T0 hands over only after settlement, so a queued T0 payment is not exposure: the cumulative
  // offline amount counter covers the tiers that hand over first, T1 and T2 (31-PARAMETERS).
  const exposure = (): bigint =>
    ordered()
      .filter((payment) => payment.tier !== 'T0' && UNSETTLED.includes(payment.state))
      .reduce((total, payment) => total + payment.amount, 0n);

  return {
    async accept(payment, tier, amount, precheck) {
      const id = await paymentId(payment);
      if (payments.has(id)) throw new VadumError('WIRE_DUPLICATE_AUTH', { id, state: payments.get(id)?.state });

      const isNoncePath = payment.input.nonceRef !== null;
      const verdict = precheck ?? undefined; // a serialised payload carries an explicit null
      if (tier === 'T1' && isNoncePath && verdict?.ok !== true) {
        throw new VadumError('LIMIT_PRECHECK_REQUIRED', { tier, reason: verdict === undefined ? 'no verdict' : verdict.reason });
      }
      if (consecutiveFailedSends >= limits.maxConsecutiveFailedSends) {
        throw new VadumError('LIMIT_FAILED_SENDS', { consecutiveFailedSends, max: limits.maxConsecutiveFailedSends });
      }
      const cap = limits.receiptCapByTier[tier];
      if (amount > cap) throw new VadumError('LIMIT_RECEIPT_CAP', { tier, cap, amount });
      const exposed = exposure();
      if (tier !== 'T0' && exposed + amount > limits.queueExposureCap) {
        throw new VadumError('LIMIT_QUEUE_EXPOSURE', { exposure: exposed, amount, cap: limits.queueExposureCap });
      }

      const accepted: QueuedPayment = { id, payment, tier, acceptedAt: Date.now(), amount, attempts: 0, state: 'queued' };
      await save(accepted);
      return accepted;
    },

    list() {
      return ordered();
    },

    exposure,

    async drain(feePayerKey) {
      const outcomes: SubmitOutcome[] = [];
      for (const queued of ordered()) {
        if (queued.state !== 'queued' && queued.state !== 'failed') continue;
        await save({ ...queued, state: 'submitting' });
        const outcome = await submit(rpc, queued.payment, feePayerKey);
        outcomes.push(outcome);
        if (outcome.kind === 'settled') {
          await save({ ...queued, state: 'settled', attempts: queued.attempts + 1 });
          consecutiveFailedSends = 0;
        } else {
          await save({ ...queued, state: 'failed', attempts: queued.attempts + 1, lastError: outcome.code });
          // A stale nonce or a dead connection is not the merchant's signal to stop trading (D21).
          if (COUNTS_AS_FAILED_SEND(outcome.code)) consecutiveFailedSends += 1;
        }
        await saveMeta();
      }
      return outcomes;
    },

    expire(now) {
      const expired = ordered().filter((payment) => payment.state !== 'settled' && payment.state !== 'voided' && now - payment.acceptedAt >= limits.sendWindowMs);
      for (const payment of expired) void save({ ...payment, state: 'voided', lastError: 'LIMIT_SEND_WINDOW_EXPIRED' });
      return expired.map((payment) => ({ ...payment, state: 'voided' as const, lastError: 'LIMIT_SEND_WINDOW_EXPIRED' as const }));
    },

    async load() {
      for (const key of await store.keys(KEY_PREFIX)) {
        const payment = await store.get<QueuedPayment>(key);
        if (payment !== undefined) payments.set(payment.id, payment);
      }
      consecutiveFailedSends = (await store.get<{ consecutiveFailedSends: number }>(META_KEY))?.consecutiveFailedSends ?? 0;
      return ordered();
    },

    consecutiveFailedSends() {
      return consecutiveFailedSends;
    },
  };
}

/** Exported for the merchant app's exposure banner: what a queue would allow right now. */
export const remainingExposure = (queue: Queue, limits: QueueLimits = DEFAULT_QUEUE_LIMITS): bigint => {
  const left = limits.queueExposureCap - queue.exposure();
  return left > 0n ? left : 0n;
};
