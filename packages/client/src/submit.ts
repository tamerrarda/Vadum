// Submission, and the classification D21 insists on: SUBMIT_NONCE_STALE, SUBMIT_NONCE_ABSENT and
// SUBMIT_EXECUTION_FAILED are three different events with three different costs, and collapsing them
// hides an honest race behind the same message as near-certain fraud.

import type { Nonce } from '@solana/kit';
import { buildWireTransaction, deriveNonceAddress, VadumError, type VadumErrorCode, type VerifiedPayment } from '@vadum/core';
import { precheckNonce } from './nonce-check.ts';
import type { PaymentLifetime, VadumRpc } from './rpc.ts';

export type SubmitOutcome =
  | {
      readonly kind: 'settled';
      readonly signature: string;
      /** The value the merchant signs into a NONCE_RETURN (D28); null on the fresh path, which has
       *  no nonce account at all (plan/questions/stream-b.md B-3). */
      readonly newNonceValue: Nonce | null;
    }
  | {
      readonly kind: 'failed';
      readonly code: VadumErrorCode;
      readonly feeCharged: boolean;
      /** What the RPC or the chain actually said, for the merchant's log and for support (PROD-7). */
      readonly detail?: string;
    };

/** Only an executed transaction costs the merchant a fee; validation failures are free (SOL-7). */
const EXECUTION_MARKERS = ['InstructionError', 'custom program error', 'insufficient funds', 'insufficient lamports', 'AccountFrozen'];
const EXPIRY_MARKERS = ['BlockhashNotFound', 'block height exceeded', 'BlockHeightExceeded', 'TransactionExpired'];
const TRANSPORT_MARKERS = [
  'fetch failed',
  'Failed to fetch',
  'NetworkError',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'socket hang up',
  'timed out',
  // A dropped confirmation socket says nothing about the transaction: a public endpoint rate-limits
  // subscriptions, and the merchant app must retry rather than show a payment as failed.
  'WebSocket failed to connect',
  'CHANNEL_FAILED_TO_CONNECT',
];

const text = (error: unknown): string => {
  const base = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const context = (error as { context?: unknown }).context;
  return context === undefined ? base : `${base} ${JSON.stringify(context, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))}`;
};

/** A rejection at preflight never reaches the validator, so it costs nothing (SOL-7, Phase 0 step 11). */
const wasSimulated = (message: string): boolean => /simulat|preflight/i.test(message);

/** What the thrown error says on its own, before asking the chain about the nonce. */
function classifyError(error: unknown): { readonly code: VadumErrorCode; readonly feeCharged: boolean } | null {
  const message = text(error);
  if (message.includes('already been processed') || message.includes('AlreadyProcessed')) return { code: 'SUBMIT_ALREADY_PROCESSED', feeCharged: false };
  if (EXECUTION_MARKERS.some((marker) => message.includes(marker))) return { code: 'SUBMIT_EXECUTION_FAILED', feeCharged: !wasSimulated(message) };
  if (EXPIRY_MARKERS.some((marker) => message.includes(marker))) return { code: 'SUBMIT_BLOCKHASH_EXPIRED', feeCharged: false };
  if (TRANSPORT_MARKERS.some((marker) => message.includes(marker))) return { code: 'SUBMIT_RPC_UNAVAILABLE', feeCharged: false };
  return null;
}

/**
 * Attaches the fee-payer signature and submits, through the confirmer that matches the payment's
 * lifetime (SOL-15). On failure the nonce account decides between a stale value and an absent one.
 */
export async function submit(rpc: VadumRpc, payment: VerifiedPayment, feePayerKey: CryptoKeyPair): Promise<SubmitOutcome> {
  const { intent, payer, nonceRef } = payment.input;
  const lifetime: PaymentLifetime =
    intent.lifetime.kind === 'nonce' && nonceRef !== null
      ? { kind: 'nonce', nonce: nonceRef.value, nonceAccountAddress: await deriveNonceAddress(payer, nonceRef.index), nonceAuthorityAddress: payer }
      : intent.lifetime.kind === 'fresh'
        ? { kind: 'fresh', blockhash: intent.lifetime.blockhash, lastValidBlockHeight: intent.lifetime.lastValidBlockHeight }
        : (() => {
            throw new VadumError('INTERNAL_NOT_APPLICABLE', { reason: 'a nonce-path payment without a nonce reference' });
          })();
  const wireTransaction = await buildWireTransaction(payment, feePayerKey);

  let signature: string;
  try {
    signature = await rpc.sendPayment(wireTransaction, lifetime);
  } catch (error) {
    const detail = text(error).slice(0, 400);
    const fromError = classifyError(error);
    // A failure that actually landed is definitive, and so is a duplicate; nothing the nonce account
    // says can change either. A rejection at preflight is NOT definitive: a missing nonce account
    // reports an InstructionError there too, and calling that an execution failure is exactly the
    // conflation D21 forbids.
    if (fromError?.code === 'SUBMIT_ALREADY_PROCESSED' || (fromError?.code === 'SUBMIT_EXECUTION_FAILED' && fromError.feeCharged)) {
      return { kind: 'failed', ...fromError, detail };
    }
    if (lifetime.kind === 'fresh') return { kind: 'failed', ...(fromError ?? { code: 'SUBMIT_RPC_UNAVAILABLE' as VadumErrorCode, feeCharged: false }), detail };
    // On the nonce path the account is the witness that matters, and it outranks the error string: a
    // stale nonce is reported by the RPC as a missing blockhash, which is not what happened (D21).
    const verdict = await precheckNonce(rpc, payment);
    if (!verdict.ok) {
      return verdict.reason === 'stale'
        ? { kind: 'failed', code: 'SUBMIT_NONCE_STALE', feeCharged: false, detail }
        : { kind: 'failed', code: 'SUBMIT_NONCE_ABSENT', feeCharged: false, detail };
    }
    // The nonce is exactly as claimed, so the send itself is what failed.
    return { kind: 'failed', ...(fromError ?? { code: 'SUBMIT_RPC_UNAVAILABLE' as VadumErrorCode, feeCharged: false }), detail };
  }

  if (nonceRef === null) return { kind: 'settled', signature, newNonceValue: null };
  const state = await rpc.getNonceAccount(await deriveNonceAddress(payer, nonceRef.index));
  // An unreadable slot leaves newNonceValue null rather than guessing: a NONCE_RETURN carrying the
  // value the slot was spent against is rejected by the payer anyway (D28), and silence is safer.
  return { kind: 'settled', signature, newNonceValue: state.kind === 'initialized' ? state.value : null };
}
