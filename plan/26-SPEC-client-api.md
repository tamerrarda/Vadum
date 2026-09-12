# SPEC — `@vadum/client` public API

**NORMATIVE.** Frozen at spec freeze.

Like `25-SPEC-wire-api.md`, this file did not exist in the first revision and its absence blocked
Stream C. `client` is where the network lives: RPC, the nonce pool, the mint cache, the merchant
queue, submission.

`client` imports from `core` and `wire`. Nothing imports from `client` except the apps.

---

## `rpc.ts`

```ts
import type { Address, Nonce, RawMintData } from '@vadum/core';

export interface VadumRpc {
  readonly endpoint: string;
  readonly cluster: 'devnet' | 'mainnet-beta' | 'testnet' | 'localnet';
  /** Never hardcode rent (D7) — it is falling on the live clusters (D39). */
  getNonceRentExemption(): Promise<bigint>;
  /** getMinimumBalanceForRentExemption(dataLength). `0` gives a plain wallet's rent-exempt floor (D38). */
  getRentExemption(dataLength: number): Promise<bigint>;
  getMintAccount(mint: Address): Promise<RawMintFetch>;
  getNonceAccount(address: Address): Promise<NonceAccountState>;
  getTokenBalance(ata: Address): Promise<bigint | null>;
  isAtaFrozen(ata: Address): Promise<boolean | null>;
  /** The payer's lamports, which `Pool.create` and `Pool.close` check against D38 before sending. */
  getBalance(address: Address): Promise<bigint>;
  /**
   * Did the cluster process this signature? Added 2026-09-12: it is the only authority on whether a
   * failed payment charged the merchant. A transaction the cluster executed paid its fee even though
   * it failed, and one the cluster never saw paid nothing (SOL-7) — so `SubmitOutcome.feeCharged` is
   * read from here, never from the wording of an RPC error.
   */
  getSignatureOutcome(signature: string): Promise<'landed-ok' | 'landed-failed' | 'absent'>;

  // The send surface. Added 2026-09-12 (B-1): this interface was read-only, but `Pool.create`,
  // `Pool.close` and `submit` have to send a transaction and the spec gave them no other seam. The
  // alternative — passing a kit client around — puts transaction plumbing in the apps.

  /**
   * Signs a blockhash-lifetime setup transaction with `feePayerKey` and confirms it. Any other
   * required signature comes from a signer embedded in an instruction, which is how kit collects
   * them — pool setup deliberately needs exactly one (D26).
   */
  sendSetup(instructions: readonly Instruction[], feePayerKey: CryptoKeyPair): Promise<string>;
  /**
   * Sends an already-signed payment and confirms it with the confirmer that matches its lifetime:
   * the durable-nonce factory on the nonce path, never the blockhash one (SOL-15). Because the
   * caller passes the lifetime, no call site can get that choice wrong.
   */
  sendPayment(wireTransaction: Uint8Array, lifetime: PaymentLifetime, options?: SendOptions): Promise<string>;
}

export interface SendOptions {
  /**
   * Skip the RPC's preflight simulation. **Never in product code:** preflight is what stops a merchant
   * paying a fee for a payment that was going to fail anyway. It exists so the landed-and-charged
   * failure can be produced deliberately — `tools/devnet-b` step 9 uses it to prove that class is
   * classified correctly on a live chain, which preflight otherwise makes unobservable (SOL-7, D21).
   */
  readonly skipPreflight?: boolean;
}

/**
 * What kit's confirmers need and wire bytes cannot carry: a decoded transaction is a message plus
 * signatures, with no lifetime object attached. The caller built the message, so it passes the
 * lifetime in rather than having the RPC layer re-derive it from the instructions.
 */
export type PaymentLifetime =
  | { readonly kind: 'nonce'; readonly nonce: Nonce; readonly nonceAccountAddress: Address; readonly nonceAuthorityAddress: Address }
  | { readonly kind: 'fresh'; readonly blockhash: Blockhash; readonly lastValidBlockHeight: bigint };

export function createRpc(endpoint: string): VadumRpc;
```

**v1 is devnet only (D16).** `createRpc` accepts any endpoint, but the apps ship with a devnet
default and the README says so plainly: no compute-budget instruction is expressible in this design,
so v1 cannot bid for blockspace and is not intended for congested mainnet.

```ts
export interface RawMintFetch {
  /** MUST be fetched with encoding: 'jsonParsed'. A base64 fetch produces a different shape
   *  and core.evaluateMint will reject it (22-SPEC, RawMintData). */
  readonly raw: RawMintData;
  readonly fetchedAt: number;
}

export type NonceAccountState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'uninitialized' }
  | {
      readonly kind: 'initialized';
      readonly authority: Address;
      readonly value: Nonce;          // the stored nonce, at offset 40 (SOL-3)
      readonly lamports: bigint;
    };
```

`NonceAccountState` distinguishes `absent` from `uninitialized` because
`23-SPEC-errors.md` needs both to raise `SUBMIT_NONCE_ABSENT`, and collapsing them would hide the
difference between "never created" and "closed by the payer" (T7).

**The one `Address` → `Nonce` conversion in the codebase lives in `getNonceAccount`** (D34).
`fetchNonce` from `@solana-program/system` types the stored value as `Address`; it is converted here
once, and no other module in any package casts between the two.

---

## `nonce-check.ts` — the fabricated-nonce mitigation (D21)

This module is the entire technical answer to the attack in D21, and it is the one place in the
system where being online buys real security.

```ts
export type NonceVerdict =
  | { readonly ok: true; readonly onChainValue: Nonce }
  /** The account is valid but has moved on — a genuine race. Costs the merchant nothing. */
  | { readonly ok: false; readonly reason: 'stale'; readonly onChainValue: Nonce }
  /** Missing, uninitialized, or the authority is not the payer. Near-certain fraud. */
  | { readonly ok: false; readonly reason: 'absent' | 'uninitialized' | 'wrong-authority' };

/**
 * One getAccountInfo on the derived nonce address. Verifies, in order:
 *   1. the account exists
 *   2. state is Initialized
 *   3. authority === payer
 *   4. stored value === the nonceValue claimed in the AUTH
 *
 * MANDATORY before handover in tier T1, and enforced there by Queue.accept (D30). T0's
 * confirmation implies it. Impossible in T2 — that is the tier where the fraud is unmitigated,
 * and the merchant app must say so rather than implying otherwise.
 *
 * Nonce path only: a fresh-blockhash payment has no nonce account, and passing one throws
 * INTERNAL_NOT_APPLICABLE.
 */
export function precheckNonce(
  rpc: VadumRpc,
  payment: VerifiedPayment,
): Promise<NonceVerdict>;
```

`verifyAuth` proves the payer signed this exact message. `precheckNonce` proves there is an account
behind it. **Neither implies the other**, and the merchant UI must not present offline verification
as if it did.

---

## `mint.ts`

```ts
export interface MintCache {
  get(mint: Address): MintRecord | undefined;
  /** Online. Fetches with encoding 'jsonParsed', calls core.evaluateMint(raw, fetchedAt) (D34),
   *  stores the record. */
  refresh(mint: Address): Promise<MintRecord>;
  /** D22: staleness follows mint mutability, not the clock.
   *   - immutable mint (USDC): never stale
   *   - mutable mint (USDG, PYUSD): stale after the TTL, which WARNS and caps, never hard-blocks */
  staleness(mint: Address, now: number): 'fresh' | 'stale-mutable' | 'unknown';
  entries(): readonly MintRecord[];
}

export function createMintCache(rpc: VadumRpc, store: KeyValueStore): MintCache;
```

A flat 24-hour TTL would have meant a payer can only pay offline within 24 hours of last being
online — which deletes the disaster-zone and rural-vendor scenarios the project exists for. D22
records why the policy is mutability-based instead.

---

## `pool.ts` — nonce pool lifecycle and slot state

**No sponsor in v1 (D26).** The payer funds their own rent, which is refundable, and because
`from == base == payer` the setup needs **one signature**, not a two-party ceremony. This is what
closed SOL-5b.

**`pool.ts` is the single owner of slot state** (D32). Nothing else in any package records whether a
slot is spent; Stream C makes that record durable through `KeyValueStore`.

```ts
import type { NonceReturnPayload } from '@vadum/wire';

export interface PoolSlot {
  readonly index: number;
  readonly address: Address;
  /** null when not yet read. NOT unique across slots: slots initialised in one transaction share it
   *  (Phase 0, 2026-09-11), so slot state is keyed on `index`, never on the value. */
  readonly value: Nonce | null;
  readonly state: 'unspent' | 'spent' | 'unknown';
  /** Set when state === 'spent'. Needed by applyNonceReturn (21-SPEC rule 12, D28) and by
   *  the NONCE_DESYNC reconciliation (23-SPEC). */
  readonly spentAgainst?: { readonly value: Nonce; readonly merchant: Address; readonly at: number };
  /**
   * Set when `reconcile` released the slot with its value unchanged. Added 2026-09-12 (NONCE-9): the
   * old payment is still submittable by that merchant, so `reserveSlot` hands a released slot out
   * **last**, least recently released first. Cleared as soon as the value moves.
   */
  readonly releasedAt?: number;
}

export interface PoolStatus {
  readonly payer: Address;
  readonly size: number;               // N, default 5 (D23)
  readonly slots: readonly PoolSlot[];
  readonly unspentCount: number;
  readonly belowLowWaterMark: boolean; // <= 2 remaining (D23)
  readonly epoch: string;              // the pool epoch marker, mirrored by Stream C's store
}

export interface Pool {
  /**
   * What the payer's wallet needs before `create` (D38), each part read at call time (D7):
   *   nonceRent      size × getNonceRentExemption() — refundable when the pool closes
   *   fee            the setup transaction's fee
   *   walletMinimum  getRentExemption(0) — a system account must end every transaction at zero
   *                  or rent-exempt
   * The wallet must hold exactly nonceRent + fee, ending at zero, or at least all three together.
   */
  estimateSetupCost(size: number): Promise<{
    readonly nonceRent: bigint;
    readonly fee: bigint;
    readonly walletMinimum: bigint;
  }>;
  /** Online. createAccountWithSeed + initializeNonceAccount for each slot. One signer; the payer
   *  pays the fee and the rent (D26). Checks the wallet first and throws NONCE_POOL_UNDERFUNDED,
   *  sending nothing, if it cannot end the transaction at zero or rent-exempt (D38). */
  create(size: number, payerKey: CryptoKeyPair): Promise<PoolStatus>;
  /**
   * Offline. Picks the lowest-index slot that is 'unspent' with a known value, marks it spent
   * against `merchant`, and PERSISTS through the store before resolving. The payer app calls
   * core.signAsPayer only after this resolves — the fail-safe ordering (D32). If signing then
   * fails, the slot stays spent and reconciliation releases it after the send window.
   * Throws NONCE_POOL_EXHAUSTED when no slot qualifies, NONCE_LEDGER_MISSING when the store holds
   * no pool state.
   */
  reserveSlot(merchant: Address, now: number): Promise<{ readonly index: number; readonly value: Nonce }>;
  // Order: any slot never released, then the least recently released one (NONCE-9).
  /**
   * Offline. Receive rule 12: looks up the slot's spentAgainst record (rejecting if there is none),
   * calls core.verifyNonceReturn with this pool's payer and that record (D28), and only on success
   * re-arms the slot with newNonceValue. Throws NONCE_RETURN_UNTRUSTED and changes nothing on
   * failure.
   */
  applyNonceReturn(payload: NonceReturnPayload): Promise<PoolStatus>;
  /** Online. Re-reads every slot's on-chain value. Never changes slot state. */
  refresh(): Promise<PoolStatus>;
  /** Online. withdrawNonceAccount on every slot; rent returns to the payer. */
  close(payerKey: CryptoKeyPair): Promise<{ refundedLamports: bigint }>;
  /**
   * Online. The NONCE_DESYNC procedure in 23-SPEC, over every slot recorded as spent:
   *   settled      — on-chain value moved: slot re-armed, unspent, holding the new value (D32)
   *   released     — value unchanged and the send window has elapsed: unspent, value unchanged
   *   stillPending — value unchanged inside the window: stays spent
   */
  reconcile(now: number): Promise<{
    readonly released: readonly number[];
    readonly settled: readonly number[];
    readonly stillPending: readonly number[];
  }>;
  status(): PoolStatus;
}

export function createPool(rpc: VadumRpc, payer: Address, store: KeyValueStore): Pool;
```

`reconcile` is the missing piece `WIRE-8` was opened for: because the payer marks a slot spent before
signing, a merchant who never submits would otherwise drain the payer's offline capacity permanently.
And because it re-arms settled slots, an honest payer's capacity comes back on every online session
without needing a `NONCE_RETURN` at all.

---

## `queue.ts` — the merchant queue

The hardest thing Stream B owns.

```ts
export interface QueuedPayment {
  /** The dedupe key (D31):
   *    nonce path:  `nonce:${payer}:${nonceIndex}:${nonceValue}`
   *    fresh path:  `fresh:${payer}:${base58(sha256(messageBytes))}` */
  readonly id: string;
  readonly payment: VerifiedPayment;
  readonly tier: PaymentTier;
  readonly acceptedAt: number;
  readonly amount: bigint;             // base units (D23) — never dollars
  readonly attempts: number;
  readonly lastError?: VadumErrorCode;
  readonly state: 'queued' | 'submitting' | 'settled' | 'failed' | 'voided';
}

export interface QueueLimits {
  readonly receiptCapByTier: Readonly<Record<PaymentTier, bigint>>;  // base units
  readonly queueExposureCap: bigint;                                  // base units
  readonly maxConsecutiveFailedSends: number;                         // 3 (D23)
  readonly sendWindowMs: number;                                      // 24h (D23)
}

export interface Queue {
  /**
   * Receive rule 13 (D31): throws WIRE_DUPLICATE_AUTH when `id` matches ANY payment this queue has
   * ever accepted, in any state. Keys are never pruned in v1.
   *
   * D30: a T1 acceptance on the nonce path requires `precheck` with `ok: true`, else
   * LIMIT_PRECHECK_REQUIRED. T2 cannot perform the pre-check. T0 hands over only after `drain`
   * reports `settled`.
   *
   * Also enforces LIMIT_RECEIPT_CAP, LIMIT_QUEUE_EXPOSURE and LIMIT_FAILED_SENDS before accepting.
   */
  accept(
    payment: VerifiedPayment,
    tier: PaymentTier,
    amount: bigint,
    precheck?: NonceVerdict,
  ): Promise<QueuedPayment>;
  list(): readonly QueuedPayment[];
  exposure(): bigint;
  /** Online. Submits everything eligible, oldest first. */
  drain(feePayerKey: CryptoKeyPair): Promise<readonly SubmitOutcome[]>;
  /** LIMIT_SEND_WINDOW_EXPIRED — marks the payment voided, does not submit. */
  expire(now: number): readonly QueuedPayment[];
}

export function createQueue(
  rpc: VadumRpc, store: KeyValueStore, limits: QueueLimits,
): Queue;
```

---

## `submit.ts`

```ts
export type SubmitOutcome =
  | {
      readonly kind: 'settled';
      readonly signature: string;
      /**
       * The value the merchant signs into a NONCE_RETURN (D28). **Nullable since 2026-09-12 (B-2):**
       * a fresh-blockhash payment has no nonce account at all, and a slot that cannot be read back
       * right after settlement leaves it null rather than guessing — a return carrying the value the
       * slot was spent against is refused by the payer anyway.
       */
      readonly newNonceValue: Nonce | null;
    }
  | {
      readonly kind: 'failed';
      readonly code: VadumErrorCode;
      readonly feeCharged: boolean;
      /** What the RPC or the chain actually said, for the merchant's log and for support (PROD-7). */
      readonly detail?: string;
    };

/**
 * Attaches the fee-payer signature and submits.
 *
 * MUST use kit's `sendAndConfirmDurableNonceTransactionFactory` on the nonce path.
 * `sendAndConfirmTransactionFactory` is the BLOCKHASH-lifetime confirmer: it requires
 * `lastValidBlockHeight`, which a durable-nonce transaction does not have, and it fails
 * immediately with BLOCK_HEIGHT_EXCEEDED. This is not theoretical — it is what
 * `experiments/phase0-derisk.mjs` did, and it is why Phase 0 could never have passed.
 *
 * On failure, classifies via `precheckNonce` into SUBMIT_NONCE_STALE vs SUBMIT_NONCE_ABSENT
 * rather than collapsing both into one code (D21).
 *
 * `newNonceValue` on success is what the merchant signs into the NONCE_RETURN statement, together
 * with the payment's `input.payer` and `auth.nonceRef` (D28).
 */
export function submit(
  rpc: VadumRpc,
  payment: VerifiedPayment,
  feePayerKey: CryptoKeyPair,
): Promise<SubmitOutcome>;
```

---

## `store.ts` — persistence seam

```ts
/** Deliberately minimal. `client` must run in a browser (IndexedDB) and in Node (a test
 *  double), and neither pool nor queue may assume which. Stream C supplies the browser one. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<readonly string[]>;
}
```

**Slot state belongs to `client/pool.ts`; durability belongs to Stream C** (D32). `pool` and `queue`
persist through this interface and take no view on eviction. Stream C supplies the browser
implementation — IndexedDB, the `localStorage` mirror, the pool epoch marker — and detects loss: if
the payer's pool is known to exist but the store holds no pool state, the payer app enters RECOVERY
(`42-STREAM-C-apps.md` C3), and `Pool.reserveSlot` throws `NONCE_LEDGER_MISSING` in any case. Stream B
ships an in-memory implementation for tests.
