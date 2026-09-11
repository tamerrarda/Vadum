// Reference RFC 9285 base45 for the fixture generator, written from plan/21-SPEC-wire-format.md and
// plan/25-SPEC-wire-api.md. Deliberately independent of packages/wire (D33).

export const BASE45_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

export class Base45Error extends Error {}

/** 3 characters per 2 bytes, 2 characters for an odd trailing byte. Spaces are data. */
export function toBase45(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const n = bytes[i]! * 256 + bytes[i + 1]!;
    out += BASE45_ALPHABET[n % 45]! + BASE45_ALPHABET[Math.floor(n / 45) % 45]! + BASE45_ALPHABET[Math.floor(n / 2025)]!;
  }
  if (bytes.length % 2 === 1) {
    const b = bytes[bytes.length - 1]!;
    out += BASE45_ALPHABET[b % 45]! + BASE45_ALPHABET[Math.floor(b / 45)]!;
  }
  return out;
}

/**
 * Strict decode: never trims, never maps an unknown character to -1. Rejects a character outside
 * the alphabet, a length where `len % 3 === 1`, a 3-character group above 0xFFFF, and a 2-character
 * tail above 0xFF.
 */
export function fromBase45(text: string): Uint8Array {
  if (text.length % 3 === 1) throw new Base45Error('length % 3 === 1');
  const values = Array.from(text, (ch) => {
    const value = BASE45_ALPHABET.indexOf(ch);
    if (value < 0) throw new Base45Error(`character outside the alphabet: ${JSON.stringify(ch)}`);
    return value;
  });
  const out: number[] = [];
  for (let i = 0; i < values.length; i += 3) {
    if (i + 2 < values.length) {
      const n = values[i]! + values[i + 1]! * 45 + values[i + 2]! * 2025;
      if (n > 0xffff) throw new Base45Error(`group above 0xFFFF at character ${i}`);
      out.push(n >> 8, n & 0xff);
    } else {
      const n = values[i]! + values[i + 1]! * 45;
      if (n > 0xff) throw new Base45Error(`tail above 0xFF at character ${i}`);
      out.push(n);
    }
  }
  return Uint8Array.from(out);
}
