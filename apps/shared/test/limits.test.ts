// The payer's own cap (T12). Every other cap in the system protects a merchant; this one is the only
// thing that bounds what a stolen, unlocked phone can sign.

import { describe, expect, it } from 'vitest';
import { needsRetype, PAYER_PER_PAYMENT_CAP, PAYER_RETYPE_THRESHOLD, theftExposure, withinPayerCap } from '../src/limits.ts';

describe('payer caps', () => {
  it('uses the signed-off numbers (D23)', () => {
    expect(PAYER_PER_PAYMENT_CAP).toBe(20_000_000n);
    expect(PAYER_RETYPE_THRESHOLD).toBe(10_000_000n);
    // The cap must not refuse a sale a merchant could legitimately accept, so it is not below the
    // highest merchant receipt cap.
    expect(PAYER_PER_PAYMENT_CAP).toBeGreaterThanOrEqual(PAYER_RETYPE_THRESHOLD);
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

  it('prices what a stolen unlocked phone can spend before the payer reconnects', () => {
    // The cap, once per unspent slot. With N=5 (D23) that is 100 base units, not the whole balance.
    expect(theftExposure(5)).toBe(100_000_000n);
    expect(theftExposure(0)).toBe(0n);
    expect(theftExposure(-3)).toBe(0n);
  });
});
