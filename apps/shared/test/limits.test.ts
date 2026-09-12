// The payer's own cap (T12). Every other cap in the system protects a merchant; this one is the only
// thing that bounds what a stolen, unlocked phone can sign.

import { DEFAULT_SPEND_LIMIT } from '@vadum/client';
import { describe, expect, it } from 'vitest';
import { needsRetype, PAYER_PER_PAYMENT_CAP, PAYER_RETYPE_THRESHOLD, theftExposure, withinPayerCap } from '../src/limits.ts';

const HOUR = 60 * 60 * 1000;

describe('payer caps', () => {
  it('uses the signed-off numbers (D23)', () => {
    expect(PAYER_PER_PAYMENT_CAP).toBe(20_000_000n);
    expect(PAYER_RETYPE_THRESHOLD).toBe(10_000_000n);
    // The cap must not refuse a sale a merchant could legitimately accept, so it is not below the
    // highest merchant receipt cap.
    expect(PAYER_PER_PAYMENT_CAP).toBeGreaterThanOrEqual(PAYER_RETYPE_THRESHOLD);
    // A payment the cap allows must fit inside a fresh 24-hour limit, or the largest permitted
    // payment could never be signed.
    expect(PAYER_PER_PAYMENT_CAP).toBeLessThanOrEqual(DEFAULT_SPEND_LIMIT);
  });

  it('refuses at the boundary, not one past it', () => {
    expect(withinPayerCap(PAYER_PER_PAYMENT_CAP)).toBe(true);
    expect(withinPayerCap(PAYER_PER_PAYMENT_CAP + 1n)).toBe(false);
    expect(withinPayerCap(0n)).toBe(false);
    expect(withinPayerCap(-1n)).toBe(false);
  });

  it('asks for the amount again only above the threshold', () => {
    expect(needsRetype(PAYER_RETYPE_THRESHOLD)).toBe(false);
    expect(needsRetype(PAYER_RETYPE_THRESHOLD + 1n)).toBe(true);
  });

  it('prices what a stolen unlocked phone can sign, by how long the thief holds it (REV-17)', () => {
    // Not "per unspent slot": reconnecting re-arms slots, and only time refills the spend limit.
    expect(theftExposure(0)).toBe(100_000_000n);
    expect(theftExposure(HOUR * 23)).toBe(100_000_000n);
    // A payment at the start and another as the first window closes: two windows have started.
    expect(theftExposure(HOUR * 24)).toBe(200_000_000n);
    expect(theftExposure(HOUR * 24 * 7)).toBe(800_000_000n);
    expect(theftExposure(-HOUR)).toBe(100_000_000n);
  });
});
