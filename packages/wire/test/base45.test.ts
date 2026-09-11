// B1: RFC 9285 base45, including the defects that made D12 vendor it. A suite that tested only valid
// input would have passed with base45@2.0.1's bugs intact.

import { fixtures } from '@vadum/fixtures';
import { describe, expect, it } from 'vitest';
import { BASE45_ALPHABET, fromBase45, toBase45 } from '../src/base45.ts';
import { expectVadumError, fromBase64, prng, randomBytes } from './helpers.ts';

const ALPHABET_RE = /^[0-9A-Z $%*+\-./:]*$/;

describe('BASE45_ALPHABET', () => {
  it('is RFC 9285’s 45 characters, in order', () => {
    expect(BASE45_ALPHABET).toBe('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:');
    expect(BASE45_ALPHABET.length).toBe(45);
    expect(new Set(BASE45_ALPHABET).size).toBe(45);
  });
});

describe('committed strings', () => {
  const payloads = fixtures.cases.flatMap((fixture) => [
    [`${fixture.name} intent`, fixture.expected.wireIntent, fixture.expected.wireIntentBase45] as const,
    [`${fixture.name} auth`, fixture.expected.wireAuth, fixture.expected.wireAuthBase45] as const,
  ]);
  const nonceReturns = fixtures.nonceReturn.map(
    (fixture) => [`${fixture.name}`, fixture.expected.wireNonceReturn, fixture.expected.wireNonceReturnBase45] as const,
  );

  it.each([...payloads, ...nonceReturns])('%s encodes and decodes verbatim', (_name, base64, base45) => {
    const bytes = fromBase64(base64);
    expect(toBase45(bytes)).toBe(base45);
    expect(fromBase45(base45)).toEqual(bytes);
    // Transport MUST 1: 3 characters per 2 bytes, 2 for an odd trailing byte.
    expect(base45.length).toBe(Math.floor(bytes.length / 2) * 3 + (bytes.length % 2 === 1 ? 2 : 0));
  });

  it('records the AUTH length the measurement table is built on', () => {
    for (const fixture of fixtures.cases) expect(fixture.expected.wireAuthBase45.length).toBe(fixture.expected.wireAuthBase45Length);
  });

  it('keeps the double space of base45-double-space intact', () => {
    const fixture = fixtures.cases.find((candidate) => candidate.name === 'base45-double-space');
    if (fixture === undefined) throw new Error('the double-space fixture is missing');
    expect(fixture.expected.wireAuthBase45).toContain('  ');
    expect(toBase45(fromBase64(fixture.expected.wireAuth))).toContain('  ');
  });
});

describe('negative fixtures', () => {
  const cases = fixtures.negative.filter((fixture) => [fixture.target].flat().some((target) => String(target).startsWith('wire.fromBase45')));

  it('covers all five base45 cases', () => {
    expect(cases.length).toBe(5);
  });

  it.each(cases.map((fixture) => [fixture.name, fixture.input.base45 as string] as const))('%s', async (_name, base45) => {
    await expectVadumError(() => fromBase45(base45), 'WIRE_BASE45_INVALID');
  });

  it('rejects lowercase, which base45@2.0.1 accepted', async () => {
    await expectVadumError(() => fromBase45('w50'), 'WIRE_BASE45_INVALID', { character: 'w' });
  });

  it('rejects the overflowing group and tail from D37', async () => {
    await expectVadumError(() => fromBase45(':::'), 'WIRE_BASE45_INVALID', { value: 44 + 44 * 45 + 44 * 2025 });
    await expectVadumError(() => fromBase45('000::'), 'WIRE_BASE45_INVALID', { value: 44 + 44 * 45 });
  });

  it('rejects every length where len % 3 == 1', async () => {
    for (const length of [1, 4, 7, 100]) await expectVadumError(() => fromBase45('0'.repeat(length)), 'WIRE_BASE45_INVALID', { length });
  });
});

describe('properties (D29)', () => {
  it('round-trips random bytes and never ends with a space', { timeout: 120_000 }, () => {
    const next = prng(11);
    for (let run = 0; run < 100_000; run++) {
      const bytes = randomBytes(next, 1 + Math.floor(next() * 140));
      const text = toBase45(bytes);
      expect(ALPHABET_RE.test(text), `run ${run}: ${text}`).toBe(true);
      expect(text.endsWith(' '), `run ${run}: ends with a space`).toBe(false);
      expect(fromBase45(text), `run ${run}`).toEqual(bytes);
    }
  });

  it('starts every committed payload with W50, X50, Y50 or Z50', () => {
    const strings = [
      ...fixtures.cases.flatMap((fixture) => [fixture.expected.wireIntentBase45, fixture.expected.wireAuthBase45]),
      ...fixtures.nonceReturn.map((fixture) => fixture.expected.wireNonceReturnBase45),
    ];
    for (const text of strings) expect(text.slice(0, 3)).toMatch(/^[WXYZ]50$/);
  });

  it('encodes the empty payload as the empty string', () => {
    expect(toBase45(new Uint8Array(0))).toBe('');
    expect(fromBase45('')).toEqual(new Uint8Array(0));
  });
});
