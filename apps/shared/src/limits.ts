// The payer's own limit on a single offline payment (31-PARAMETERS, T12).
//
// Every cap in `client/queue.ts` is a *merchant* cap: it bounds what a merchant risks by handing over
// before settlement. Nothing bounded what a **payer's device** would sign, which meant an unlocked
// phone in the wrong hands could spend the whole token balance — the thief runs the merchant app and
// scans their own request. Typing the amount again does not defend against that; a thief retypes it.
// A cap does, and it costs no prompt and no platform API — but only together with the spend limit in
// `client/pool.ts`, since a cap per payment says nothing about how many payments.

import { DEFAULT_SPEND_LIMIT, SPEND_LIMIT_WINDOW_MS } from '@vadum/client';

/** 20, in base units of a 6-decimal mint (D23). Matches the highest merchant receipt cap, so it never
 *  refuses a sale a merchant could have accepted. */
export const PAYER_PER_PAYMENT_CAP = 20_000_000n;

/** Above this the payer types the amount again before signing (31-PARAMETERS). Not an identity check. */
export const PAYER_RETYPE_THRESHOLD = 10_000_000n;

export const withinPayerCap = (amount: bigint, cap: bigint = PAYER_PER_PAYMENT_CAP): boolean => amount > 0n && amount <= cap;

export const needsRetype = (amount: bigint, threshold: bigint = PAYER_RETYPE_THRESHOLD): boolean => amount > threshold;

/**
 * What an unlocked stolen device can sign in the app while the thief holds it for `heldForMs`, clock
 * untouched: the spend limit once per started window (T12). Stated so the threat model can quote a
 * number instead of a feeling.
 *
 * This used to be "the cap once per unspent slot", which was false: reconnecting re-arms settled slots,
 * so that bound refilled every time the thief pressed "Refresh". The limit `client/pool.ts` now keeps
 * refills only with time. The number is a ceiling — the balance on the device may run out first.
 */
export const theftExposure = (heldForMs: number, limit: bigint = DEFAULT_SPEND_LIMIT, windowMs: number = SPEND_LIMIT_WINDOW_MS): bigint =>
  limit * BigInt(Math.floor(Math.max(0, heldForMs) / windowMs) + 1);
