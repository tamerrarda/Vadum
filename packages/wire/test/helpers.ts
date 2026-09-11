// Fixture JSON to the types wire speaks, plus error assertions. `@vadum/fixtures` is data only (D33).

import { getBase64Decoder, getBase64Encoder, type Address, type Blockhash, type Nonce } from '@solana/kit';
import { VadumError, type Auth, type Intent, type MintRecord, type VadumErrorCode } from '@vadum/core';
import { fixtures, type AuthJson, type IntentJson, type MintRecordJson } from '@vadum/fixtures';
import { expect } from 'vitest';
import { flagsFromByte, type DecodeContext } from '../src/codec.ts';

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

export const authFrom = (json: AuthJson): Auth => ({
  payer: json.payer as Address,
  nonceRef: json.nonceRef === null ? null : { index: json.nonceRef.index, value: json.nonceRef.value as Nonce },
  amount: json.amount === null ? null : BigInt(json.amount),
  signature: fromBase64(json.signature),
});

const mintRecordFrom = (json: MintRecordJson): MintRecord => ({
  mint: json.mint as Address,
  tokenProgram: json.tokenProgram,
  decimals: json.decimals,
  compatible: json.compatible,
  blockers: json.blockers as MintRecord['blockers'],
  warnings: json.warnings as MintRecord['warnings'],
  mutable: json.mutable,
  checkedAt: json.checkedAt,
});

/** The committed mint records as a cache, optionally narrowed to the mints a fixture names. */
export const mintCache = (mints?: readonly string[]): ReadonlyMap<Address, MintRecord> =>
  new Map(
    fixtures.mintRecords
      .filter((record) => mints === undefined || mints.includes(record.mint))
      .map((record) => [record.mint as Address, mintRecordFrom(record)]),
  );

/** A negative case's `context` block as a DecodeContext. */
export function contextFrom(context: Readonly<Record<string, unknown>> | undefined): DecodeContext {
  const intentFlags = context?.intentFlags;
  const mints = context?.mintCache as readonly string[] | undefined;
  return typeof intentFlags === 'number'
    ? { mintCache: mintCache(mints), intentFlags: flagsFromByte(intentFlags) }
    : { mintCache: mintCache(mints) };
}

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

export const randomBytes = (next: () => number, length: number): Uint8Array => Uint8Array.from({ length }, () => Math.floor(next() * 256));
