# Research — Solana protocol & @solana/kit

Answers to the `SOL-*` questions. Every claim here is backed by either a runnable experiment in
`experiments/`, a type definition read from an installed package, or a live RPC call.

**Verification date: 2026-08-27.** Package versions probed: `@solana/kit@8.0.0`,
`@solana-program/system@0.14.0`, `@solana-program/token@0.16.0`, `@solana-program/token-2022@0.16.0`.

---

## SOL-1 · Kit API surface — RESOLVED

Kit 8.0.0 exports 955 symbols. The ones this project needs:

**Building a message**
```
createTransactionMessage({ version })
setTransactionMessageFeePayer(address, msg)
setTransactionMessageLifetimeUsingDurableNonce({ nonce, nonceAccountAddress, nonceAuthorityAddress }, msg)
setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, msg)
appendTransactionMessageInstructions(instructions, msg)
compileTransactionMessage(msg)   // -> CompiledTransactionMessage
compileTransaction(msg)          // -> { messageBytes, signatures }
```

`setTransactionMessageLifetimeUsingDurableNonce` **prepends the `AdvanceNonceAccount` instruction
itself**. We never construct it by hand, and the protocol's "must be first instruction" rule is
enforced by the library, not by our discipline.

**Signing and verifying**
```
generateKeyPair()                                  // -> CryptoKeyPair (WebCrypto)
createKeyPairFromBytes / createKeyPairFromPrivateKeyBytes
getAddressFromPublicKey(cryptoKey)
partiallySignTransaction(keyPairs: CryptoKeyPair[], tx)
verifySignature(key: CryptoKey, signature: SignatureBytes, data: Uint8Array)
createNoopSigner(address)                          // for the fee payer who signs later
```

**Addresses and codecs**
```
createAddressWithSeed({ baseAddress, programAddress, seed })
getProgramDerivedAddress, getAddressEncoder/Decoder
getBase58Encoder/Decoder, getBase64Encoder/Decoder
getTransactionEncoder/Decoder, getCompiledTransactionMessageEncoder/Decoder
```

**Guardrails kit gives us for free** — these error constants exist, so kit validates them:
```
SOLANA_ERROR__TRANSACTION__INVALID_NONCE_TRANSACTION_FIRST_INSTRUCTION_MUST_BE_ADVANCE_NONCE
SOLANA_ERROR__TRANSACTION__INVALID_NONCE_ACCOUNT_INDEX
SOLANA_ERROR__TRANSACTION__NONCE_ACCOUNT_CANNOT_BE_IN_LOOKUP_TABLE
SOLANA_ERROR__TRANSACTION__EXPECTED_NONCE_LIFETIME
```

> The third one independently confirms `VadumInfo.md` §6.1: a nonce account can never live in an
> Address Lookup Table. That was an inference in the document; it is a library-enforced rule.

**Also present, unexpected, and relevant later:** `compileOffchainMessageV1Envelope`,
`signOffchainMessageEnvelope`, `verifyOffchainMessageEnvelope`. Kit has a first-class *offchain
message* (sign-a-blob-that-is-not-a-transaction) API. That is the primitive the v2 voucher
architecture in `VadumInfo.md` §11 would be built on, and it is also the cleanest way to implement
signed merchant identity for the QR-swap mitigation (§5.8). Not needed for v1; note it and move on.

---

## SOL-2 · System program instructions — RESOLVED

`@solana-program/system@0.14.0` exports a complete nonce lifecycle:

| Need | Function |
|---|---|
| Create nonce account at a derived address | `getCreateAccountWithSeedInstruction` |
| Initialize | `getInitializeNonceAccountInstruction` |
| Advance | `getAdvanceNonceAccountInstruction` (kit prepends this for us) |
| Change authority | `getAuthorizeNonceAccountInstruction` |
| Close + refund rent | `getWithdrawNonceAccountInstruction` |
| Upgrade legacy nonce | `getUpgradeNonceAccountInstruction` |
| Read one / many | `fetchNonce`, `fetchMaybeNonce`, `fetchAllNonce`, `fetchAllMaybeNonce` |
| Decode raw bytes | `decodeNonce`, `getNonceDecoder`, `getNonceSize` |

Also available: `getCreateAccountAllowPrefundInstruction` — creates an account that already holds
lamports. It was noted for sponsor flows; D26 removed the sponsor from v1, so nothing uses it.

---

## SOL-3 · Nonce account layout — RESOLVED

From `@solana-program/system/dist/types/generated/accounts/nonce.d.ts`:

```ts
type Nonce = {
  version: NonceVersion;          // u32 — Legacy = 0, Current = 1
  state: NonceState;              // u32 — Uninitialized = 0, Initialized = 1
  authority: Address;             // 32 bytes
  blockhash: Address;             // 32 bytes  ← THE NONCE VALUE
  lamportsPerSignature: bigint;   // u64
};
```

Total **80 bytes**, confirming `VadumInfo.md` §3.2. The nonce value sits at **offset 40**.

**Do not hand-parse it.** Use `getNonceDecoder()` / `fetchNonce()`. The `blockhash` field is typed as
`Address`, i.e. it is handled as a base58 string, not raw bytes — a detail that will bite anyone who
assumes `Uint8Array`.

---

## SOL-4 · Is canonical rebuild byte-identical? — RESOLVED ✅ (experiment)

**This is the load-bearing assumption of the entire architecture.** Run
`experiments/canonical-rebuild.mjs`:

```
message bytes (payer)   : 354
message bytes (merchant): 354
BYTE-IDENTICAL REBUILD  : YES ✅
offline sig verify      : VALID ✅
full signed tx on wire  : 483 bytes
```

Two independent calls to the same builder, given the same inputs, produce byte-identical
`messageBytes`. Solana message compilation orders accounts deterministically (writable signers →
readonly signers → writable non-signers → readonly non-signers, with the fee payer first), and kit
does not introduce any nondeterminism of its own.

**Consequence:** we never transmit a transaction. We transmit the *inputs*, and both sides compile.

**Consequence for the spec:** determinism is a property of *kit's compiler version*, not of the
protocol. `24-SPEC-fixtures.md` must therefore pin golden message bytes, and CI must fail if a
dependency bump changes them. This is the single most important regression test in the project.

---

## SOL-5 · Nonce address derivation — RESOLVED

`createAddressWithSeed({ baseAddress, programAddress, seed })` derives
`sha256(base || seed || owner)`. With `baseAddress = payer` and `seed = "vadum-<i>"`, the merchant
can derive every nonce account address in the payer's pool from **the payer's pubkey plus a
one-byte index**. That removes 32 bytes from the QR#2 payload.

Constraint: the seed is ASCII and capped at `Pubkey::MAX_SEED_LEN` (32). `"vadum-0"` … `"vadum-255"`
fits comfortably.

**SOL-5b — resolved by scope, not by measurement.** The sub-question was: when `base != from` in
`CreateAccountWithSeed`, do both the funder and the base account have to sign? It matters only if a
**sponsor** funds the payer's pool, and `01-DECISIONS.md` D26 removes the sponsor from v1 — a
sponsored pool is a free faucet, because `WithdrawNonceAccount` needs only the nonce authority and
that must be the payer.

With no sponsor, `from == base == payer`: **one signer, one signature, no ceremony.** The onboarding
step `VadumInfo.md` does not mention shrinks to a single online screen where the payer deposits their
own refundable rent — about 0.0066 SOL for N=5 on mainnet in September 2026 (D39), plus the wallet floor
at setup (D38). Observed on devnet on 2026-09-11: one signature. `CreateAccountWithSeedInput.baseAccount` accepts a
`TransactionSigner` precisely for the two-party case, so the capability is there if v2 wants it.

---

## SOL-6 · What gets signed, and offline verification — RESOLVED ✅ (experiment)

A signer signs `compileTransaction(msg).messageBytes` — the compiled message, not the wire
transaction. The merchant therefore verifies offline with:

```ts
const rebuilt = await buildMessage(input);   // same builder, same CanonicalInput (22-SPEC)
const ok = await verifySignature(payerPublicKey, sigBytes, rebuilt.messageBytes);
```

Proven working in `experiments/canonical-rebuild.mjs`. No network, no RPC.

---

## SOL-7 · Fee semantics on failure — RESOLVED

Two distinct failure classes with opposite fee behaviour:

| Failure | Nonce advanced? | Fee charged? | Who pays |
|---|---|---|---|
| **Validation** — nonce mismatch (already spent), authority did not sign, account missing | No | **No** | nobody |
| **Execution** — instruction returns an error, e.g. insufficient token balance | **Yes** | **Yes** | fee payer = merchant |

Two consequences the threat model must absorb:

1. **Good news.** A merchant who loses a multi-merchant double-spend race pays nothing — the losing
   transaction fails validation and is dropped. Merchants lose goods, never fees, in that scenario.
2. **Bad news.** A payer who signs against an underfunded token account burns the merchant's fee
   *and* consumes a nonce. Cheap — 5,000 lamports per signature, so 10,000 for a payer-and-merchant payment, observed in Phase 0
   — but repeatable. `31-PARAMETERS.md` needs a
   failed-send counter alongside the queue exposure cap.

Also documented: durable nonce transactions take the fee rate from the *working bank at submission
time*, not from signing time. Fee is not fixed at signature. Irrelevant at current fee levels;
record it so nobody rediscovers it in a panic.

**How to observe each class — and a test that shows neither.** Resubmitting the *identical*
transaction is rejected by duplicate detection whether or not a nonce is involved, so it is evidence of
neither class (D35). A validation failure is observed by submitting a **different** message against a
consumed nonce with `skipPreflight: true` and confirming it never lands and costs nothing; an execution
failure by submitting with `skipPreflight: true` and confirming it lands with an error and a fee. With
preflight on, the RPC's own simulation rejects both before any validator sees them, which says nothing
about fees (`60-PHASE0-derisk.md`, observation method).

---

## SOL-8 · New nonce value after advance — RESOLVED

On advance, the new stored value is `hash(current_blockhash || fixed_string)`.

Two consequences:

1. **It is not predictable offline.** An offline payer cannot compute its own next nonce. This
   confirms that the recovery flow in `VadumInfo.md` §5.9 — the merchant hands the advanced nonce
   back over a QR — is *necessary*, not merely convenient.
2. **A blockhash can never be a valid nonce value, and vice versa.** This is a free invariant: the
   signer's whitelist validator can use it to guarantee a fresh-blockhash message can never be
   replayed as a durable-nonce one.

---

## SOL-14 · The token authority MUST be passed as a signer — NEW, and it is a trap

`getTransferCheckedInstruction` accepts `authority` as either an `Address` or a `TransactionSigner`.
Measured consequence (`experiments/signer-check.mjs`):

| Lifetime | `authority` passed as | `numRequiredSignatures` | Payer marked as signer? |
|---|---|---|---|
| nonce | bare `Address` | 2 | yes |
| nonce | `createNoopSigner(payer)` | 2 | yes |
| **fresh** | **bare `Address`** | **1** | **NO** |
| fresh | `createNoopSigner(payer)` | 2 | yes |

On the durable-nonce path a bare `Address` is harmless, because `AdvanceNonceAccount` already marks
the payer as a signer. **On the fresh-blockhash path it silently does not.** The message compiles,
the account list is identical (248 bytes either way — only the one header byte differs), the
signature verifies offline, and the transaction is rejected on chain for a missing signature.

Offline, with no RPC to catch it, this is invisible until settlement — the worst possible place.

**Rule:** the canonical builder **MUST** pass `authority: createNoopSigner(payer)`. Likewise the
fee payer and the `createAssociatedTokenAccountIdempotent` funder are `createNoopSigner(intent.feePayer)`
(D19 — the merchant, in v1): the payer builds a message that requires the merchant's signature without
ever holding the merchant's key.

---

## SOL-11 · Devnet practicalities — PARTIAL, and the faucet is not usable

The public devnet faucet (`api.devnet.solana.com` `requestAirdrop`) returns **HTTP 429** and opaque
`-32603 Internal error` responses under load. Observed on 2026-08-27 across 2 / 1 / 0.5 SOL requests
from a single IP. The RPC itself is healthy (`getHealth` → `ok`); only the faucet is throttled.

**Consequence:** neither Phase 0 nor CI may depend on the faucet. `phase0-derisk.mjs` therefore takes
`--merchant-key <cli-keypair.json>` for a pre-funded account, retries the faucet with backoff only as
a fallback, and prints funding instructions instead of failing opaquely.

It also has a **`--dry`** mode that runs the entire offline half — canonical builder, byte-identical
rebuild, offline verification, AUTH codec, network guard — with no chain and no SOL. Use it to
validate changes before spending devnet SOL.

---

## SOL-9 · Nonce account rent — RESOLVED (live RPC, 2026-08-27)

```
getMinimumBalanceForRentExemption(80)
  mainnet-beta : 1,447,680 lamports = 0.00144768 SOL
  devnet       : 1,447,680 lamports = 0.00144768 SOL
```

> **Superseded on 2026-09-11 (D39).** The same call now returns **1,317,264** lamports on mainnet-beta
> (6,333 per byte-year, SIMD-0437's first tier) and **1,056,640** on devnet (5,080, the second tier),
> while the SIMD file still reads `status: Idea`. The paragraph below was right on 2026-08-27 and is kept
> as a record; its conclusion that no tier had activated no longer holds.

Matches `VadumInfo.md` §3.2 exactly. It is the pre-reduction value (208 bytes × 6960) because
**SIMD-0437 has not been accepted**: the proposal reads `status: Idea` with no feature key, so no tier
has activated on any cluster (D7, `03-VADUMINFO-ERRATA.md` E1). An earlier revision of this paragraph
noticed the unchanged number and wrote it off as "not observable in the RPC's answer yet"; the
unchanged number was the answer.

**Decision (see `01-DECISIONS.md`): never hardcode rent.** Always call
`getMinimumBalanceForRentExemption(getNonceSize())` at pool-setup time.

---

## SOL-10 · Ed25519 in the browser — RESOLVED

Kit signs and verifies through WebCrypto (`CryptoKey`, not raw bytes). Ed25519 in `SubtleCrypto`:

| Engine | Available since |
|---|---|
| Safari | 17.0 (Sept 2023) |
| Firefox | 129 (Aug 2024) |
| Chrome / Chromium | **137 — 27 May 2025** |

> **Corrected.** An earlier revision dated Chrome 137 to May 2026 and argued "Chrome 137 is recent".
> It shipped fifteen months ago; May 2026 was Chrome 148. The Safari and Firefox dates were right,
> which is what marks this as a transcription slip rather than a systematic error.

**The polyfill decision survives; its justification changes.** Native Ed25519 has been in Chrome for
over a year, so the population needing `@solana/webcrypto-ed25519-polyfill@8.0.0` is a long tail of
un-updated cheap Android and vendor WebView builds — not the mainstream. Load it conditionally (D9),
and justify it on device lag, never on recency.

**One honest limit belongs in the README.** The polyfill is `@noble/ed25519` keeping key material in
module-scoped `WeakMap`s. It honours `extractable: false` at the API surface, but the private key
lives in the JS heap where any XSS or compromised dependency can read it. Native WebCrypto never puts
key material in JS memory. So "non-extractable key" is a real guarantee on the native path and a
*convention* on the polyfill path.

**Also, for `24-SPEC-fixtures.md`:** Safari's Ed25519 signing is **non-deterministic** — the same key
over the same message yields different valid signatures. Fixtures must pin *message bytes* and verify
signatures, never compare a signature against a stored constant.

Node 22.18 supports Ed25519 natively (verified locally), but D1 sets the floor at Node 24 for
unrelated reasons.

---

## Still open

| ID | Question | Resolution |
|---|---|---|
| SOL-5b | Do both funder and base sign `CreateAccountWithSeed`? | ✅ **Moot.** D26 removes the sponsor, so `from == base == payer` and there is one signer. The two-party ceremony does not exist |
| SOL-11 | Devnet RPC limits, airdrop caps, test mint creation | ✅ Faucet unusable; D15 + `--merchant-key`. D24 settles the mint: an own devnet mint for fixtures, live mints read-only for compatibility |
| SOL-12 | Can the payer be a non-writable signer holding zero SOL? | ✅ **Yes**, and it did not need Phase 0. The compiled header is `numSignerAccounts: 2, numReadonlySignerAccounts: 1`. **SIMD-0392 is `relax_post_exec_min_balance_check`** — already in Agave 4.2 and live on devnet/testnet — and it is a *relaxation* of the post-execution check, so it makes this safer, not riskier |
| SOL-13 | Do we need compute budget / priority fee instructions? | ✅ **Not in v1** (D16, devnet only). And they cannot be added at submission time: the merchant cannot alter a message the payer signed offline, so a priority fee must live in the canonical input set and therefore in the wire format. This had to be decided, not measured |

---

## SOL-15 · Durable-nonce transactions need a different confirmer — NEW, and it is why Phase 0 could not pass

`sendAndConfirmTransactionFactory` is kit's **blockhash-lifetime** confirmer. Its parameter type is
`SendableTransaction & Transaction & TransactionWithLastValidBlockHeight`, and a durable-nonce
transaction has no `lastValidBlockHeight` — compiling one and inspecting it gives
`lifetimeConstraint keys: ['nonce', 'nonceAccountAddress']`.

Submitting a durable-nonce transaction through it against live devnet returns immediately:

```
SolanaError: The network has progressed past the last block for which this
             transaction could have been committed.       (__code 1, BLOCK_HEIGHT_EXCEEDED)
```

Kit ships **`sendAndConfirmDurableNonceTransactionFactory({ rpc, rpcSubscriptions })`** for exactly
this. `experiments/phase0-derisk.mjs` imported neither and used the blockhash factory throughout, so
its ASSERT A could never have succeeded — and the script's ASSERT B checked only "an error occurred"
and "the merchant's balance did not change", both of which are trivially true when nothing was ever
confirmed. **The assertion the plan calls "the whole point" could have gone green while proving
nothing.**

Rule: the nonce path uses `sendAndConfirmDurableNonceTransactionFactory`; the fresh path uses
`sendAndConfirmTransactionFactory`. Never the reverse, and never one for both.

---

## SOL-16 · SIMD-0571 — the soft-deprecation proposal, and what it means for us

Full analysis is `01-DECISIONS.md` D17. The short version, because it belongs with the protocol
research:

- **SIMD-0571 "Soft Deprecation of Durable Nonces"**, PR #571, `status: Idea`, no feature key.
  Treats a durable-nonce transaction's requested compute-unit price as `0` for fee collection
  (consensus-critical) and scheduler priority (leader-local). The transaction stays valid; the
  format is unchanged.
- **Approval state is further along than the status suggests**: both Anza and Firedancer approved on
  2026-08-20, then Firedancer requested changes on 2026-08-24 — *"the design is still fine, but we'd
  like to talk more internally about the goal of the SIMD"*.
- **Impact on us is close to nil, and the proposal says so**: *"~94% of blocks are not full, so a
  priority-fee-0 transaction lands within a slot or two with very high probability"*, and
  *"a fee-payer able to cover only the base fee is valid after activation"* — which is our merchant
  exactly. We already cannot express a priority fee (D16), so we lose nothing that was available.
- **Two things to carry forward:** the motivation text says durable nonces are *"expected to be
  deprecated and eventually removed"*, which is why the nonce-provider abstraction returns to v1
  (D17); and 0571 defines the blockhash/nonce **domain separation** normatively, which upgrades the
  replay argument in `30-THREAT-MODEL.md` from a probability claim to a structural one. Cite 0571
  for that, not SIMD-0242 — 0571's reviewer states plainly that *"SIMD-0242 is actually wrong"*.
