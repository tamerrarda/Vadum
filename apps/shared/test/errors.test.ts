// C7's done-when: every non-INTERNAL member of VadumErrorCode maps to copy, and the five codes whose
// wording decides whether the app is honest say what 42-STREAM-C requires.

import { VADUM_ERROR_CODES, type VadumErrorCode } from '@vadum/core';
import { describe, expect, it } from 'vitest';
import { copyFor, FAILURE_COPY, STATE_COPY, USER_FACING_CODES } from '../src/errors.ts';

describe('failure copy', () => {
  it('covers every user-facing code', () => {
    const missing = VADUM_ERROR_CODES.filter((code) => !code.startsWith('INTERNAL_') && !(code in FAILURE_COPY));
    expect(missing).toEqual([]);
    expect(USER_FACING_CODES.length).toBe(VADUM_ERROR_CODES.length - 2);
  });

  it('never says "an error occurred", and always says something specific', () => {
    for (const code of USER_FACING_CODES) {
      const copy = FAILURE_COPY[code];
      expect(copy.title.length, code).toBeGreaterThan(8);
      expect(copy.body.length, code).toBeGreaterThan(30);
      expect(`${copy.title} ${copy.body}`.toLowerCase()).not.toMatch(/an error occurred|something went wrong|unknown error|try again later/);
      // Codes are for logs, not for the person holding the phone.
      expect(copy.title).not.toMatch(/[A-Z]{4,}_/);
      expect(copy.body).not.toMatch(/[A-Z]{4,}_/);
    }
  });

  it('keeps a stale nonce honest and an absent one unreassuring (D21)', () => {
    expect(FAILURE_COPY.SUBMIT_NONCE_STALE.title).toBe('Not charged — another merchant settled this payment first');
    expect(FAILURE_COPY.SUBMIT_NONCE_STALE.body).toMatch(/charged nothing/i);

    const absent = FAILURE_COPY.SUBMIT_NONCE_ABSENT;
    expect(absent.body).toMatch(/the goods are gone/i);
    expect(absent.body).toMatch(/confirmation before handover/i);
    // Nothing in this copy may soften it into a race.
    expect(`${absent.title} ${absent.body}`.toLowerCase()).not.toMatch(/another merchant|race|try again|retry/);
  });

  it('says who pays when execution fails, and why T1 needs a connection', () => {
    expect(FAILURE_COPY.SUBMIT_EXECUTION_FAILED.body).toMatch(/you paid the network fee/i);
    expect(FAILURE_COPY.LIMIT_PRECHECK_REQUIRED.body).toMatch(/online/i);
    expect(FAILURE_COPY.WIRE_UNEXPECTED_TYPE.title).toMatch(/wrong kind of code/i);
  });

  it('tells the payer to reconnect rather than to pay, when the ledger is gone', () => {
    for (const copy of [FAILURE_COPY.NONCE_LEDGER_MISSING, STATE_COPY.recovery]) {
      expect(copy.title).toBe('Cannot pay offline — reconnect once to restore');
      expect(copy.action).toBe('reconnect');
    }
    expect(STATE_COPY['not-installed'].action).toBe('install');
    expect(STATE_COPY['not-installed'].body).toMatch(/home screen/i);
  });

  it('refuses to invent user-facing copy for an internal defect', () => {
    const internal = copyFor('INTERNAL_NOT_IMPLEMENTED' as VadumErrorCode);
    expect(internal.body).toMatch(/defect/i);
    expect(internal.body).toMatch(/nothing was signed or sent/i);
    expect(copyFor('SUBMIT_NONCE_STALE')).toBe(FAILURE_COPY.SUBMIT_NONCE_STALE);
  });
});
