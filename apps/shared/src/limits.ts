// The payer's own limit on a single offline payment (31-PARAMETERS, T12).
//
// Every cap in `client/queue.ts` is a *merchant* cap: it bounds what a merchant risks by handing over
// before settlement. Nothing bounded what a **payer's device** would sign, which meant an unlocked
// phone in the wrong hands could spend the whole token balance — the thief runs the merchant app and
// scans their own request. Typing the amount again does not defend against that; a thief retypes it.
// A cap does, and it costs no prompt and no platform API.

/** 20, in base units of a 6-decimal mint (D23). Matches the highest merchant receipt cap, so it never
 *  refuses a sale a merchant could have accepted. */
export const PAYER_PER_PAYMENT_CAP = 20_000_000n;

/** Above this the payer types the amount again before signing (31-PARAMETERS). Not an identity check. */
export const PAYER_RETYPE_THRESHOLD = 10_000_000n;

export const withinPayerCap = (amount: bigint, cap: bigint = PAYER_PER_PAYMENT_CAP): boolean => amount > 0n && amount <= cap;

export const needsRetype = (amount: bigint, threshold: bigint = PAYER_RETYPE_THRESHOLD): boolean => amount > threshold;

/**
 * What an unlocked stolen device can spend before the payer reconnects: the cap, once per slot in the
 * pool. Stated so the threat model can quote a number instead of a feeling (T12).
 */
export const theftExposure = (unspentSlots: number, cap: bigint = PAYER_PER_PAYMENT_CAP): bigint => BigInt(Math.max(0, unspentSlots)) * cap;
