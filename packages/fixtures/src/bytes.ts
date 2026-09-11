// Byte helpers for the fixture generator.

import { getAddressEncoder, getBase58Decoder, getBase58Encoder, getBase64Decoder, type Address } from '@solana/kit';

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

export const addressBytes = (address: Address): Uint8Array => new Uint8Array(getAddressEncoder().encode(address));

/** A base58 string that must decode to exactly 32 bytes: a nonce value or a blockhash. */
export function base58Bytes32(value: string): Uint8Array {
  const bytes = new Uint8Array(getBase58Encoder().encode(value));
  if (bytes.length !== 32) throw new Error(`expected 32 bytes, got ${bytes.length} from ${value}`);
  return bytes;
}

export const toBase58 = (bytes: Uint8Array): string => getBase58Decoder().decode(bytes);
export const toBase64 = (bytes: Uint8Array): string => getBase64Decoder().decode(bytes);

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);
