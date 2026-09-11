// The fabricated-nonce mitigation (D21), and the one place in the system where being online buys real
// security. `verifyAuth` proves the payer signed this exact message; this proves there is an account
// behind it. Neither implies the other, and the merchant UI must not present offline verification as
// if it did.

import type { Nonce } from '@solana/kit';
import { deriveNonceAddress, VadumError, type VerifiedPayment } from '@vadum/core';
import type { VadumRpc } from './rpc.ts';

export type NonceVerdict =
  | { readonly ok: true; readonly onChainValue: Nonce }
  /** Valid but moved on — a genuine race, and it costs the merchant nothing. */
  | { readonly ok: false; readonly reason: 'stale'; readonly onChainValue: Nonce }
  /** Missing, uninitialized, or not the payer's. Near-certain fraud. */
  | { readonly ok: false; readonly reason: 'absent' | 'uninitialized' | 'wrong-authority' };

/**
 * One getAccountInfo on the derived nonce address, checked in order: the account exists, it is
 * initialized, its authority is the payer, and it holds the value the AUTH claims.
 *
 * MANDATORY before handover in tier T1, enforced there by Queue.accept (D30). T0's confirmation
 * implies it. It is impossible in T2 — the tier where the fraud is unmitigated.
 */
export async function precheckNonce(rpc: VadumRpc, payment: VerifiedPayment): Promise<NonceVerdict> {
  const { payer, nonceRef } = payment.input;
  if (payment.input.intent.lifetime.kind !== 'nonce' || nonceRef === null) {
    throw new VadumError('INTERNAL_NOT_APPLICABLE', { reason: 'a fresh-blockhash payment has no nonce account' });
  }
  const state = await rpc.getNonceAccount(await deriveNonceAddress(payer, nonceRef.index));
  if (state.kind === 'absent') return { ok: false, reason: 'absent' };
  if (state.kind === 'uninitialized') return { ok: false, reason: 'uninitialized' };
  if (state.authority !== payer) return { ok: false, reason: 'wrong-authority' };
  return state.value === nonceRef.value ? { ok: true, onChainValue: state.value } : { ok: false, reason: 'stale', onChainValue: state.value };
}
