// Reference wire codec for the fixture generator, written from plan/21-SPEC-wire-format.md. The
// encoders produce the committed payloads; `check` applies the normative check order (D30), so the
// generator can prove each negative fixture fails at exactly the step its table row names.
// Deliberately independent of packages/wire (D33).

import type { Address } from '@solana/kit';
import { addressBytes, base58Bytes32, concat, toBase58, u64le } from './bytes.ts';

export const WIRE_VERSION = 0x01;

export const TYPE = { INTENT: 0x01, STATIC_INTENT: 0x02, AUTH: 0x03, NONCE_RETURN: 0x04 } as const;
export type PayloadType = keyof typeof TYPE;

export const FLAG = {
  LIFETIME_FRESH: 1 << 0,
  INCLUDE_CREATE_ATA: 1 << 1,
  TOKEN_2022: 1 << 2,
  FEE_PAYER_SEPARATE: 1 << 3,
  AMOUNT_IN_AUTH: 1 << 4,
} as const;
const FLAG_NAMES = Object.keys(FLAG) as (keyof typeof FLAG)[];
const RESERVED_FLAGS = 0b1110_0000;

const header = (type: PayloadType, flags: number): Uint8Array => Uint8Array.of(WIRE_VERSION, TYPE[type], flags);
const nothing = new Uint8Array();

export interface IntentFields {
  readonly flags: number;
  readonly merchant: Address;
  readonly mint: Address;
  readonly amount: bigint;
  readonly decimals: number;
  /** Present exactly when LIFETIME_FRESH is set. */
  readonly blockhash: string | null;
}

export function encodeIntent(fields: IntentFields): Uint8Array {
  return concat(
    header('INTENT', fields.flags),
    addressBytes(fields.merchant),
    addressBytes(fields.mint),
    u64le(fields.amount),
    Uint8Array.of(fields.decimals),
    fields.blockhash === null ? nothing : base58Bytes32(fields.blockhash),
  );
}

export interface StaticIntentFields {
  readonly flags: number;
  readonly merchant: Address;
  readonly mint: Address;
  readonly decimals: number;
}

export function encodeStaticIntent(fields: StaticIntentFields): Uint8Array {
  return concat(
    header('STATIC_INTENT', fields.flags),
    addressBytes(fields.merchant),
    addressBytes(fields.mint),
    Uint8Array.of(fields.decimals),
  );
}

export interface AuthFields {
  readonly flags: number;
  readonly payer: Address;
  /** Null exactly when LIFETIME_FRESH is set. */
  readonly nonce: { readonly index: number; readonly value: string } | null;
  /** Present exactly when AMOUNT_IN_AUTH is set. */
  readonly amount: bigint | null;
  readonly signature: Uint8Array;
}

export function encodeAuth(fields: AuthFields): Uint8Array {
  return concat(
    header('AUTH', fields.flags),
    addressBytes(fields.payer),
    fields.nonce === null ? nothing : concat(Uint8Array.of(fields.nonce.index), base58Bytes32(fields.nonce.value)),
    fields.amount === null ? nothing : u64le(fields.amount),
    fields.signature,
  );
}

export function encodeNonceReturn(nonceIndex: number, newNonceValue: string, signature: Uint8Array): Uint8Array {
  return concat(header('NONCE_RETURN', 0x00), Uint8Array.of(nonceIndex), base58Bytes32(newNonceValue), signature);
}

/** The (type, flags) -> length table of 21-SPEC, for legal flag combinations. */
export function expectedLength(type: PayloadType, flags: number): number {
  const fresh = (flags & FLAG.LIFETIME_FRESH) !== 0;
  switch (type) {
    case 'INTENT':
      return 76 + (fresh ? 32 : 0);
    case 'STATIC_INTENT':
      return 68;
    case 'AUTH':
      return 35 + (fresh ? 0 : 33) + ((flags & FLAG.AMOUNT_IN_AUTH) !== 0 ? 8 : 0) + 64;
    case 'NONCE_RETURN':
      return 100;
  }
}

/** A rejection with the error code a conforming decoder must raise. */
export class Reject extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>> | undefined;

  constructor(code: string, detail?: Readonly<Record<string, unknown>>) {
    super(detail === undefined ? code : `${code} ${JSON.stringify(detail)}`);
    this.code = code;
    this.detail = detail;
  }
}

export type Entry = 'peekPayloadType' | 'decodeIntent' | 'decodeStaticIntent' | 'decodeAuth' | 'decodeNonceReturn';

const ENTRY_TYPE: Readonly<Record<Exclude<Entry, 'peekPayloadType'>, PayloadType>> = {
  decodeIntent: 'INTENT',
  decodeStaticIntent: 'STATIC_INTENT',
  decodeAuth: 'AUTH',
  decodeNonceReturn: 'NONCE_RETURN',
};

export interface CachedMint {
  readonly tokenProgram: 'spl-token' | 'token-2022';
  readonly decimals: number;
}

export interface CheckContext {
  readonly mintCache?: ReadonlyMap<string, CachedMint> | undefined;
  readonly intentFlags?: number | undefined;
}

/** Check-order steps 2–11 (21-SPEC), from the first that applies. Throws `Reject` on the first failure. */
export function check(entry: Entry, bytes: Uint8Array, context: CheckContext = {}): void {
  if (bytes.length < 3) throw new Reject('WIRE_LENGTH_MISMATCH'); // step 2
  if (bytes[0] !== WIRE_VERSION) throw new Reject('WIRE_VERSION_UNSUPPORTED'); // step 3

  const type = (Object.keys(TYPE) as PayloadType[]).find((name) => TYPE[name] === bytes[1]); // step 4
  if (type === undefined) throw new Reject('WIRE_UNKNOWN_TYPE');
  if (entry === 'peekPayloadType') return;
  if (type !== ENTRY_TYPE[entry]) throw new Reject('WIRE_UNEXPECTED_TYPE', { expected: ENTRY_TYPE[entry], actual: type });

  const flags = bytes[2]!;
  if ((flags & RESERVED_FLAGS) !== 0) throw new Reject('WIRE_RESERVED_FLAG_SET'); // step 5
  if ((flags & FLAG.FEE_PAYER_SEPARATE) !== 0) throw new Reject('WIRE_FEE_PAYER_SEPARATE_UNSUPPORTED'); // step 6

  const forbidden = type === 'INTENT' ? flags & FLAG.AMOUNT_IN_AUTH : type === 'NONCE_RETURN' ? flags : 0; // step 7
  if (forbidden !== 0) {
    throw new Reject('WIRE_FLAG_NOT_ALLOWED_FOR_TYPE', { type, flag: FLAG_NAMES.find((name) => (forbidden & FLAG[name]) !== 0) });
  }

  const fresh = (flags & FLAG.LIFETIME_FRESH) !== 0; // step 8
  if (type === 'STATIC_INTENT' && (fresh || (flags & FLAG.AMOUNT_IN_AUTH) === 0)) throw new Reject('WIRE_STATIC_CONSTRAINT');

  if (bytes.length !== expectedLength(type, flags)) throw new Reject('WIRE_LENGTH_MISMATCH'); // step 9

  if (type === 'AUTH') {
    if (context.intentFlags === undefined) throw new Error('decodeAuth needs the answered intent flags');
    if (flags !== context.intentFlags) throw new Reject('WIRE_FLAGS_MISMATCH'); // step 10
  }

  if (type === 'INTENT' || type === 'STATIC_INTENT') {
    if (context.mintCache === undefined) throw new Error(`${entry} needs a mint cache`);
    const cached = context.mintCache.get(toBase58(bytes.subarray(35, 67))); // step 11
    if (cached === undefined) throw new Reject('MINT_UNKNOWN');
    if (bytes[type === 'INTENT' ? 75 : 67] !== cached.decimals) throw new Reject('MINT_DECIMALS_MISMATCH');
    if (((flags & FLAG.TOKEN_2022) !== 0) !== (cached.tokenProgram === 'token-2022')) {
      throw new Reject('MINT_TOKEN_PROGRAM_MISMATCH');
    }
  }
}
