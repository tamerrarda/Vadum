// A VadumRpc double, fixture conversions and error assertions. No test in this package touches a
// network: every online path is exercised through the double.

import { getBase64Encoder, type Address, type Blockhash, type Instruction, type Nonce } from '@solana/kit';
import { VadumError, verifyAuth, type Auth, type Intent, type RawMintData, type VadumErrorCode, type VerifiedPayment } from '@vadum/core';
import { fixtures, type AuthJson, type IntentJson, type PositiveCase } from '@vadum/fixtures';
import { expect } from 'vitest';
import type { NonceAccountState, PaymentLifetime, VadumRpc } from '../src/rpc.ts';

export const fromBase64 = (value: string): Uint8Array => new Uint8Array(getBase64Encoder().encode(value));

export const intentFrom = (json: IntentJson): Intent => ({
  merchant: json.merchant as Address,
  mint: json.mint as Address,
  decimals: json.decimals,
  amount: json.amount === null ? null : BigInt(json.amount),
  lifetime:
    json.lifetime.kind === 'nonce'
      ? { kind: 'nonce' }
      : { kind: 'fresh', blockhash: json.lifetime.blockhash as Blockhash, lastValidBlockHeight: BigInt(json.lifetime.lastValidBlockHeight) },
  includeCreateAta: json.includeCreateAta,
  tokenProgram: json.tokenProgram,
  feePayer: json.feePayer as Address,
  isStatic: json.isStatic,
});

export const authFrom = (json: AuthJson): Auth => ({
  payer: json.payer as Address,
  nonceRef: json.nonceRef === null ? null : { index: json.nonceRef.index, value: json.nonceRef.value as Nonce },
  amount: json.amount === null ? null : BigInt(json.amount),
  signature: fromBase64(json.signature),
});

export const caseNamed = (name: string): PositiveCase => {
  const found = fixtures.cases.find((fixture) => fixture.name === name);
  if (found === undefined) throw new Error(`no positive fixture named ${name}`);
  return found;
};

/** A real VerifiedPayment: verified through core, from the committed bytes. */
export const paymentOf = async (fixture: PositiveCase): Promise<VerifiedPayment> =>
  verifyAuth(intentFrom(fixture.input.intent), authFrom(fixture.auth), fixture.expectedAmount === null ? undefined : BigInt(fixture.expectedAmount));

export interface FakeRpcOptions {
  readonly nonceAccounts?: Readonly<Record<string, NonceAccountState>>;
  readonly balance?: bigint;
  readonly nonceRent?: bigint;
  readonly walletRent?: bigint;
  readonly mint?: RawMintData;
  readonly fetchedAt?: number;
  readonly tokenBalance?: bigint | null;
  readonly frozen?: boolean | null;
  readonly sendSetup?: (instructions: readonly Instruction[], feePayerKey: CryptoKeyPair) => Promise<string>;
  readonly sendPayment?: (wireTransaction: Uint8Array, lifetime: PaymentLifetime) => Promise<string>;
}

export interface FakeRpc extends VadumRpc {
  /** Every sendSetup call, in order, so a test can assert what the pool actually sent. */
  readonly setups: { instructions: readonly Instruction[]; feePayerKey: CryptoKeyPair }[];
  readonly sent: { wireTransaction: Uint8Array; lifetime: PaymentLifetime }[];
  /** Mutable, so a test can advance a nonce account between calls. */
  nonceAccounts: Record<string, NonceAccountState>;
  balance: bigint;
}

export function fakeRpc(options: FakeRpcOptions = {}): FakeRpc {
  const setups: FakeRpc['setups'] = [];
  const sent: FakeRpc['sent'] = [];
  const rpc: FakeRpc = {
    endpoint: 'http://127.0.0.1:8899',
    cluster: 'localnet',
    setups,
    sent,
    nonceAccounts: { ...options.nonceAccounts },
    balance: options.balance ?? 0n,

    async getNonceRentExemption() {
      return options.nonceRent ?? 1_056_640n; // devnet, September 2026 (D39)
    },
    async getRentExemption(dataLength) {
      return dataLength === 0 ? (options.walletRent ?? 890_880n) : 1_056_640n;
    },
    async getMintAccount(mint) {
      if (options.mint === undefined) throw new VadumError('MINT_INCOMPATIBLE', { blockers: [], reason: 'the fake has no mint', mint });
      return { raw: options.mint, fetchedAt: options.fetchedAt ?? 0 };
    },
    async getNonceAccount(address) {
      return rpc.nonceAccounts[address] ?? { kind: 'absent' };
    },
    async getTokenBalance() {
      return options.tokenBalance ?? null;
    },
    async isAtaFrozen() {
      return options.frozen ?? null;
    },
    async getBalance() {
      return rpc.balance;
    },
    async sendSetup(instructions, feePayerKey) {
      setups.push({ instructions, feePayerKey });
      return options.sendSetup === undefined ? 'setup-signature' : options.sendSetup(instructions, feePayerKey);
    },
    async sendPayment(wireTransaction, lifetime) {
      sent.push({ wireTransaction, lifetime });
      return options.sendPayment === undefined ? 'payment-signature' : options.sendPayment(wireTransaction, lifetime);
    },
  };
  return rpc;
}

const plain = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'bigint' ? inner.toString() : inner)));

export async function expectVadumError(run: () => unknown, code: VadumErrorCode, detail?: Readonly<Record<string, unknown>>): Promise<VadumError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${code}, but nothing was thrown`).toBeInstanceOf(VadumError);
  const error = caught as VadumError;
  expect(error.code).toBe(code);
  if (detail !== undefined) expect(plain(error.detail)).toMatchObject(detail);
  return error;
}
