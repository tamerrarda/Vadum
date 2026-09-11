// The lifetime mechanism behind an interface — the deprecation hedge (D17). Nothing outside this
// module names AdvanceNonceAccount, so a successor to durable nonces is a third implementation here.

import {
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  type TransactionMessage,
  type TransactionMessageWithFeePayer,
  type TransactionMessageWithLifetime,
} from '@solana/kit';
import { deriveNonceAddress } from './derive.ts';
import { VadumError } from './errors.ts';
import type { CanonicalInput } from './types.ts';

type FeePayerMessage = TransactionMessage & TransactionMessageWithFeePayer;
type LifetimeMessage = FeePayerMessage & TransactionMessageWithLifetime;

export interface NonceProvider {
  readonly kind: 'durable-nonce' | 'fresh-blockhash';
  /** Async because the nonce account address comes from createAddressWithSeed (D34). */
  applyLifetime(msg: FeePayerMessage, input: CanonicalInput): Promise<LifetimeMessage>;
  /** True for durable nonce only; the fresh path has no protocol-level at-most-once. */
  readonly guaranteesAtMostOnce: boolean;
}

export const durableNonceProvider: NonceProvider = {
  kind: 'durable-nonce',
  guaranteesAtMostOnce: true,
  async applyLifetime(msg, input) {
    if (input.intent.lifetime.kind !== 'nonce' || input.nonceRef === null) {
      throw new VadumError('INTERNAL_NOT_APPLICABLE', { provider: 'durable-nonce', lifetime: input.intent.lifetime.kind });
    }
    const nonceAccountAddress = await deriveNonceAddress(input.payer, input.nonceRef.index);
    // kit prepends AdvanceNonceAccount itself, which keeps it first.
    return setTransactionMessageLifetimeUsingDurableNonce(
      { nonce: input.nonceRef.value, nonceAccountAddress, nonceAuthorityAddress: input.payer },
      msg,
    ) as unknown as LifetimeMessage;
  },
};

export const freshBlockhashProvider: NonceProvider = {
  kind: 'fresh-blockhash',
  guaranteesAtMostOnce: false,
  async applyLifetime(msg, input) {
    const { lifetime } = input.intent;
    if (lifetime.kind !== 'fresh' || input.nonceRef !== null) {
      throw new VadumError('INTERNAL_NOT_APPLICABLE', { provider: 'fresh-blockhash', lifetime: lifetime.kind });
    }
    return setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight },
      msg,
    ) as unknown as LifetimeMessage;
  },
};

export const providerFor = (input: CanonicalInput): NonceProvider =>
  input.intent.lifetime.kind === 'nonce' ? durableNonceProvider : freshBlockhashProvider;
