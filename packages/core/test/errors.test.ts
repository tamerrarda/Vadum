// A1: the taxonomy is a concrete, exhaustive union (plan/23-SPEC-errors.md).

import { describe, expect, it } from 'vitest';
import { VADUM_ERROR_CODES, VadumError, type VadumErrorCode } from '../src/index.ts';

// Compiles only when every member of VadumErrorCode is listed in VADUM_ERROR_CODES; `satisfies` in
// errors.ts already rejects a listed code that is not in the union.
type Unlisted = Exclude<VadumErrorCode, (typeof VADUM_ERROR_CODES)[number]>;
const exhaustive: [Unlisted] extends [never] ? true : Unlisted = true;

describe('VadumError taxonomy', () => {
  it('lists every code exactly once', () => {
    expect(exhaustive).toBe(true);
    expect(new Set(VADUM_ERROR_CODES).size).toBe(VADUM_ERROR_CODES.length);
    expect(VADUM_ERROR_CODES.length).toBe(46);
  });

  it('uses only the documented prefixes', () => {
    for (const code of VADUM_ERROR_CODES) expect(code).toMatch(/^(WIRE|MINT|CANON|SIG|NONCE|LIMIT|SUBMIT|INTERNAL)_[A-Z0-9_]+$/);
  });

  it('carries code and detail, and survives bigint detail in its message', () => {
    const error = new VadumError('CANON_AMOUNT_MISMATCH', { expected: 5n, actual: 6n });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('VadumError');
    expect(error.code).toBe('CANON_AMOUNT_MISMATCH');
    expect(error.detail).toEqual({ expected: 5n, actual: 6n });
    expect(error.message).toContain('"expected":"5"');
    expect(new VadumError('SIG_INVALID').detail).toBeUndefined();
  });
});
