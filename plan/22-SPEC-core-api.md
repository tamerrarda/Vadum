# SPEC — `@vadum/core` public API

**NORMATIVE.** This is the contract between the streams. Stream A implements it; Streams B and C
code against it from day one using stubs, fixture-backed fakes and the golden fixtures. Frozen at spec
freeze.

`Address` is kit's branded address type. `Nonce` (from `@solana/transaction-messages`) and
`Blockhash` (from `@solana/rpc-types`) are kit's branded types for a nonce value and a blockhash;
`@vadum/core` re-exports all three as types. **A nonce value is never typed `Address`** (D34): both
are base58 strings, so mixing them compiles silently everywhere except behind the brand. All byte
arrays are `Uint8Array`. Everything is ESM and `strict`.

Every kit-facing signature below was checked against the published `.d.ts` files of
`@solana/kit@8.0.0` and the `@solana/*` packages it re-exports (D34).

---

## Types

```ts
export type TokenProgram = 'spl-token' | 'token-2022';

export type Lifetime =
  | { readonly kind: 'nonce' }
  | {
      readonly kind: 'fresh';
      readonly blockhash: Blockhash;
      /**
       * Required by kit's `setTransactionMessageLifetimeUsingBlockhash`, and NOT serialised into
       * any wire payload — it does not affect `messageBytes`. The merchant sets it from the RPC
       * response when producing a fresh-path intent; the payer, which never sees it, passes 0n.
       * Stream A must not invent a different convention.
       */
      readonly lastValidBlockHeight: bigint;
    };

export interface NonceRef {
  readonly index: number;   // 0..255, pool slot
  readonly value: Nonce;    // the value currently stored in the nonce account
}

export interface Intent {
  readonly merchant: Address;
  readonly mint: Address;
  readonly decimals: number;
  readonly amount: bigint | null;   // null in static mode — the payer supplies it
  readonly lifetime: Lifetime;
  readonly includeCreateAta: boolean;
  readonly tokenProgram: TokenProgram;
  /**
   * The transaction fee payer AND the funder of createAssociatedTokenAccountIdempotent (D19).
   * Equals `merchant` unless FEE_PAYER_SEPARATE — which is unsupported in v1, so today they
   * always coincide. MUST NOT equal the payer: receive rule 9, enforced by `signAsPayer` and
   * `verifyAuth` (D30).
   */
  readonly feePayer: Address;
  readonly isStatic: boolean;
}

export interface Auth {
  readonly payer: Address;
  readonly nonceRef: NonceRef | null;  // null on the fresh path
  readonly amount: bigint | null;      // set only in static mode
  readonly signature: Uint8Array;      // 64 bytes
}

/**
 * Everything needed to compile the canonical message. Both sides construct this identically.
 *
 * NOTE: `intent.isStatic` is carried here but MUST NOT influence `buildMessage`'s output. Static
 * mode changes only where the amount comes from, and by the time a CanonicalInput exists the
 * amount is already resolved. Any dependence of the compiled bytes on `isStatic` is a bug —
 * A8's determinism property test must cover it by compiling the same input with `isStatic`
 * flipped and asserting byte equality.
 */
export interface CanonicalInput {
  readonly intent: Intent;
  readonly payer: Address;
  readonly nonceRef: NonceRef | null;
  /**
   * Resolved amount. In dynamic mode this is `intent.amount`; in static mode it is `auth.amount`.
   * The wire format forbids AMOUNT_IN_AUTH on a dynamic INTENT precisely so this resolution is
   * never ambiguous (21-SPEC, legal combinations).
   */
  readonly amount: bigint;
}

/**
 * Which risk tier the merchant is operating in. Defined here because `core` owns the caps
 * vocabulary; enforced by `client/queue.ts` (Stream B) and surfaced by the merchant app
 * (Stream C). Values and caps live in `31-PARAMETERS.md` (D23).
 */
export type PaymentTier =
  /** Merchant online, waits ~1s for on-chain confirmation before handover. Zero risk. Default. */
  | 'T0'
  /** Merchant online, hands over immediately. Seconds of exposure. Requires the online nonce
   *  pre-check (D21) before handover — enforced by `Queue.accept` (D30). */
  | 'T1'
  /** Merchant offline, queues. Full exposure, possibly for hours. Lowest caps. Cannot perform
   *  the pre-check — this is the tier where fabricated-nonce fraud is unmitigated. */
  | 'T2';

export interface CompiledMessage {
  readonly messageBytes: Uint8Array;
}

export interface VerifiedPayment {
  readonly input: CanonicalInput;
  readonly messageBytes: Uint8Array;
  readonly auth: Auth;
}
```

### Mint compatibility

```ts
export type MintBlocker =
  | 'transfer-hook-active'
  | 'transfer-fee-nonzero'
  | 'default-account-state-frozen'
  /** Every transfer fails at execution, so a payment against such a mint charges the merchant a
   *  fee and burns the payer's slot (SOL-7). Added 2026-09-12, A-1. */
  | 'non-transferable'
  /**
   * `pausableConfig` observed with `paused: true`. Added 2026-09-12: recoverable, unlike the four
   * above — one `MintCache.refresh` clears it — and raised only on an observation. A pause state that
   * cannot be read warns instead, because a pause can be lifted and a jsonParsed shape change must
   * not take every pausable mint offline. Presence of the extension also sets `mutable`, which is what
   * gives the record an expiry under D22.
   */
  | 'paused';

export type MintWarning =
  | 'permanent-delegate'
  | 'pausable'
  | 'confidential-transfer'
  /** A live freeze authority can freeze either ATA at any time; queued payments then fail at
   *  execution, charging the merchant and burning the payer's slot. Both mainnet and devnet USDC
   *  have one. */
  | 'freeze-authority'
  /** Live on USDG and PYUSD, pointed at the same Paxos authority as everything else on those
   *  mints. Does not break construction. */
  | 'mint-close-authority'
  /** evaluateMint did not recognise an extension present on the mint. Never silently pass. */
  | 'unknown-extension';

export interface MintRecord {
  readonly mint: Address;
  readonly tokenProgram: TokenProgram;
  readonly decimals: number;
  readonly compatible: boolean;
  readonly blockers: readonly MintBlocker[];
  readonly warnings: readonly MintWarning[];
  /**
   * True if any transfer-relevant authority on the mint is non-null — transferHookAuthority,
   * transferFeeConfigAuthority, or the defaultAccountState authority. A mutable mint's verdict
   * can change without warning; an immutable one's cannot (D22).
   *
   * USDC: false (zero extensions).  USDG / PYUSD: true (all authorities at Paxos 2apBGMsS…).
   */
  readonly mutable: boolean;
  /**
   * Epoch ms of the check. Staleness policy is D22 and is enforced by `client/mint.ts`
   * (Stream B), NOT by `core` — `core` performs no I/O and reads no clock. `evaluateMint`
   * receives this value as its second argument and copies it verbatim; it never calls
   * `Date.now()` itself.
   */
  readonly checkedAt: number;
}
```

### `RawMintData` — the `core` ↔ `client` seam

Referenced by `evaluateMint` and previously never defined, which left Stream A and Stream B free to
invent incompatible shapes on either side of the same call. It is normatively the **`jsonParsed`
`parsed.info` projection**, because that is what `11-RESEARCH-tokens.md` read the live mints with and
it avoids putting a Token-2022 TLV parser inside `core`.

```ts
/** Exactly what `client/mint.ts` must produce from getAccountInfo(mint, {encoding:'jsonParsed'}). */
export interface RawMintData {
  readonly mint: Address;
  /** Owning program, from the account's `owner` field — not guessed from the extension list. */
  readonly tokenProgram: TokenProgram;
  readonly decimals: number;
  /** `parsed.info.freezeAuthority`, or null. Present because a live freeze authority is a
   *  MintWarning: a frozen ATA makes a queued payment fail AT EXECUTION, which charges the
   *  merchant a fee and consumes the payer's nonce slot (SOL-7). */
  readonly freezeAuthority: Address | null;
  /** `parsed.info.extensions`, verbatim and unfiltered. `evaluateMint` reads the members it
   *  knows and MUST treat an unrecognised extension as a reason to warn, never to silently pass. */
  readonly extensions: readonly RawMintExtension[];
}

export interface RawMintExtension {
  readonly extension: string;          // e.g. 'transferHook', 'transferFeeConfig'
  readonly state: Record<string, unknown>;
}
```

**Stream B MUST fetch with `encoding: 'jsonParsed'`.** A `base64` fetch produces a different shape
and `evaluateMint` will reject it.

---

## `canonical.ts` — the heart

```ts
/**
 * Compile the canonical transaction message. Deterministic and byte-identical for identical
 * input, which is what allows both sides to build it independently. Pure — no network.
 *
 * Instruction order is fixed:
 *   [AdvanceNonceAccount]?   — prepended by kit when lifetime.kind === 'nonce'
 *   [CreateAssociatedTokenAccountIdempotent]?  — when intent.includeCreateAta
 *   TransferChecked
 */
export function buildMessage(input: CanonicalInput): Promise<CompiledMessage>;
```

**This function is the project.** Streams B and C never reimplement it, never approximate it, and
never construct a Solana instruction of their own. The lifetime is applied through `NonceProvider`
(`nonce-provider.ts`), so `canonical.ts` never names `AdvanceNonceAccount`.

### Three MUSTs inside `buildMessage`

```ts
createTransactionMessage({ version: 0 })     // NOT 'legacy' — D18
authority: createNoopSigner(payer)           // NOT the bare address — D14
payer:     createNoopSigner(intent.feePayer) // funder of createATAIdempotent — D19
```

**`version: 0`, never `'legacy'`.** Measured on identical inputs: `'legacy'` compiles to **352 bytes**
starting `[2,1,4,9]`; `version: 0` compiles to **354 bytes** starting `[128,2,1,4]`. `'legacy'` is a
perfectly defensible choice — the design excludes Address Lookup Tables by construction — which is
exactly why it must be stated. A session that picks it produces bytes matching no fixture and no
other stream, and nothing in the code would tell them.

Passing `authority` as a bare `Address` compiles fine and, **on the fresh-blockhash path, silently
fails to mark the payer as a required signer** — `numRequiredSignatures` is 1, the account list is
byte-identical, the signature still verifies offline, and the chain rejects it at settlement. See
`10-RESEARCH-solana.md` SOL-14. This is the single easiest way to lose a day.

`createNoopSigner` is also how the payer, offline and without the merchant's key, builds a message
that requires the merchant's signature.

**On the fee payer.** `setTransactionMessageFeePayer` takes `intent.feePayer`, and so does the
`createAssociatedTokenAccountIdempotent` funder. Both reference experiment scripts hard-code
`merchant` and both are wrong under `FEE_PAYER_SEPARATE`; with the flag set the two readings compile
to the same 428-byte length but **different bytes** — `requiredSigs=3` with `[feePayer, merchant, payer]`
versus `requiredSigs=2` with `[feePayer, payer]`. `verifyAuth` would then throw `SIG_INVALID` with
nothing pointing at the cause. The flag is unsupported in v1 (D19) so the two coincide today; write
`intent.feePayer` anyway so the builder does not change when the relayer path lands.

---

## `derive.ts`

```ts
export function nonceSeed(index: number): string;                    // `vadum-${index}`
export function deriveNonceAddress(payer: Address, index: number): Promise<Address>;
export function deriveAta(owner: Address, mint: Address, tp: TokenProgram): Promise<Address>;
export function tokenProgramAddress(tp: TokenProgram): Address;
```

---

## `validate.ts`

```ts
/**
 * Pure: turn raw on-chain mint data into a verdict. No network, no clock — `checkedAt` is the
 * caller's fetch time (`RawMintFetch.fetchedAt`) and is copied into the record verbatim (D34).
 */
export function evaluateMint(raw: RawMintData, checkedAt: number): MintRecord;

/** Throws MINT_INCOMPATIBLE with the blocker list if not compatible. */
export function assertMintCompatible(record: MintRecord): void;

/**
 * Strict instruction whitelist. Decodes messageBytes and asserts it contains exactly the
 * expected instructions, accounts, mint, amount and destination — nothing more.
 * Defence in depth: with canonical rebuild nobody signs a foreign message, but the payer
 * app calls this on its own output before showing the confirmation screen.
 */
export function assertCanonical(messageBytes: Uint8Array, expected: CanonicalInput): Promise<void>;
```

---

## `sign.ts`

```ts
/**
 * Payer side, fully offline. Builds, self-checks with assertCanonical, signs.
 *
 * Throws WIRE_FEE_PAYER_IS_PAYER if `input.intent.feePayer === input.payer` (receive rule 9,
 * D30): the payer refuses an intent that would make it pay the fee and the ATA rent.
 *
 * Touches no slot state. The payer app reserves the slot with `client` Pool.reserveSlot, which
 * persists before resolving, and calls this only afterwards (D32).
 */
export function signAsPayer(input: CanonicalInput, key: CryptoKeyPair): Promise<Auth>;

/**
 * Merchant side, fully offline. Rebuilds the message from (intent, auth), verifies the
 * payer's signature against the REBUILT bytes, and returns it. Throws on any mismatch.
 * Never verifies against anything received over the wire.
 *
 * Enforces receive rules 7 and 9 (D30): throws WIRE_FEE_PAYER_IS_PAYER if `intent.feePayer`
 * equals `auth.payer`.
 *
 * `expectedAmount` is REQUIRED in static mode. Omitted, or disagreeing with `auth.amount`, it
 * throws CANON_AMOUNT_MISMATCH (`detail.expected` is null when omitted — D30). Without it, static
 * mode verifies any amount the payer chose: a payer signs 0.01 for a 5.00 item and the merchant app
 * shows a green "verified" state. The signature is valid; the amount is the merchant's to check,
 * and nothing else in the system checks it. In dynamic mode the amount comes from the intent, so
 * passing it is redundant but harmless.
 */
export function verifyAuth(
  intent: Intent,
  auth: Auth,
  expectedAmount?: bigint,
): Promise<VerifiedPayment>;

/** Merchant side, at submission. Attaches the fee-payer signature. Returns wire bytes. */
export function buildWireTransaction(
  payment: VerifiedPayment,
  feePayerKey: CryptoKeyPair,
): Promise<Uint8Array>;
```

`verifyAuth` is the whole merchant-side security model in one function, and it works with the radio
off — **for everything it can see**. It cannot see whether the nonce account exists, is initialised,
has the payer as authority, or holds the claimed value. An attacker with no on-chain presence
produces an `Auth` that passes it completely (`30-THREAT-MODEL.md` T6). That gap is closed by an RPC
pre-check in tier T1 (and by confirmation in T0), specified in `26-SPEC-client-api.md`, and is
unmitigated in T2 by design. Do not let the shape of this function imply otherwise.

---

## `nonce-return.ts` — the signed recovery payload (D20, D28)

```ts
/** ASCII `vadum:nonce-return:v1`, 21 bytes. Exported so tests and the fixture generator share
 *  one definition. */
export const NONCE_RETURN_DOMAIN: Uint8Array;

/** What the merchant's signature covers. Reconstructed on both sides; only `nonceIndex` and
 *  `newNonceValue` cross the air gap (21-SPEC, NONCE_RETURN). */
export interface NonceReturnStatement {
  readonly payer: Address;
  readonly nonceIndex: number;
  readonly spentAgainstValue: Nonce;
  readonly newNonceValue: Nonce;
}

/** The 118 signed bytes: NONCE_RETURN_DOMAIN ‖ payer ‖ nonceIndex ‖ spentAgainstValue ‖ newNonceValue. */
export function nonceReturnSigningBytes(statement: NonceReturnStatement): Uint8Array;

/**
 * Merchant side, after settlement. `payer`, `nonceIndex` and `spentAgainstValue` come from the
 * settled VerifiedPayment (`input.payer`, `auth.nonceRef`); `newNonceValue` from SubmitOutcome.
 * Returns the 64-byte signature.
 */
export function signNonceReturn(
  statement: NonceReturnStatement,
  feePayerKey: CryptoKeyPair,
): Promise<Uint8Array>;

/**
 * Payer side, offline. Only `received` comes from the payload. `ledger` comes from the payer's OWN
 * state — its address, and its record for that slot — never from the payload.
 * Throws NONCE_RETURN_UNTRUSTED on any failure. Performs no lookup and changes no state.
 */
export function verifyNonceReturn(
  received: {
    readonly nonceIndex: number;
    readonly newNonceValue: Nonce;
    readonly signature: Uint8Array;
  },
  ledger: {
    readonly payer: Address;
    readonly merchant: Address;
    readonly spentAgainstValue: Nonce;
  },
): Promise<NonceReturnStatement>;
```

`verifyNonceReturn` rejects when `newNonceValue === spentAgainstValue`: a settled nonce always
advances (SOL-8), so an unchanged value means either a replayed return or a merchant that has not
actually submitted. Because it verifies over a statement built from `ledger`, a genuine return issued
to another payer, or for an earlier value of the same slot, fails even though its signature is real
(D28). `client` `Pool.applyNonceReturn` does the ledger lookup and the re-arm (D32).

---

## `nonce-provider.ts` — the deprecation hedge (D17)

`VadumInfo.md` §9 deliverable #1 promised a nonce-provider abstraction and `20-ARCHITECTURE.md`
dropped it without a decision record. **SIMD-0571 states that durable nonces are "expected to be
deprecated and eventually removed"**, which is precisely what this interface exists for. It is back
in scope for Stream A.

```ts
import type {
  TransactionMessage,
  TransactionMessageWithFeePayer,
  TransactionMessageWithLifetime,
} from '@solana/kit';

/**
 * The lifetime mechanism, behind an interface. v1 ships exactly two implementations and no
 * plugin system — the point is that the call sites do not name `AdvanceNonceAccount`, so a
 * successor mechanism is a new implementation rather than a rewrite of the builder.
 */
export interface NonceProvider {
  readonly kind: 'durable-nonce' | 'fresh-blockhash';
  /**
   * Applies the lifetime to a message that already has its fee payer. For durable nonce this is
   * where kit prepends AdvanceNonceAccount; nothing outside this module constructs that instruction.
   *
   * Async because the durable-nonce account address is derived with `createAddressWithSeed`, which
   * returns `Promise<Address>`. Not generic over the input type, because kit's lifetime setters
   * return a transformed type rather than the input type (D34). The return type is what
   * `compileTransaction` accepts.
   */
  applyLifetime(
    msg: TransactionMessage & TransactionMessageWithFeePayer,
    input: CanonicalInput,
  ): Promise<TransactionMessage & TransactionMessageWithFeePayer & TransactionMessageWithLifetime>;
  /** Whether this mechanism gives protocol-level at-most-once. True for durable nonce,
   *  FALSE for fresh blockhash — 30-THREAT-MODEL's replay claim is qualified on this. */
  readonly guaranteesAtMostOnce: boolean;
}

export const durableNonceProvider: NonceProvider;
export const freshBlockhashProvider: NonceProvider;
```

Scope discipline: no registry, no dynamic loading, no configuration surface. One interface and two
implementations, so that the successor format described in SIMD discussion #415 lands as a third file
rather than as a change to `canonical.ts`.

---

## Invariants Stream A must uphold

1. `buildMessage` is **pure and deterministic**. Same input, same bytes, forever. Enforced by golden
   fixtures in CI.
2. `core` performs **no I/O**. No `fetch`, no RPC, no storage, and **no clock anywhere** — not just
   inside `buildMessage`. `MintRecord.checkedAt` is supplied by the caller; `evaluateMint` never
   reads the time, and TTL policy (D22) belongs to `client/mint.ts`.
3. Every throw is a `VadumError` with a code from `23-SPEC-errors.md`. No bare `Error`, no string
   throws. `VadumErrorCode` is a concrete exported union — `40-STREAM-A-core.md` A1 requires an
   exhaustiveness type-test against it, which is impossible while it exists only as prose tables.
4. `verifyAuth` **never** trusts received bytes. It rebuilds.
5. Public API is append-only after spec freeze. Additions are fine; changes are not.

---

## Stub-first protocol

On day one Stream A commits every function above with the correct signature and a
`throw new VadumError('INTERNAL_NOT_IMPLEMENTED')` body (D34), then fills them in. CI fails gate G1 if
that string survives anywhere in `packages/core/src`. Streams B and C get a compiling workspace
immediately; they use `24-SPEC-fixtures.md` for real bytes, and Stream C's fixture-backed fakes
(`42-STREAM-C-apps.md` C0.5) keep both apps usable until `core` lands.
