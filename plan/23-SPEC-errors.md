# SPEC — Error taxonomy

**NORMATIVE.** Every failure in `@vadum/core`, `@vadum/wire` and `@vadum/client` is a `VadumError`
carrying one of these codes. Codes are stable identifiers: apps switch on them, the measurement
harness counts them, and the UI maps them to copy. Adding a code is fine; renaming one is a breaking
change.

A prefix names the rule family, not always the raising package. Where they differ, the row says which
layer raises it (D30).

```ts
export class VadumError extends Error {
  readonly code: VadumErrorCode;
  readonly detail?: Record<string, unknown>;
}

/**
 * Concrete union, exported from `@vadum/core`. It is not optional documentation: `40-STREAM-A-core.md`
 * A1's exhaustiveness type-test and `42-STREAM-C-apps.md` C7's "every user-facing code has copy"
 * requirement both need a real type to switch on.
 */
export type VadumErrorCode =
  | `WIRE_${string}` | `MINT_${string}` | `CANON_${string}`
  | `SIG_${string}`  | `NONCE_${string}` | `LIMIT_${string}` | `SUBMIT_${string}`
  | `INTERNAL_${string}`;
// ^ illustrative only — Stream A writes it out as an explicit literal union of every code below.
```

---

## Wire / codec — `WIRE_*`

| Code | Raised when |
|---|---|
| `WIRE_VERSION_UNSUPPORTED` | `version != 0x01` |
| `WIRE_RESERVED_FLAG_SET` | Any of flag bits 5–7 set |
| `WIRE_LENGTH_MISMATCH` | Fewer than 3 bytes, or a payload length that disagrees with the length implied by `type` + `flags` |
| `WIRE_UNKNOWN_TYPE` | `type` not in 0x01–0x04 |
| `WIRE_UNEXPECTED_TYPE` | A known `type` handed to a decoder for a different type — for example a `NONCE_RETURN` scanned on the payment-request screen. `detail.expected` and `detail.actual` name both (D30) |
| `WIRE_FLAGS_MISMATCH` | `AUTH` flags do not byte-equal the intent's flags |
| `WIRE_STATIC_CONSTRAINT` | `STATIC_INTENT` with `LIFETIME_FRESH` set or `AMOUNT_IN_AUTH` clear |
| `WIRE_BASE45_INVALID` | Payload contains a character outside the RFC 9285 alphabet, has a length where `len % 3 == 1`, has a 3-character group above `0xFFFF`, or has a 2-character tail above `0xFF` (D37). **Never silently decode** — `base45@2.0.1` maps unknown characters to −1 and produces wrong bytes, which is why D12 vendors it |
| `WIRE_FLAG_NOT_ALLOWED_FOR_TYPE` | A flag that has no meaning for this `type` is set: `AMOUNT_IN_AUTH` on `INTENT`, any flag on `NONCE_RETURN` (bits 3 and 5–7 are caught earlier by the check order). `detail.type` and `detail.flag` name them |
| `WIRE_FEE_PAYER_SEPARATE_UNSUPPORTED` | Flag bit 3 set, on any type. Reserved in the format, not implemented in v1 (D19) |
| `WIRE_FEE_PAYER_IS_PAYER` | `feePayer == payer`. A merchant must not be able to push the fee and the ATA rent onto the payer. **Raised by `core`** — `verifyAuth` and `signAsPayer` — because the codec never holds both addresses (D30) |
| `WIRE_DUPLICATE_AUTH` | An `AUTH` whose dedupe key (D31) matches **any** payment the merchant has accepted, in any state: `(payer, nonceIndex, nonceValue)` on the nonce path, `(payer, sha256(messageBytes))` on the fresh path. Identical purchases produce byte-identical payloads, so without this a payer shows the same QR twice — or re-shows a settled one — and is served twice. **Raised by `client/queue.ts`** (D30) |

When one payload breaks several rules, the check order in `21-SPEC-wire-format.md` decides which of
these is raised.

## Mint compatibility — `MINT_*`

| Code | Raised when |
|---|---|
| `MINT_UNKNOWN` | Mint is not in the local compatibility cache — the payer refuses to sign |
| `MINT_INCOMPATIBLE` | One or more `MintBlocker`s present. `detail.blockers` lists them |
| `MINT_DECIMALS_MISMATCH` | Wire `decimals` disagrees with the cached record |
| `MINT_TOKEN_PROGRAM_MISMATCH` | The intent's `TOKEN_2022` flag disagrees with the cached record's `tokenProgram`. Without it, a known mint with a false flag makes the payer derive the wrong ATAs and the payment dies at execution, charging the merchant and burning the slot (D30) |
| `MINT_RECORD_STALE` | Cached record for a **mutable** mint is older than the TTL (D22). A **warning**, not a hard block: offline signing continues under the T2 cap with staleness shown on the confirmation screen. Never raised for an immutable mint such as USDC, whose verdict cannot change silently |

## Canonical construction and validation — `CANON_*`

| Code | Raised when |
|---|---|
| `CANON_INSTRUCTION_NOT_ALLOWED` | Whitelist violation. `detail.programAddress` names the offender |
| `CANON_ACCOUNT_MISMATCH` | A derived account does not match the compiled message |
| `CANON_AMOUNT_MISMATCH` | Amount in the message differs from the expected amount — including a static-mode `verifyAuth` called without `expectedAmount`, where `detail.expected` is `null` (D30) |
| `CANON_DESTINATION_MISMATCH` | Destination ATA is not the merchant's |
| `CANON_INSTRUCTION_ORDER` | `AdvanceNonceAccount` is not first on the nonce path |

## Signature and verification — `SIG_*`

| Code | Raised when |
|---|---|
| `SIG_INVALID` | Payer signature does not verify against the rebuilt message |
| `SIG_LENGTH` | Signature is not 64 bytes |
| `SIG_FEE_PAYER_MISSING` | Submission attempted without the fee-payer signature |

## Nonce and pool — `NONCE_*`

| Code | Raised when |
|---|---|
| `NONCE_INDEX_OUT_OF_RANGE` | `index` outside 0–255. **The payer additionally checks it against its own pool size; the merchant MUST NOT** — the merchant has no way to know how many slots the payer's pool has, and D21 establishes that the pool size is not a bound the merchant can rely on anyway |
| `NONCE_ALREADY_SPENT` | The pool records this slot as used |
| `NONCE_LEDGER_MISSING` | The store holds no pool state, or the epoch marker is absent → **RECOVERY** state, offline signing blocked. Raised by `Pool.reserveSlot` (D32) |
| `NONCE_POOL_EXHAUSTED` | Every slot spent; the payer must reconnect |
| `NONCE_DESYNC` | On-chain value disagrees with the local record. See the reconciliation rule below — the code without the procedure is what `WIRE-8` was opened for |
| `NONCE_RETURN_UNTRUSTED` | A `NONCE_RETURN` failed verification: slot not recorded as spent, wrong signer for that slot, a signature that does not cover **this payer and this slot's recorded prior value** (D28 — a genuine return issued to another payer, or from an earlier cycle), or `newNonceValue` unchanged from the value the slot was signed against. Discarded silently in the UI; the slot stays spent. A non-zero `flags` byte fails earlier, in the codec, with `WIRE_FLAG_NOT_ALLOWED_FOR_TYPE` |
| `NONCE_ACCOUNT_CLOSED` | The nonce account no longer exists on chain. The payer closed the pool (T7) or never created it |

## Risk limits — `LIMIT_*`

| Code | Raised when |
|---|---|
| `LIMIT_RECEIPT_CAP` | Amount exceeds the tier's per-receipt cap |
| `LIMIT_QUEUE_EXPOSURE` | Merchant queue exposure cap reached |
| `LIMIT_FAILED_SENDS` | Consecutive failed-send counter reached |
| `LIMIT_SEND_WINDOW_EXPIRED` | Queued payment exceeded the product-level send window |
| `LIMIT_PRECHECK_REQUIRED` | A T1 nonce-path acceptance without a passing `precheckNonce` verdict. T1 hands over before confirmation; without the pre-check it carries T2's fabricated-nonce exposure while feeling safer. **Raised by `client/queue.ts`** (D30) |

## Submission — `SUBMIT_*`

| Code | Raised when | Fee | Counter |
|---|---|---|---|
| `SUBMIT_NONCE_STALE` | The nonce account **exists and is valid**, but its stored value has moved on. A genuine race: someone else settled against this nonce first | none | no |
| `SUBMIT_NONCE_ABSENT` | The nonce account is **missing, uninitialised, or its authority is not the payer**. Near-certain fraud — see below | none | **yes** |
| `SUBMIT_EXECUTION_FAILED` | Executed and failed, e.g. insufficient token balance or a frozen ATA. **Fee charged, nonce consumed** (`10-RESEARCH-solana.md` SOL-7) | **charged** | **yes** |
| `SUBMIT_ALREADY_PROCESSED` | The identical transaction was already submitted and landed. Duplicate-signature rejection from the status cache, not a nonce failure | none | no |
| `SUBMIT_BLOCKHASH_EXPIRED` | Fresh path only: the blockhash aged out before submission | none | no |
| `SUBMIT_RPC_UNAVAILABLE` | Transport failure; retry is safe | none | no |

## Internal — `INTERNAL_*`

Never user-facing, never copy-mapped. Each is a programming error.

| Code | Raised when |
|---|---|
| `INTERNAL_NOT_IMPLEMENTED` | A stub body from the stub-first protocol in `22-SPEC`. CI fails gate G1 if the string survives in `packages/core/src` (D34) |
| `INTERNAL_NOT_APPLICABLE` | An API called on a path it does not apply to — for example `precheckNonce` on a fresh-blockhash payment, which has no nonce account (D30) |

---

## Why `SUBMIT_NONCE_STALE` and `SUBMIT_NONCE_ABSENT` must stay distinct

They were one code — `SUBMIT_NONCE_REJECTED` — and splitting them is the mitigation for the
fabricated-nonce attack in `01-DECISIONS.md` D21.

Both are validation failures, both cost the merchant nothing, and both look identical from the RPC
error alone. They mean opposite things:

- **`SUBMIT_NONCE_STALE`** — the payer is honest and someone else settled first. Copy:
  *"Not charged — another merchant settled this payment first."* No counter.
- **`SUBMIT_NONCE_ABSENT`** — there was never a valid nonce account behind this payment. An attacker
  with **zero SOL and no on-chain accounts** can produce an `AUTH` that passes `verifyAuth` perfectly,
  because offline verification cannot see chain state. Copy must not reassure:
  *"This payment was not backed by a valid account. Nothing was charged, but the goods are gone.
  Consider requiring confirmation before handover."* Increments the failed-send counter.

Telling them apart requires one `getAccountInfo` on the derived nonce address at submission time.
That is the same call as the T1 pre-check, and in T1 it happens **before** handover, which is what
actually prevents the loss.

**The single most dangerous line in the earlier taxonomy** was mapping this fraud to copy that reads
*"another merchant settled this payment first — you were not charged."* It reassures the defrauded
merchant, and `51-DEMO-SCRIPT.md` planned to film it as the honest-failure clip.

---

## Where the payer's ledger is marked spent — corrected

The earlier taxonomy said *"the payer's ledger must mark the slot spent only on the second
[`SUBMIT_EXECUTION_FAILED`]"*. **That is unimplementable.** The payer is offline and never learns
which failure class occurred — that information lives in the merchant's queue, on the merchant's
device. Stream B and Stream C would have built incompatible state machines from that sentence.

The rule is per side:

| Side | Rule |
|---|---|
| **Payer** — `client/pool.ts`, persisted through Stream C's store (D32) | Mark the slot spent **before signing**: `Pool.reserveSlot` persists the record, and only then does the payer app call `signAsPayer`. It is the only fail-safe choice: signing a second payment against a slot that may already have settled is the failure `13-RESEARCH-pwa.md` exists to prevent. Re-arm it only via a verified `NONCE_RETURN` (`Pool.applyNonceReturn`, D28) or online reconciliation (`Pool.reconcile`) |
| **Merchant** — `client/queue.ts` | Increment the failed-send counter on `SUBMIT_EXECUTION_FAILED` and `SUBMIT_NONCE_ABSENT`. Never on `SUBMIT_NONCE_STALE` or a transport failure |

### `NONCE_DESYNC` reconciliation — the procedure, not just the code

Because the payer marks slots spent before signing, a merchant who never submits (grief, T3) leaves
the slot unspent on chain and spent locally. Without reconciliation the payer's offline capacity
drains with no way back. This closes `WIRE-8`.

On every online session, for each slot the pool records as spent:

1. Read the nonce account. If it is missing → `NONCE_ACCOUNT_CLOSED`, and the pool needs rebuilding.
2. If the on-chain value **differs** from `spentAgainstValue`, the payment settled (or the payer
   self-advanced). Every transaction signed against the old value is now dead, so **re-arm the
   slot**: state `unspent`, value = the on-chain value (D32). It is reported in `reconcile().settled`.
3. If the on-chain value **equals** `spentAgainstValue`, no transaction against that nonce has
   landed. If the send window (D23, 24 h) has elapsed since signing, the payment is presumed
   abandoned: **release the slot** (state `unspent`, value unchanged) and record `NONCE_DESYNC` for
   the UI. A merchant who submits that payment after the window now races the payer's next payment on
   the same slot; the window is the merchant's contract, and a late submission is the merchant's
   loss. Releasing by self-advancing the nonce instead is tracked as `NONCE-9` (non-blocking).
4. Before the window elapses, leave it spent. Releasing early risks double-signing against a nonce
   whose payment is still in a merchant's queue.

The window is the only thing making step 3 safe, and it is a product-level heuristic, not a
guarantee — say so in the failure copy.
