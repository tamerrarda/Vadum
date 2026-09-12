// C7 · Failure copy. Every user-facing code in 23-SPEC-errors.md has copy, and none of it says "an
// error occurred". `INTERNAL_*` codes are not user-facing.
//
// The five that decide whether the copy is honest are spelled out in 42-STREAM-C-apps.md C7:
// SUBMIT_NONCE_STALE is a genuine race and says so; SUBMIT_NONCE_ABSENT must NOT reassure anybody;
// SUBMIT_EXECUTION_FAILED says the merchant paid a fee; LIMIT_PRECHECK_REQUIRED explains T1's
// connection requirement; and WIRE_UNEXPECTED_TYPE says it is the wrong kind of QR for this screen.

import { VADUM_ERROR_CODES, type VadumErrorCode } from '@vadum/core';

export type UserFacingCode = Exclude<VadumErrorCode, `INTERNAL_${string}`>;

export interface FailureCopy {
  /** Shown as the heading. Plain language, no codes, never "an error occurred". */
  readonly title: string;
  /** One or two sentences: what happened, what it costs, and what to do next. */
  readonly body: string;
  /** Which app shows it. `both` means the copy reads correctly on either side. */
  readonly side: 'payer' | 'merchant' | 'both';
  /** What the user can do about it, when anything. */
  readonly action?: 'retry' | 'reconnect' | 'rescan' | 'install' | 'top-up' | 'none';
}

export const FAILURE_COPY: Readonly<Record<UserFacingCode, FailureCopy>> = {
  // ─── the air gap ────────────────────────────────────────────────────────────────────────────────
  WIRE_VERSION_UNSUPPORTED: {
    title: 'This code is from a newer version',
    body: 'The other device is running a newer version of Vadum than this one. Update both apps and try again.',
    side: 'both',
    action: 'none',
  },
  WIRE_RESERVED_FLAG_SET: { title: 'This code is not valid', body: 'The scanned code sets options this version does not know. Ask for a fresh code.', side: 'both', action: 'rescan' },
  WIRE_LENGTH_MISMATCH: { title: 'The code was read incompletely', body: 'Part of the code was lost. Hold the phone steady and scan it again.', side: 'both', action: 'rescan' },
  WIRE_UNKNOWN_TYPE: { title: 'This is not a Vadum code', body: 'The scanned code is not a Vadum payment code.', side: 'both', action: 'rescan' },
  WIRE_UNEXPECTED_TYPE: {
    title: 'Wrong kind of code for this screen',
    body: 'This is a Vadum code, but not the one this screen is waiting for. Check which device should be showing a code.',
    side: 'both',
    action: 'rescan',
  },
  WIRE_FLAGS_MISMATCH: {
    title: 'This code answers a different request',
    body: 'The payment code does not match the request on screen. Show the request again and have it rescanned.',
    side: 'merchant',
    action: 'rescan',
  },
  WIRE_STATIC_CONSTRAINT: { title: 'This printed code is not valid', body: 'The printed code is malformed. Print it again from the merchant app.', side: 'both', action: 'none' },
  WIRE_BASE45_INVALID: { title: 'The code could not be read', body: 'The scan came back damaged — often glare or a partly covered code. Clean the screen or the sticker and scan again.', side: 'both', action: 'rescan' },
  WIRE_FLAG_NOT_ALLOWED_FOR_TYPE: { title: 'This code is not valid', body: 'The code combines options that cannot go together. Ask for a fresh code.', side: 'both', action: 'rescan' },
  WIRE_FEE_PAYER_SEPARATE_UNSUPPORTED: {
    title: 'This code needs a relayer',
    body: 'It asks for a separate fee payer, which this version does not support.',
    side: 'both',
    action: 'none',
  },
  WIRE_FEE_PAYER_IS_PAYER: {
    title: 'This request would charge you the fee',
    body: 'The request asks you to pay the network fee and the account rent. A Vadum merchant pays both. Do not pay this request.',
    side: 'payer',
    action: 'none',
  },
  WIRE_DUPLICATE_AUTH: {
    title: 'Already received',
    body: 'You have already accepted this exact payment. Showing the same code twice does not pay twice — ask for a new payment.',
    side: 'merchant',
    action: 'none',
  },

  // ─── the mint ───────────────────────────────────────────────────────────────────────────────────
  MINT_UNKNOWN: {
    title: 'Unknown token',
    body: 'This token is not in your list of checked tokens, so it cannot be paid offline. Reconnect once to check it.',
    side: 'payer',
    action: 'reconnect',
  },
  MINT_INCOMPATIBLE: {
    title: 'This token cannot be paid offline',
    body: 'Its rules — a transfer hook, a transfer fee, or accounts that arrive frozen — make an offline payment impossible to verify.',
    side: 'both',
    action: 'none',
  },
  MINT_DECIMALS_MISMATCH: { title: 'Token details do not match', body: 'The request describes this token differently than your records do. Reconnect once to refresh them.', side: 'payer', action: 'reconnect' },
  MINT_TOKEN_PROGRAM_MISMATCH: {
    title: 'Token details do not match',
    body: 'The request names the wrong token program for this token, which would send funds to the wrong account. Do not pay it.',
    side: 'payer',
    action: 'none',
  },
  MINT_RECORD_STALE: {
    title: 'Token rules not re-checked recently',
    body: 'This token can change its own rules, and yours were last checked a while ago, so offline payments are capped. Reconnect to lift the cap.',
    side: 'payer',
    action: 'reconnect',
  },

  // ─── the message ────────────────────────────────────────────────────────────────────────────────
  CANON_INSTRUCTION_NOT_ALLOWED: { title: 'This payment does something else', body: 'The payment contains an instruction Vadum does not allow. It was not signed.', side: 'both', action: 'none' },
  CANON_ACCOUNT_MISMATCH: { title: 'The payment does not match the request', body: 'The accounts in the payment are not the ones the request named. It was not accepted.', side: 'both', action: 'rescan' },
  CANON_AMOUNT_MISMATCH: {
    title: 'The amount does not match',
    body: 'The signed amount is not the amount for this sale. Enter the price again and rescan, and do not hand anything over.',
    side: 'merchant',
    action: 'rescan',
  },
  CANON_DESTINATION_MISMATCH: { title: 'The payment would go elsewhere', body: 'The payment does not pay this merchant’s account. It was not accepted.', side: 'merchant', action: 'none' },
  CANON_INSTRUCTION_ORDER: { title: 'This payment is malformed', body: 'The payment’s instructions are out of order. It was not accepted.', side: 'both', action: 'none' },

  // ─── signatures ─────────────────────────────────────────────────────────────────────────────────
  SIG_INVALID: {
    title: 'The signature does not match',
    body: 'This code was not signed for this request. Show the request again and have it rescanned; do not hand anything over.',
    side: 'merchant',
    action: 'rescan',
  },
  SIG_LENGTH: { title: 'The code was read incompletely', body: 'The signature in the scanned code is the wrong size. Scan it again.', side: 'both', action: 'rescan' },
  SIG_FEE_PAYER_MISSING: { title: 'This device cannot send the payment', body: 'The merchant key that pays the fee is not available on this device.', side: 'merchant', action: 'none' },

  // ─── the pool and the ledger ────────────────────────────────────────────────────────────────────
  NONCE_INDEX_OUT_OF_RANGE: { title: 'This code is not valid', body: 'It refers to an offline payment slot that cannot exist.', side: 'both', action: 'rescan' },
  NONCE_ALREADY_SPENT: { title: 'This slot has already been used', body: 'That offline payment slot was already spent. Reconnect once to refresh your slots.', side: 'payer', action: 'reconnect' },
  NONCE_LEDGER_MISSING: {
    title: 'Cannot pay offline — reconnect once to restore',
    body: 'Your record of which offline payments are already used is missing, so paying offline could create payments that will never go through. One online session restores it.',
    side: 'payer',
    action: 'reconnect',
  },
  NONCE_POOL_EXHAUSTED: {
    title: 'Offline payments used up',
    body: 'Every offline payment slot is spent. Reconnect once to refresh them — the deposit is not spent, only the slots.',
    side: 'payer',
    action: 'reconnect',
  },
  NONCE_POOL_UNDERFUNDED: {
    title: 'Not enough SOL for the deposit',
    body: 'Creating offline payment slots needs a refundable deposit plus a small fee, and the wallet must keep a minimum balance. Top it up and try again.',
    side: 'payer',
    action: 'top-up',
  },
  NONCE_DESYNC: {
    title: 'A payment was never submitted',
    body: 'A merchant took a payment and never sent it, so its slot has been released. The 24-hour window this uses is a safeguard, not a guarantee.',
    side: 'payer',
    action: 'none',
  },
  NONCE_RETURN_UNTRUSTED: {
    title: 'This recovery code is not for you',
    body: 'It was not issued by the merchant you paid, or not for the payment it claims. Nothing changed.',
    side: 'payer',
    action: 'none',
  },
  NONCE_ACCOUNT_CLOSED: { title: 'An offline payment slot was closed', body: 'One of your slots no longer exists on chain. Reconnect once to refresh the pool.', side: 'payer', action: 'reconnect' },

  // ─── the caps ───────────────────────────────────────────────────────────────────────────────────
  LIMIT_RECEIPT_CAP: {
    title: 'Above the offline limit',
    body: 'This sale is larger than this mode allows without confirmation. Switch to waiting for confirmation, or split the sale.',
    side: 'merchant',
    action: 'none',
  },
  LIMIT_QUEUE_EXPOSURE: {
    title: 'Too much waiting to settle',
    body: 'Unsent payments have reached the limit for accepting more offline. Reconnect and let the queue drain first.',
    side: 'merchant',
    action: 'reconnect',
  },
  LIMIT_FAILED_SENDS: {
    title: 'Offline accepting paused',
    body: 'Several payments in a row failed to settle. Offline accepting is paused until you reconnect and look at the queue.',
    side: 'merchant',
    action: 'reconnect',
  },
  LIMIT_SEND_WINDOW_EXPIRED: {
    title: 'Too old to send',
    body: 'This payment sat unsent past its 24-hour window and has been voided. Ask the customer to pay again.',
    side: 'merchant',
    action: 'none',
  },
  LIMIT_PRECHECK_REQUIRED: {
    title: 'A connection is needed to accept this way',
    body: 'Accepting before confirmation requires checking the payment’s account online first. Without a connection this is offline accepting, with its lower limit.',
    side: 'merchant',
    action: 'reconnect',
  },

  // ─── submission ─────────────────────────────────────────────────────────────────────────────────
  SUBMIT_NONCE_STALE: {
    title: 'Not charged — another merchant settled this payment first',
    body: 'The customer used the same offline slot elsewhere before you sent it. You were charged nothing. This is a race, not fraud.',
    side: 'merchant',
    action: 'none',
  },
  SUBMIT_NONCE_ABSENT: {
    title: 'This payment was not backed by a valid account',
    body: 'Nothing was charged, but the goods are gone. The code verified offline and the account behind it does not exist. Consider requiring confirmation before handover.',
    side: 'merchant',
    action: 'none',
  },
  SUBMIT_EXECUTION_FAILED: {
    title: 'The customer could not cover this payment',
    body: 'The payment reached the network and failed there — usually too few tokens. You paid the network fee.',
    side: 'merchant',
    action: 'none',
  },
  SUBMIT_ALREADY_PROCESSED: { title: 'Already settled', body: 'This payment had already gone through. Nothing was sent twice.', side: 'merchant', action: 'none' },
  SUBMIT_BLOCKHASH_EXPIRED: { title: 'This payment expired before it was sent', body: 'It was signed against a short-lived blockhash rather than an offline slot. Ask the customer to pay again.', side: 'merchant', action: 'none' },
  SUBMIT_RPC_UNAVAILABLE: { title: 'Could not reach the network', body: 'The payment is still queued and nothing was lost. It will be sent when the connection comes back.', side: 'merchant', action: 'retry' },
};

/** Extra states that are not error codes but need the same honest copy (C3, C7). */
export const STATE_COPY = {
  recovery: {
    title: 'Cannot pay offline — reconnect once to restore',
    body: 'This device has offline payment slots but no record of which are already used. One online session restores the record.',
    side: 'payer',
    action: 'reconnect',
  },
  'not-installed': {
    title: 'Install the app to pay offline',
    body: 'In a browser tab the phone can delete this app’s data at any time, which would make offline payments unsafe. Add Vadum to your home screen and open it from there.',
    side: 'payer',
    action: 'install',
  },
  'no-tokens': {
    title: 'Check a token before you go offline',
    body: 'This device can only pay with a token it has checked online at least once — that check is what makes the payment verifiable with no connection. Add the token your merchant uses while you still have one.',
    side: 'payer',
    action: 'reconnect',
  },
  'above-payer-cap': {
    title: 'Too large to pay offline',
    body: 'This device will not sign a single offline payment above its limit. The limit exists because anyone holding an unlocked phone can pay with it — reconnect and pay online instead.',
    side: 'payer',
    action: 'reconnect',
  },
} as const satisfies Readonly<Record<string, FailureCopy>>;

const USER_FACING = (code: VadumErrorCode): code is UserFacingCode => !code.startsWith('INTERNAL_');

/** Every user-facing code, for the completeness test and for a settings screen that lists them. */
export const USER_FACING_CODES: readonly UserFacingCode[] = VADUM_ERROR_CODES.filter(USER_FACING);

/**
 * Copy for a thrown error. An `INTERNAL_*` code is a bug, not a user state: it gets one generic line,
 * and it is the only place in the app where the user is told nothing useful — deliberately, because
 * anything else would be invented.
 */
export function copyFor(code: VadumErrorCode): FailureCopy {
  if (USER_FACING(code)) return FAILURE_COPY[code];
  return { title: 'Something in the app went wrong', body: 'This is a defect, not a payment problem. Nothing was signed or sent.', side: 'both', action: 'none' };
}
