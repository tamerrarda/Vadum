// RFC 9285 base45, vendored (D12). `base45@2.0.1` accepts out-of-alphabet characters and invalid
// lengths and returns wrong bytes instead of throwing, which is the whole reason this file exists.
//
// The alphabet contains SPACE, and spaces are data: 94% of 132-byte AUTH payloads contain one and
// about 3% contain two adjacent (D29). Nothing here trims, strips or normalises.

import { VadumError } from '@vadum/core';

export const BASE45_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

const VALUES = new Map<string, number>([...BASE45_ALPHABET].map((character, value) => [character, value]));

const invalid = (reason: string, detail: Readonly<Record<string, unknown>> = {}): VadumError =>
  new VadumError('WIRE_BASE45_INVALID', { reason, ...detail });

/** 3 characters per 2 bytes, 2 characters for an odd trailing byte (transport MUST 1). */
export function toBase45(bytes: Uint8Array): string {
  let out = '';
  let index = 0;
  for (; index + 1 < bytes.length; index += 2) {
    let value = bytes[index]! * 256 + bytes[index + 1]!;
    const c = Math.floor(value / 2025);
    value -= c * 2025;
    const d = Math.floor(value / 45);
    out += BASE45_ALPHABET[value - d * 45]! + BASE45_ALPHABET[d]! + BASE45_ALPHABET[c]!;
  }
  if (index < bytes.length) {
    const value = bytes[index]!;
    const d = Math.floor(value / 45);
    out += BASE45_ALPHABET[value - d * 45]! + BASE45_ALPHABET[d]!;
  }
  return out;
}

/**
 * Every rejection receive rule 11 lists (D37). An unknown character is never mapped to −1 and carried
 * into the arithmetic, and no length, group or tail is repaired.
 */
export function fromBase45(s: string): Uint8Array {
  if (s.length % 3 === 1) throw invalid('length % 3 == 1', { length: s.length });

  const digits = new Array<number>(s.length);
  for (let index = 0; index < s.length; index++) {
    const value = VALUES.get(s[index]!);
    if (value === undefined) throw invalid('character outside the RFC 9285 alphabet', { index, character: s[index] });
    digits[index] = value;
  }

  const out = new Uint8Array(Math.floor(s.length / 3) * 2 + (s.length % 3 === 2 ? 1 : 0));
  let at = 0;
  let index = 0;
  for (; index + 2 < s.length; index += 3) {
    const value = digits[index]! + digits[index + 1]! * 45 + digits[index + 2]! * 2025;
    if (value > 0xffff) throw invalid('a 3-character group decodes above 0xFFFF', { index, value });
    out[at++] = value >> 8;
    out[at++] = value & 0xff;
  }
  if (index < s.length) {
    const value = digits[index]! + digits[index + 1]! * 45;
    if (value > 0xff) throw invalid('a 2-character tail decodes above 0xFF', { index, value });
    out[at++] = value;
  }
  return out;
}
