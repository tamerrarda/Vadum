// A chain good enough for the device-free half of plan/50-INTEGRATION.md: nonce accounts, balances,
// token balances, and a submission path that advances a nonce exactly the way settlement does (SOL-8).
//
// It is not a validator. It exists so the race, the duplicate, the reconciliation and the recovery
// scenarios are testable in one process — `tools/devnet-b` runs the same paths against devnet.

import { getTransactionDecoder, type Address, type Instruction, type Nonce } from '@solana/kit';
import { deriveNonceAddress, type RawMintData } from '@vadum/core';
import type { NonceAccountState, PaymentLifetime, VadumRpc } from '@vadum/client';

export const NONCE_RENT = 1_056_640n;
export const WALLET_RENT = 890_880n;

export interface FakeChain extends VadumRpc {
  /** Initialise `size` slots for `payer`, as a successful pool setup would leave them. */
  seedPool(payer: Address, size: number, value: (index: number) => Nonce): Promise<void>;
  /** Advance one slot, which is what settlement does to it. */
  advance(payer: Address, index: number, value: Nonce): Promise<void>;
  /** Remove one slot, as a payer closing its own account does (T7). */
  close(payer: Address, index: number): Promise<void>;
  readonly submitted: { readonly wireTransaction: Uint8Array; readonly lifetime: PaymentLifetime }[];
  readonly setups: { readonly instructions: readonly Instruction[]; readonly feePayerKey: CryptoKeyPair }[];
  /** Set to reject the next submission with this error, for the failure classes. */
  failNext: Error | null;
  balances: Map<Address, bigint>;
  tokenBalances: Map<Address, bigint>;
}

export function createFakeChain(options: { readonly mint?: RawMintData } = {}): FakeChain {
  const accounts = new Map<Address, NonceAccountState>();
  const submitted: FakeChain['submitted'] = [];
  const setups: FakeChain['setups'] = [];

  const chain: FakeChain = {
    endpoint: 'http://127.0.0.1:8899',
    cluster: 'localnet',
    submitted,
    setups,
    failNext: null,
    balances: new Map(),
    tokenBalances: new Map(),

    async seedPool(payer, size, value) {
      for (let index = 0; index < size; index++) {
        accounts.set(await deriveNonceAddress(payer, index), { kind: 'initialized', authority: payer, value: value(index), lamports: NONCE_RENT });
      }
    },
    async advance(payer, index, value) {
      const address = await deriveNonceAddress(payer, index);
      accounts.set(address, { kind: 'initialized', authority: payer, value, lamports: NONCE_RENT });
    },
    async close(payer, index) {
      accounts.delete(await deriveNonceAddress(payer, index));
    },

    async getNonceRentExemption() {
      return NONCE_RENT;
    },
    async getRentExemption(dataLength) {
      return dataLength === 0 ? WALLET_RENT : NONCE_RENT;
    },
    async getMintAccount(mint) {
      if (options.mint === undefined || options.mint.mint !== mint) throw new Error(`the fake chain has no mint ${mint}`);
      return { raw: options.mint, fetchedAt: 0 };
    },
    async getNonceAccount(address) {
      return accounts.get(address) ?? { kind: 'absent' };
    },
    async getTokenBalance(ata) {
      return chain.tokenBalances.get(ata) ?? null;
    },
    async isAtaFrozen() {
      return false;
    },
    async getBalance(address) {
      return chain.balances.get(address) ?? 0n;
    },
    async sendSetup(instructions, feePayerKey) {
      setups.push({ instructions, feePayerKey });
      return `setup-${setups.length}`;
    },
    async sendPayment(wireTransaction, lifetime) {
      const failure = chain.failNext;
      if (failure !== null) {
        chain.failNext = null;
        throw failure;
      }
      // Both signatures must be present, or the chain would never have taken it.
      const transaction = getTransactionDecoder().decode(wireTransaction);
      if (Object.values(transaction.signatures).some((signature) => signature === null)) throw new Error('missing signature');

      if (lifetime.kind === 'nonce') {
        const current = accounts.get(lifetime.nonceAccountAddress);
        if (current?.kind !== 'initialized') throw new Error('Transaction simulation failed: Blockhash not found');
        // A nonce value is spent exactly once: a second payment against it is rejected, which is what
        // makes the race a race (D35).
        if (current.value !== lifetime.nonce) throw new Error('Transaction simulation failed: Blockhash not found');
        accounts.set(lifetime.nonceAccountAddress, { ...current, value: nextValue(current.value) });
      }
      submitted.push({ wireTransaction, lifetime });
      return `signature-${submitted.length}`;
    },
  };
  return chain;
}

/** A deterministic successor value, standing in for the chain's recent-blockhash rotation. */
export function nextValue(value: Nonce): Nonce {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const last = value.slice(-1);
  const index = alphabet.indexOf(last);
  return `${value.slice(0, -1)}${alphabet[(index + 1) % alphabet.length]}` as string as Nonce;
}
