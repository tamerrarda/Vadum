// Submission, and the classification D21 insists on: SUBMIT_NONCE_STALE, SUBMIT_NONCE_ABSENT and
// SUBMIT_EXECUTION_FAILED are three different events with three different costs, and collapsing them
// hides an honest race behind the same message as near-certain fraud.
//
// `feeCharged` is decided by the chain, never by the shape of an error string. After a failed send the
// signature is looked up: a transaction the cluster processed charged its fee even though it failed,
// and one the cluster never saw charged nothing (SOL-7). An earlier version read `/simulat|preflight/`
// out of the RPC's prose, which would have put a wrong number in the merchant's ledger the moment the
// endpoint changed its wording.

import { getSignatureFromTransaction, getTransactionDecoder, type Nonce } from '@solana/kit';
import { buildWireTransaction, deriveNonceAddress, VadumError, type VadumErrorCode, type VerifiedPayment } from '@vadum/core';
import { precheckNonce } from './nonce-check.ts';
import type { PaymentLifetime, SendOptions, VadumRpc } from './rpc.ts';

export type SubmitOutcome =
  | {
      readonly kind: 'settled';
      readonly signature: string;
      /** The value the merchant signs into a NONCE_RETURN (D28); null on the fresh path, which has
       *  no nonce account at all, and null when the slot cannot be read back. */
      readonly newNonceValue: Nonce | null;
    }
  | {
      readonly kind: 'failed';
      readonly code: VadumErrorCode;
      readonly feeCharged: boolean;
      /** What the RPC or the chain actually said, for the merchant's log and for support (PROD-7). */
      readonly detail?: string;
    };

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

/** What the thrown error says about itself. It never decides `feeCharged`; the chain does. */
function codeFromError(error: unknown): VadumErrorCode | null {
  const message = text(error);
  if (message.includes('already been processed') || message.includes('AlreadyProcessed')) return 'SUBMIT_ALREADY_PROCESSED';
  if (EXECUTION_MARKERS.some((marker) => message.includes(marker))) return 'SUBMIT_EXECUTION_FAILED';
  if (EXPIRY_MARKERS.some((marker) => message.includes(marker))) return 'SUBMIT_BLOCKHASH_EXPIRED';
  if (TRANSPORT_MARKERS.some((marker) => message.includes(marker))) return 'SUBMIT_RPC_UNAVAILABLE';
  return null;
}

/** The slot's value after settlement, which is what a NONCE_RETURN carries (D28). */
async function newNonceValueOf(rpc: VadumRpc, payment: VerifiedPayment): Promise<Nonce | null> {
  const { payer, nonceRef } = payment.input;
  if (nonceRef === null) return null;
  const state = await rpc.getNonceAccount(await deriveNonceAddress(payer, nonceRef.index));
  // An unreadable slot leaves it null rather than guessing: a return carrying the value the slot was
  // spent against is refused by the payer anyway (D28), and silence is safer.
  return state.kind === 'initialized' ? state.value : null;
}

/**
 * Attaches the fee-payer signature and submits, through the confirmer that matches the payment's
 * lifetime (SOL-15). On failure the chain decides what it cost, and the nonce account decides between
 * a stale value and an absent one.
 */
export async function submit(rpc: VadumRpc, payment: VerifiedPayment, feePayerKey: CryptoKeyPair, options?: SendOptions): Promise<SubmitOutcome> {
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
  // Known before the send, so a failure can be looked up even when the send itself reported nothing.
  const signature = getSignatureFromTransaction(
    getTransactionDecoder().decode(wireTransaction) as Parameters<typeof getSignatureFromTransaction>[0],
  );

  try {
    return { kind: 'settled', signature: await rpc.sendPayment(wireTransaction, lifetime, options), newNonceValue: await newNonceValueOf(rpc, payment) };
  } catch (error) {
    const detail = text(error).slice(0, 400);
    const outcome = await rpc.getSignatureOutcome(signature);

    // A dropped socket after a successful landing is not a failure: the payment settled, and telling
    // the merchant otherwise would have them retry a payment that already went through.
    if (outcome === 'landed-ok') return { kind: 'settled', signature, newNonceValue: await newNonceValueOf(rpc, payment) };
    // It executed and failed, so the fee left the merchant's wallet. This is the expensive class.
    if (outcome === 'landed-failed') return { kind: 'failed', code: 'SUBMIT_EXECUTION_FAILED', feeCharged: true, detail };

    // Nothing landed, so nothing was charged. What remains is deciding which free failure it was.
    const fromError = codeFromError(error);
    if (fromError === 'SUBMIT_ALREADY_PROCESSED') return { kind: 'failed', code: fromError, feeCharged: false, detail };
    if (lifetime.kind === 'fresh') return { kind: 'failed', code: fromError ?? 'SUBMIT_RPC_UNAVAILABLE', feeCharged: false, detail };

    // On the nonce path the account is the witness that matters, and it outranks the error string: a
    // stale nonce is reported by the RPC as a missing blockhash, which is not what happened (D21).
    const verdict = await precheckNonce(rpc, payment);
    if (!verdict.ok) {
      return verdict.reason === 'stale'
        ? { kind: 'failed', code: 'SUBMIT_NONCE_STALE', feeCharged: false, detail }
        : { kind: 'failed', code: 'SUBMIT_NONCE_ABSENT', feeCharged: false, detail };
    }
    // The nonce is exactly as claimed, so the send itself is what failed.
    return { kind: 'failed', code: fromError ?? 'SUBMIT_RPC_UNAVAILABLE', feeCharged: false, detail };
  }
}
