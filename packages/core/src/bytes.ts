// Byte helpers shared by the validator and the recovery statement.

import { getAddressEncoder, getBase58Encoder, type Address } from '@solana/kit';

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export const addressBytes = (address: Address): Uint8Array => new Uint8Array(getAddressEncoder().encode(address));

/** A base58 value that must decode to exactly 32 bytes; null when it does not. */
export function base58Bytes32(value: string): Uint8Array | null {
  try {
    const bytes = new Uint8Array(getBase58Encoder().encode(value));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}
