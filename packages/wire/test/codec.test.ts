// B2: the four payload types and the normative check order (D30). Every positive fixture must
// round-trip byte-exactly, and all sixteen codec negatives must throw exactly their code.

import type { Nonce } from '@solana/kit';
import type { VadumErrorCode } from '@vadum/core';
import { fixtures, type NegativeCase, type NegativeTarget } from '@vadum/fixtures';
import { describe, expect, it } from 'vitest';
import { fromBase45 } from '../src/base45.ts';
import {
  decodeAuth,
  decodeIntent,
  decodeNonceReturn,
  decodeStaticIntent,
  encodeAuth,
  encodeIntent,
  encodeNonceReturn,
  encodeStaticIntent,
  expectedLength,
  flagsFromByte,
  flagsToByte,
  peekPayloadType,
  type DecodeContext,
} from '../src/codec.ts';
import { authFrom, contextFrom, expectVadumError, fromBase64, intentFrom, mintCache, toBase64 } from './helpers.ts';

const ctx: DecodeContext = { mintCache: mintCache() };

describe('positive fixtures', () => {
  describe.each(fixtures.cases.map((fixture) => [fixture.name, fixture] as const))('%s', (_name, fixture) => {
    const intent = intentFrom(fixture.input.intent);
    const auth = authFrom(fixture.auth);
    const flags = flagsFromByte(fixture.expected.wireFlags);

    it('encodes the committed intent bytes', () => {
      const bytes = intent.isStatic ? encodeStaticIntent(intent) : encodeIntent(intent);
      expect(toBase64(bytes)).toBe(fixture.expected.wireIntent);
      expect(bytes[2]).toBe(fixture.expected.wireFlags);
      expect(bytes.length).toBe(expectedLength(intent.isStatic ? 'STATIC_INTENT' : 'INTENT', flags));
      expect(peekPayloadType(bytes)).toBe(intent.isStatic ? 'STATIC_INTENT' : 'INTENT');
    });

    it('decodes the intent back to the same value', () => {
      const bytes = fromBase64(fixture.expected.wireIntent);
      const decoded = intent.isStatic ? decodeStaticIntent(bytes, ctx) : decodeIntent(bytes, ctx);
      expect(decoded).toEqual(intent);
    });

    it('encodes the committed AUTH bytes', () => {
      const bytes = encodeAuth(auth, flags);
      expect(toBase64(bytes)).toBe(fixture.expected.wireAuth);
      expect(bytes.length).toBe(expectedLength('AUTH', flags));
      expect(peekPayloadType(bytes)).toBe('AUTH');
    });

    it('decodes the AUTH back to the same value', () => {
      const decoded = decodeAuth(fromBase64(fixture.expected.wireAuth), { ...ctx, intentFlags: flags });
      expect(decoded).toEqual(auth);
    });

    it('derives the same flags byte from the intent as from the fixture', () => {
      expect(flagsToByte(flags)).toBe(fixture.expected.wireFlags);
      expect(flagsFromByte(fixture.expected.wireFlags)).toEqual(flags);
    });
  });
});

describe('nonce return', () => {
  it.each(fixtures.nonceReturn.map((fixture) => [fixture.name, fixture] as const))('%s round-trips', (_name, fixture) => {
    const bytes = fromBase64(fixture.expected.wireNonceReturn);
    const decoded = decodeNonceReturn(bytes);
    expect(decoded.nonceIndex).toBe(fixture.statement.nonceIndex);
    expect(decoded.newNonceValue).toBe(fixture.statement.newNonceValue as Nonce);
    expect(decoded.signature.length).toBe(64);
    expect(toBase64(encodeNonceReturn(decoded))).toBe(fixture.expected.wireNonceReturn);
    expect(peekPayloadType(bytes)).toBe('NONCE_RETURN');
  });
});

describe('expectedLength', () => {
  const flags = (byte: number) => flagsFromByte(byte);

  it('matches the length table in 21-SPEC', () => {
    expect(expectedLength('INTENT', flags(0b00000))).toBe(76);
    expect(expectedLength('INTENT', flags(0b00001))).toBe(108);
    expect(expectedLength('STATIC_INTENT', flags(0b10000))).toBe(68);
    expect(expectedLength('AUTH', flags(0b00000))).toBe(132);
    expect(expectedLength('AUTH', flags(0b10000))).toBe(140);
    expect(expectedLength('AUTH', flags(0b00001))).toBe(99);
    expect(expectedLength('AUTH', flags(0b10001))).toBe(107);
    expect(expectedLength('NONCE_RETURN', flags(0b00000))).toBe(100);
  });
});

type Input = Record<string, unknown>;

function runWireTarget(target: NegativeTarget, input: Input, context: DecodeContext): unknown {
  const bytes = () => fromBase64(input.bytes as string);
  switch (target) {
    case 'wire.peekPayloadType':
      return peekPayloadType(bytes());
    case 'wire.decodeIntent':
      return decodeIntent(bytes(), context);
    case 'wire.decodeStaticIntent':
      return decodeStaticIntent(bytes(), context);
    case 'wire.decodeAuth':
      return decodeAuth(bytes(), context);
    case 'wire.decodeNonceReturn':
      return decodeNonceReturn(bytes());
    case 'wire.fromBase45':
      return fromBase45(input.base45 as string);
    case 'wire.fromBase45 → wire.decodeAuth':
      return decodeAuth(fromBase45(input.base45 as string), context);
    default:
      throw new Error(`not a wire target: ${target}`);
  }
}

const targetsOf = (fixture: NegativeCase): readonly NegativeTarget[] =>
  Array.isArray(fixture.target) ? fixture.target : [fixture.target as NegativeTarget];
const wireNegatives = fixtures.negative.filter((fixture) => targetsOf(fixture).some((target) => target.startsWith('wire.')));

describe('negative fixtures owned by wire', () => {
  it('covers all twenty-one cases', () => {
    expect(wireNegatives.length).toBe(21);
  });

  it.each(wireNegatives.map((fixture) => [fixture.name, fixture] as const))('%s', async (_name, fixture) => {
    for (const target of targetsOf(fixture)) {
      const input = (Array.isArray(fixture.target) ? fixture.input[target] : fixture.input) as Input;
      await expectVadumError(
        () => runWireTarget(target, input, contextFrom(fixture.context)),
        fixture.expectedError as VadumErrorCode,
        fixture.expectedDetail ?? undefined,
      );
    }
  });
});

describe('check order and encoder guards', () => {
  const fixture = fixtures.cases[0];
  if (fixture === undefined) throw new Error('no positive fixtures');
  const intent = intentFrom(fixture.input.intent);
  const auth = authFrom(fixture.auth);
  const flags = flagsFromByte(fixture.expected.wireFlags);
  const authBytes = () => fromBase64(fixture.expected.wireAuth);

  it('reports a reserved bit before the unsupported fee-payer flag', async () => {
    const bytes = authBytes();
    bytes[2] = 0b1000_1000; // bit 7 reserved and bit 3 fee-payer-separate
    await expectVadumError(() => decodeAuth(bytes, { ...ctx, intentFlags: flags }), 'WIRE_RESERVED_FLAG_SET');
  });

  it('reports the unsupported fee-payer flag before a length mismatch', async () => {
    const bytes = authBytes().slice(0, 40);
    bytes[2] = 0b0000_1000;
    await expectVadumError(() => decodeAuth(bytes, { ...ctx, intentFlags: flags }), 'WIRE_FEE_PAYER_SEPARATE_UNSUPPORTED');
  });

  it('reports a length mismatch before comparing flags with the intent', async () => {
    await expectVadumError(() => decodeAuth(authBytes().slice(0, 131), { ...ctx, intentFlags: flags }), 'WIRE_LENGTH_MISMATCH');
  });

  it('refuses to decode an AUTH without the intent flags (rule 6)', async () => {
    await expectVadumError(() => decodeAuth(authBytes(), ctx), 'WIRE_FLAGS_MISMATCH');
  });

  it('peeks a type without looking at the flags', () => {
    const bytes = authBytes();
    bytes[2] = 0b1111_1111;
    expect(peekPayloadType(bytes)).toBe('AUTH');
  });

  it('never sets the reserved fee-payer flag when encoding', async () => {
    const separate = { ...intent, feePayer: auth.payer };
    await expectVadumError(() => encodeIntent(separate), 'WIRE_FEE_PAYER_SEPARATE_UNSUPPORTED');
  });

  it('refuses to encode an intent with the wrong encoder', async () => {
    await expectVadumError(() => encodeStaticIntent(intent), 'WIRE_UNEXPECTED_TYPE', { expected: 'STATIC_INTENT', actual: 'INTENT' });
    await expectVadumError(() => encodeIntent({ ...intent, isStatic: true, amount: null }), 'WIRE_UNEXPECTED_TYPE', { expected: 'INTENT', actual: 'STATIC_INTENT' });
  });

  it('refuses an AUTH whose shape disagrees with the flags it is encoded under', async () => {
    await expectVadumError(() => encodeAuth(auth, { ...flags, lifetimeFresh: true }), 'WIRE_FLAGS_MISMATCH');
    await expectVadumError(() => encodeAuth(auth, { ...flags, amountInAuth: true }), 'WIRE_FLAGS_MISMATCH');
    await expectVadumError(() => encodeAuth({ ...auth, signature: auth.signature.slice(0, 63) }, flags), 'SIG_LENGTH');
  });

  it('refuses a slot index outside 0..255 in both directions', async () => {
    const nonceRef = { index: 256, value: auth.nonceRef?.value ?? ('' as Nonce) };
    await expectVadumError(() => encodeAuth({ ...auth, nonceRef }, flags), 'NONCE_INDEX_OUT_OF_RANGE');
    const signature = new Uint8Array(64);
    await expectVadumError(() => encodeNonceReturn({ nonceIndex: -1, newNonceValue: nonceRef.value, signature }), 'NONCE_INDEX_OUT_OF_RANGE');
  });
});
