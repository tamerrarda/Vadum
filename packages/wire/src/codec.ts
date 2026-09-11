// The four payload types of plan/21-SPEC-wire-format.md, and receive rules 1–6, 8, 10 and 11 in the
// normative check order (D30). Structural only: nothing here verifies a signature, deduplicates, or
// touches the network. Little-endian integers, raw 32-byte keys.

import { getAddressDecoder, getAddressEncoder, getBase58Decoder, getBase58Encoder, type Address, type Blockhash, type Nonce } from '@solana/kit';
import { VadumError, type Auth, type Intent, type MintRecord, type TokenProgram } from '@vadum/core';

export type PayloadType = 'INTENT' | 'STATIC_INTENT' | 'AUTH' | 'NONCE_RETURN';

export interface WireFlags {
  readonly lifetimeFresh: boolean; // bit 0
  readonly includeCreateAta: boolean; // bit 1
  readonly token2022: boolean; // bit 2
  readonly feePayerSeparate: boolean; // bit 3 — always false in v1 (D19)
  readonly amountInAuth: boolean; // bit 4
}

export interface DecodeContext {
  /** The caller's local mint compatibility cache. Receive rules 4 and 5. */
  readonly mintCache: ReadonlyMap<Address, MintRecord>;
  /** Required when decoding an AUTH: the flags of the intent being answered (rule 6). */
  readonly intentFlags?: WireFlags;
}

export interface NonceReturnPayload {
  readonly nonceIndex: number;
  readonly newNonceValue: Nonce;
  /** 64 bytes, from core.signNonceReturn — NOT verified here (D30). */
  readonly signature: Uint8Array;
}

const VERSION = 0x01;
const HEADER_BYTES = 3;
const KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const U64_MAX = (1n << 64n) - 1n;

const TYPE_BYTE: Readonly<Record<PayloadType, number>> = { INTENT: 0x01, STATIC_INTENT: 0x02, AUTH: 0x03, NONCE_RETURN: 0x04 };
const TYPE_NAME = new Map<number, PayloadType>(Object.entries(TYPE_BYTE).map(([name, byte]) => [byte, name as PayloadType]));

const FLAG = { LIFETIME_FRESH: 0b0000_0001, INCLUDE_CREATE_ATA: 0b0000_0010, TOKEN_2022: 0b0000_0100, FEE_PAYER_SEPARATE: 0b0000_1000, AMOUNT_IN_AUTH: 0b0001_0000 } as const;
const RESERVED_BITS = 0b1110_0000;

export const flagsFromByte = (byte: number): WireFlags => ({
  lifetimeFresh: (byte & FLAG.LIFETIME_FRESH) !== 0,
  includeCreateAta: (byte & FLAG.INCLUDE_CREATE_ATA) !== 0,
  token2022: (byte & FLAG.TOKEN_2022) !== 0,
  feePayerSeparate: (byte & FLAG.FEE_PAYER_SEPARATE) !== 0,
  amountInAuth: (byte & FLAG.AMOUNT_IN_AUTH) !== 0,
});

export const flagsToByte = (flags: WireFlags): number =>
  (flags.lifetimeFresh ? FLAG.LIFETIME_FRESH : 0) |
  (flags.includeCreateAta ? FLAG.INCLUDE_CREATE_ATA : 0) |
  (flags.token2022 ? FLAG.TOKEN_2022 : 0) |
  (flags.feePayerSeparate ? FLAG.FEE_PAYER_SEPARATE : 0) |
  (flags.amountInAuth ? FLAG.AMOUNT_IN_AUTH : 0);

/** The (type, flags) → length table from 21-SPEC, as a function: rule 3 has one implementation. */
export function expectedLength(type: PayloadType, flags: WireFlags): number {
  switch (type) {
    case 'INTENT':
      return 76 + (flags.lifetimeFresh ? KEY_BYTES : 0) + (flags.feePayerSeparate ? KEY_BYTES : 0);
    case 'STATIC_INTENT':
      return 68;
    case 'AUTH':
      return 99 + (flags.lifetimeFresh ? 0 : 33) + (flags.amountInAuth ? 8 : 0);
    case 'NONCE_RETURN':
      return 100;
  }
}

// ─── reading and writing fields ────────────────────────────────────────────────────────────────────

const addressAt = (bytes: Uint8Array, offset: number): Address => getAddressDecoder().decode(bytes.subarray(offset, offset + KEY_BYTES));
const base58At = (bytes: Uint8Array, offset: number): string => getBase58Decoder().decode(bytes.subarray(offset, offset + KEY_BYTES));
const u64At = (bytes: Uint8Array, offset: number): bigint => new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(offset, true);

const writeKey = (out: Uint8Array, offset: number, value: string): void => {
  const bytes = new Uint8Array(getBase58Encoder().encode(value));
  if (bytes.length !== KEY_BYTES) throw new VadumError('WIRE_LENGTH_MISMATCH', { reason: 'a key is not 32 bytes', value, length: bytes.length });
  out.set(bytes, offset);
};

const writeAddress = (out: Uint8Array, offset: number, value: Address): void => out.set(getAddressEncoder().encode(value), offset);

const writeU64 = (out: Uint8Array, offset: number, value: bigint): void => {
  if (value < 0n || value > U64_MAX) throw new VadumError('WIRE_LENGTH_MISMATCH', { reason: 'amount does not fit the 8-byte field', value });
  new DataView(out.buffer, out.byteOffset).setBigUint64(offset, value, true);
};

const writeHeader = (out: Uint8Array, type: PayloadType, flags: WireFlags): void => {
  if (flags.feePayerSeparate) throw new VadumError('WIRE_FEE_PAYER_SEPARATE_UNSUPPORTED', { type });
  out[0] = VERSION;
  out[1] = TYPE_BYTE[type];
  out[2] = flagsToByte(flags);
};

const flagsOf = (intent: Intent): WireFlags => ({
  lifetimeFresh: intent.lifetime.kind === 'fresh',
  includeCreateAta: intent.includeCreateAta,
  token2022: intent.tokenProgram === 'token-2022',
  feePayerSeparate: intent.feePayer !== intent.merchant, // rejected by writeHeader: unsupported in v1 (D19)
  amountInAuth: intent.isStatic,
});

// ─── the check order (D30) ─────────────────────────────────────────────────────────────────────────

/** Steps 2–4: length ≥ 3, version, and a known type equal to the caller's own. */
function readType(bytes: Uint8Array, expected?: PayloadType): PayloadType {
  if (bytes.length < HEADER_BYTES) throw new VadumError('WIRE_LENGTH_MISMATCH', { reason: 'shorter than the 3-byte header', length: bytes.length });
  if (bytes[0] !== VERSION) throw new VadumError('WIRE_VERSION_UNSUPPORTED', { version: bytes[0] });
  const type = TYPE_NAME.get(bytes[1]!);
  if (type === undefined) throw new VadumError('WIRE_UNKNOWN_TYPE', { type: bytes[1] });
  if (expected !== undefined && type !== expected) throw new VadumError('WIRE_UNEXPECTED_TYPE', { expected, actual: type });
  return type;
}

const FLAG_NAME: readonly (readonly [number, string])[] = [
  [FLAG.LIFETIME_FRESH, 'LIFETIME_FRESH'],
  [FLAG.INCLUDE_CREATE_ATA, 'INCLUDE_CREATE_ATA'],
  [FLAG.TOKEN_2022, 'TOKEN_2022'],
  [FLAG.AMOUNT_IN_AUTH, 'AMOUNT_IN_AUTH'],
];

/** Steps 5–9. Returns the flags and the payload's own length, already checked. */
function readHeader(bytes: Uint8Array, expected: PayloadType): WireFlags {
  const type = readType(bytes, expected);
  const flagsByte = bytes[2]!;

  if ((flagsByte & RESERVED_BITS) !== 0) throw new VadumError('WIRE_RESERVED_FLAG_SET', { flags: flagsByte }); // step 5
  if ((flagsByte & FLAG.FEE_PAYER_SEPARATE) !== 0) throw new VadumError('WIRE_FEE_PAYER_SEPARATE_UNSUPPORTED', { type }); // step 6

  const forbidden = type === 'INTENT' ? flagsByte & FLAG.AMOUNT_IN_AUTH : type === 'NONCE_RETURN' ? flagsByte : 0; // step 7
  if (forbidden !== 0) {
    const flag = FLAG_NAME.find(([bit]) => (forbidden & bit) !== 0)?.[1];
    throw new VadumError('WIRE_FLAG_NOT_ALLOWED_FOR_TYPE', { type, flag });
  }

  const flags = flagsFromByte(flagsByte);
  if (type === 'STATIC_INTENT') {
    // step 8: a printed sticker carries no live blockhash, and the merchant does not know the amount
    if (flags.lifetimeFresh) throw new VadumError('WIRE_STATIC_CONSTRAINT', { reason: 'LIFETIME_FRESH is set on a printed intent' });
    if (!flags.amountInAuth) throw new VadumError('WIRE_STATIC_CONSTRAINT', { reason: 'AMOUNT_IN_AUTH is clear on a printed intent' });
  }

  const length = expectedLength(type, flags); // step 9
  if (bytes.length !== length) throw new VadumError('WIRE_LENGTH_MISMATCH', { type, expected: length, actual: bytes.length });
  return flags;
}

/** Step 11, on both intent types: the mint is cached, and its decimals and token program agree. */
function checkAgainstCache(ctx: DecodeContext, mint: Address, decimals: number, flags: WireFlags): TokenProgram {
  const record = ctx.mintCache.get(mint);
  if (record === undefined) throw new VadumError('MINT_UNKNOWN', { mint });
  if (record.decimals !== decimals) throw new VadumError('MINT_DECIMALS_MISMATCH', { mint, expected: record.decimals, actual: decimals });
  const tokenProgram: TokenProgram = flags.token2022 ? 'token-2022' : 'spl-token';
  if (record.tokenProgram !== tokenProgram) throw new VadumError('MINT_TOKEN_PROGRAM_MISMATCH', { mint, expected: record.tokenProgram, actual: tokenProgram });
  return tokenProgram;
}

// ─── INTENT 0x01 ───────────────────────────────────────────────────────────────────────────────────

/** Routes a scanned QR to a screen before a typed decoder is chosen. Steps 2–4 only. */
export function peekPayloadType(bytes: Uint8Array): PayloadType {
  return readType(bytes);
}

export function encodeIntent(intent: Intent): Uint8Array {
  if (intent.isStatic) throw new VadumError('WIRE_UNEXPECTED_TYPE', { expected: 'INTENT', actual: 'STATIC_INTENT' });
  if (intent.amount === null) throw new VadumError('WIRE_STATIC_CONSTRAINT', { reason: 'a dynamic intent carries its amount' });
  const flags = flagsOf(intent);
  const out = new Uint8Array(expectedLength('INTENT', flags));
  writeHeader(out, 'INTENT', flags);
  writeAddress(out, 3, intent.merchant);
  writeAddress(out, 35, intent.mint);
  writeU64(out, 67, intent.amount);
  out[75] = intent.decimals;
  if (intent.lifetime.kind === 'fresh') writeKey(out, 76, intent.lifetime.blockhash);
  return out;
}

export function decodeIntent(bytes: Uint8Array, ctx: DecodeContext): Intent {
  const flags = readHeader(bytes, 'INTENT');
  const merchant = addressAt(bytes, 3);
  const mint = addressAt(bytes, 35);
  const amount = u64At(bytes, 67);
  const decimals = bytes[75]!;
  const tokenProgram = checkAgainstCache(ctx, mint, decimals, flags);
  return {
    merchant,
    mint,
    decimals,
    amount,
    // The payer never sees lastValidBlockHeight and it does not affect messageBytes (22-SPEC).
    lifetime: flags.lifetimeFresh ? { kind: 'fresh', blockhash: base58At(bytes, 76) as Blockhash, lastValidBlockHeight: 0n } : { kind: 'nonce' },
    includeCreateAta: flags.includeCreateAta,
    tokenProgram,
    feePayer: merchant, // FEE_PAYER_SEPARATE is rejected above, so the two always coincide in v1 (D19)
    isStatic: false,
  };
}

// ─── STATIC_INTENT 0x02 ────────────────────────────────────────────────────────────────────────────

export function encodeStaticIntent(intent: Intent): Uint8Array {
  if (!intent.isStatic) throw new VadumError('WIRE_UNEXPECTED_TYPE', { expected: 'STATIC_INTENT', actual: 'INTENT' });
  if (intent.amount !== null) throw new VadumError('WIRE_STATIC_CONSTRAINT', { reason: 'a printed intent carries no amount' });
  if (intent.lifetime.kind === 'fresh') throw new VadumError('WIRE_STATIC_CONSTRAINT', { reason: 'a printed intent cannot carry a blockhash' });
  const flags = flagsOf(intent);
  const out = new Uint8Array(expectedLength('STATIC_INTENT', flags));
  writeHeader(out, 'STATIC_INTENT', flags);
  writeAddress(out, 3, intent.merchant);
  writeAddress(out, 35, intent.mint);
  out[67] = intent.decimals;
  return out;
}

export function decodeStaticIntent(bytes: Uint8Array, ctx: DecodeContext): Intent {
  const flags = readHeader(bytes, 'STATIC_INTENT');
  const merchant = addressAt(bytes, 3);
  const mint = addressAt(bytes, 35);
  const decimals = bytes[67]!;
  const tokenProgram = checkAgainstCache(ctx, mint, decimals, flags);
  return {
    merchant,
    mint,
    decimals,
    amount: null,
    lifetime: { kind: 'nonce' }, // static mode implies the durable nonce path (21-SPEC)
    includeCreateAta: flags.includeCreateAta,
    tokenProgram,
    feePayer: merchant,
    isStatic: true,
  };
}

// ─── AUTH 0x03 ─────────────────────────────────────────────────────────────────────────────────────

export function encodeAuth(auth: Auth, flags: WireFlags): Uint8Array {
  if (auth.signature.length !== SIGNATURE_BYTES) throw new VadumError('SIG_LENGTH', { length: auth.signature.length });
  if (flags.lifetimeFresh !== (auth.nonceRef === null)) {
    throw new VadumError('WIRE_FLAGS_MISMATCH', { reason: 'LIFETIME_FRESH disagrees with the nonce reference', lifetimeFresh: flags.lifetimeFresh });
  }
  if (flags.amountInAuth !== (auth.amount !== null)) {
    throw new VadumError('WIRE_FLAGS_MISMATCH', { reason: 'AMOUNT_IN_AUTH disagrees with the amount', amountInAuth: flags.amountInAuth });
  }
  const out = new Uint8Array(expectedLength('AUTH', flags));
  writeHeader(out, 'AUTH', flags);
  writeAddress(out, 3, auth.payer);
  let offset = 35;
  if (auth.nonceRef !== null) {
    if (!Number.isInteger(auth.nonceRef.index) || auth.nonceRef.index < 0 || auth.nonceRef.index > 255) {
      throw new VadumError('NONCE_INDEX_OUT_OF_RANGE', { index: auth.nonceRef.index });
    }
    out[offset++] = auth.nonceRef.index;
    writeKey(out, offset, auth.nonceRef.value);
    offset += KEY_BYTES;
  }
  if (auth.amount !== null) {
    writeU64(out, offset, auth.amount);
    offset += 8;
  }
  out.set(auth.signature, offset);
  return out;
}

export function decodeAuth(bytes: Uint8Array, ctx: DecodeContext): Auth {
  const flags = readHeader(bytes, 'AUTH');
  // Step 10, rule 6: the AUTH must echo the intent's flags byte for byte. Without the intent there is
  // nothing to compare against, and passing the payload's own flags would check nothing.
  if (ctx.intentFlags === undefined) throw new VadumError('WIRE_FLAGS_MISMATCH', { reason: 'DecodeContext.intentFlags is required to decode an AUTH' });
  const expected = flagsToByte(ctx.intentFlags);
  if (expected !== bytes[2]) throw new VadumError('WIRE_FLAGS_MISMATCH', { expected, actual: bytes[2] });

  const payer = addressAt(bytes, 3);
  let offset = 35;
  let nonceRef: Auth['nonceRef'] = null;
  if (!flags.lifetimeFresh) {
    nonceRef = { index: bytes[offset]!, value: base58At(bytes, offset + 1) as Nonce };
    offset += 1 + KEY_BYTES;
  }
  let amount: bigint | null = null;
  if (flags.amountInAuth) {
    amount = u64At(bytes, offset);
    offset += 8;
  }
  return { payer, nonceRef, amount, signature: bytes.slice(offset, offset + SIGNATURE_BYTES) };
}

// ─── NONCE_RETURN 0x04 ─────────────────────────────────────────────────────────────────────────────

const NO_FLAGS: WireFlags = { lifetimeFresh: false, includeCreateAta: false, token2022: false, feePayerSeparate: false, amountInAuth: false };

export function encodeNonceReturn(payload: NonceReturnPayload): Uint8Array {
  if (!Number.isInteger(payload.nonceIndex) || payload.nonceIndex < 0 || payload.nonceIndex > 255) {
    throw new VadumError('NONCE_INDEX_OUT_OF_RANGE', { index: payload.nonceIndex });
  }
  if (payload.signature.length !== SIGNATURE_BYTES) throw new VadumError('SIG_LENGTH', { length: payload.signature.length });
  const out = new Uint8Array(expectedLength('NONCE_RETURN', NO_FLAGS));
  writeHeader(out, 'NONCE_RETURN', NO_FLAGS);
  out[3] = payload.nonceIndex;
  writeKey(out, 4, payload.newNonceValue);
  out.set(payload.signature, 36);
  return out;
}

/** Structural only (D30): version, type, flags 0x00, length 100. The signature is core's to verify. */
export function decodeNonceReturn(bytes: Uint8Array): NonceReturnPayload {
  readHeader(bytes, 'NONCE_RETURN');
  return { nonceIndex: bytes[3]!, newNonceValue: base58At(bytes, 4) as Nonce, signature: bytes.slice(36, 36 + SIGNATURE_BYTES) };
}
