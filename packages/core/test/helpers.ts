// Test helpers: fixture JSON to core types, a seeded PRNG, and error assertions.

import { getAddressDecoder, getBase64Decoder, getBase64Encoder, type Address, type Blockhash, type Nonce } from '@solana/kit';
import type { AuthJson, CanonicalInputJson, IntentJson, NonceRefJson } from '@vadum/fixtures';
import { expect } from 'vitest';
import { VadumError, type Auth, type CanonicalInput, type Intent, type NonceRef, type VadumErrorCode } from '../src/index.ts';

export const fromBase64 = (value: string): Uint8Array => new Uint8Array(getBase64Encoder().encode(value));
export const toBase64 = (bytes: Uint8Array): string => getBase64Decoder().decode(bytes);

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

export const nonceRefFrom = (json: NonceRefJson | null): NonceRef | null =>
  json === null ? null : { index: json.index, value: json.value as Nonce };

export const authFrom = (json: AuthJson): Auth => ({
  payer: json.payer as Address,
  nonceRef: nonceRefFrom(json.nonceRef),
  amount: json.amount === null ? null : BigInt(json.amount),
  signature: fromBase64(json.signature),
});

export const inputFrom = (json: CanonicalInputJson): CanonicalInput => ({
  intent: intentFrom(json.intent),
  payer: json.payer as Address,
  nonceRef: nonceRefFrom(json.nonceRef),
  amount: BigInt(json.amount),
});

const plain = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'bigint' ? inner.toString() : inner)));

/** Asserts `run` throws a VadumError with `code`, and that `detail` is a subset of its detail. */
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

/** mulberry32: reproducible randomness, so a failing property names its seed. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randomBytes = (next: () => number, length: number): Uint8Array =>
  Uint8Array.from({ length }, () => Math.floor(next() * 256));

export const randomAddress = (next: () => number): Address => getAddressDecoder().decode(randomBytes(next, 32));

/** A random canonical input across both lifetimes, both token programs, static and dynamic mode. */
export function randomInput(next: () => number, payer: Address = randomAddress(next)): CanonicalInput {
  const fresh = next() < 0.25;
  const isStatic = !fresh && next() < 0.3;
  const amount = BigInt.asUintN(64, randomBytes(next, 8).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n));
  const merchant = randomAddress(next);
  return {
    intent: {
      merchant,
      mint: randomAddress(next),
      decimals: Math.floor(next() * 10),
      amount: isStatic ? null : amount,
      lifetime: fresh ? { kind: 'fresh', blockhash: randomAddress(next) as string as Blockhash, lastValidBlockHeight: 0n } : { kind: 'nonce' },
      includeCreateAta: next() < 0.5,
      tokenProgram: next() < 0.5 ? 'spl-token' : 'token-2022',
      feePayer: merchant,
      isStatic,
    },
    payer,
    nonceRef: fresh ? null : { index: Math.floor(next() * 256), value: randomAddress(next) as string as Nonce },
    amount,
  };
}
