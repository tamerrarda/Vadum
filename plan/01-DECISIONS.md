# Decisions

Locked decisions, newest section last. A coding session that finds itself making a design choice
should stop and add it here instead. Format: decision · rationale · what it rules out.

Status: `LOCKED` · `PROVISIONAL` (needs a measurement to confirm) · `OWNER` (product owner's call)

---

## D1 · Stack — LOCKED

| | |
|---|---|
| SDK | `@solana/kit@8.0.0` |
| Programs | `@solana-program/system@0.14.0`, `@solana-program/token@0.16.0`, `@solana-program/token-2022@0.16.0` |
| Signing | WebCrypto via kit (`CryptoKeyPair`), **not** raw-byte libraries |
| Runtime floor | **Node ≥ 24** — see below |

Kit is the recommended SDK for new projects and is tree-shakeable and browser-first. Its one real
drawback — Anchor incompatibility — is irrelevant here because **no on-chain program is written**
(`VadumInfo.md` §6.4). All four packages agree on `@solana/kit@^8.0.0` as a peer; pin them together
and bump them together.

**The Node floor is 24, not kit's 20.18.** Measured `engines` fields of the pinned packages:

| Package | `engines.node` |
|---|---|
| `@solana/kit@8.0.0` | `>=20.18.0` |
| `@solana-program/system@0.14.0` | *(none)* |
| `@solana-program/token@0.16.0` | **`>=24.0.0`** |
| `@solana-program/token-2022@0.16.0` | **`>=24.0.0`** |

Installing on Node 22 emits `EBADENGINE` for both token packages. Node 24 goes into `package.json`
`engines`, the CI matrix and the README.

**Transitive dependency, and it breaks `20-ARCHITECTURE.md`'s "nothing else" claim.**
`@solana-program/token-2022` peer-depends on `@solana/sysvars ^8.0.0` and `@solana/zk-sdk ^0.5.1`.
A default install resolves `@solana/sysvars@8.1.0` *alongside* kit's own `8.0.0`, putting two
versions of an `@solana/*` package in a library whose entire safety argument is byte-level
determinism. Pin `@solana/sysvars` explicitly and add a CI check that no two `@solana/*` versions
coexist in the lockfile.

**Version delta.** `@solana/kit@8.1.0` shipped 2026-08-27, the same day as the research. Staying on
8.0.0 is deliberate; the canonical nonce message was verified **byte-identical across 8.0.0 and
8.1.0**, so this bump is not the determinism risk D3 warns about — but the pin stays exact and moves
only with a regenerated fixture set.

*Rules out:* `@solana/web3.js` v1 and the v3 bridge line.

---

## D2 · Applications are PWAs, not React Native — LOCKED

Service-worker PWAs launch in airplane mode, install on two phones in under a minute, need no app
store, and get to the demo video weeks earlier. The SDK itself is platform-agnostic TypeScript, so
this constrains only the reference apps.

*Rules out:* React Native / Expo for v1. Revisit only if secure-element key storage lands (deferred).

---

## D3 · Never transmit a transaction — LOCKED (asserted, guarded by CI)

Both sides compile the message from the same canonical inputs; only the fields the receiver cannot
derive cross the air gap. Proven byte-identical in `experiments/canonical-rebuild.mjs`.

Measured consequence:

| | Air-gap payload | QR version @ EC-M |
|---|---|---|
| Transmit the signed transaction | 483–525 B | v17 |
| Transmit canonical inputs | **131 B** | **v8** |

*Rules out:* any design where QR#2 carries a serialised transaction. Also rules out the
merchant-builds-the-transaction variant of `VadumInfo.md` §3.5 — the merchant does not know the
payer's pubkey at QR#1 time, so that flow would need three QR hops. Canonical rebuild is the only
two-hop design.

**Load-bearing risk:** determinism is a property of kit's compiler, not of the protocol. CI must
pin golden message bytes (`24-SPEC-fixtures.md`) and fail on any dependency bump that changes them.

**Do not overstate what the experiment proves.** `canonical-rebuild.mjs` calls the same function
twice, in the same process, on the same JavaScript objects, under the same package version. Byte
identity there is close to tautological — it cannot fail short of nondeterminism inside kit. What
actually needs proving is that a payload **serialised, base45-encoded, scanned and decoded** rebuilds
the same bytes, and that is the loopback test in `50-INTEGRATION.md` G3, not this script. The
cross-version claim belongs to CI against pinned fixtures. The experiment also passes
`authority: payer` as a bare `Address`, which D14 forbids; the 354 B / 483 B figures it produced are
therefore from a builder the spec rules out. Harmless on the nonce path, but the script must be
rewritten to use `createNoopSigner` and to round-trip through the codec.

---

## D4 · Durable nonce is the default path — LOCKED (OWNER)

Fresh blockhash remains in the SDK as an opt-in optimisation for merchants who declare solid
connectivity, and as the deprecation hedge from `VadumInfo.md` §3.6. It is not the default.

Two independent reasons (see `14-RESEARCH-prior-art.md`):

1. **Positioning.** Fresh-blockhash offline signing is the obvious approach and it has been
   attempted — Zypp Labs ships a wallet, an SDK, a relay and a whitepaper on exactly that model,
   without ever addressing the sub-minute expiry window (~45 s today — `03-VADUMINFO-ERRATA.md` E3). Defaulting to it puts Vadum in that bucket
   and keeps the novel primitive off the default path.
2. **Scope.** Both-parties-offline mode is in v1 (D6), and a sub-minute window cannot survive a
   merchant queue. Durable nonce is the only path that covers all three v1 modes.

---

## D5 · `createAssociatedTokenAccountIdempotent` stays in the canonical message — LOCKED (OWNER)

Measured cost of keeping it:

| | Without | With |
|---|---|---|
| Compiled message | 354 B | 396 B |
| Full signed transaction | 483 B | 525 B |
| **QR#2 air-gap payload** | **131 B** | **131 B — unchanged** |

The instruction is derived from a flag bit in the intent, so it never crosses the air gap. Byte-identical
rebuild verified with it included. **The decision costs zero QR bytes.**

**Corrected rationale.** An earlier draft justified this as "the both-offline mode where the merchant
may genuinely lack an ATA", which is not a coherent argument on its own — the merchant always knows
whether its own ATA exists. The real reason is *offline merchant onboarding*: a merchant who has
never received this mint, and who is offline at acceptance time, still ends up with a working ATA
because the rent is funded from their own SOL by `createNoopSigner(intent.feePayer)` **at submission
time, when they are back online**. Keeping the branch costs zero QR bytes and removes a setup
precondition that would otherwise have to be enforced during onboarding.

`11-RESEARCH-tokens.md` TOK-6/TOK-7 previously carried the opposite recommendation ("drop it from
the v1 canonical message"). That recommendation is **withdrawn**; the research file has been
rewritten to record this decision instead.

*Consequence:* the `DefaultAccountState: frozen` edge case stays live and `assertMintCompatible`
must hard-block such mints (`11-RESEARCH-tokens.md` TOK-3).

---

## D6 · v1 scope — LOCKED (OWNER)

**In:**
- Static merchant QR mode — printed sticker, payer enters the amount, one QR hop
- iOS support — requires a WASM scanner fallback alongside `BarcodeDetector`
- Both-parties-offline mode — with a lower cap than the primary mode

**Deferred to v2:**
- Payment cancellation as a *product feature* (a cancel button, with UX and reconciliation)
- Secure element / attestation hardening
- Time-locked vault (`VadumInfo.md` §11)

> ⚠️ **Deferring the feature does not defer the capability.** `AdvanceNonceAccount` and
> `WithdrawNonceAccount` require only the nonce authority, which is the payer by construction. A
> payer can therefore sign N payments, come online, and self-advance or close every nonce account —
> voiding every queued payment at zero cost with the rent refunded. This is available **today**,
> whether or not we ship a button for it. It is recorded as threat T7 in `30-THREAT-MODEL.md`, and it
> is the reason the send window and the pool size bound *honest failure* only, never an attacker.

---

## D7 · Never hardcode rent — LOCKED

> **The correction paragraph below is superseded by D39 (2026-09-11).** It was accurate when written;
> since then the live clusters show SIMD-0437's schedule in effect — mainnet at its first tier, devnet at
> its second — while the SIMD file still reads `status: Idea`. The decision itself is now load-bearing.

Always `getMinimumBalanceForRentExemption(getNonceSize())`. Live value on 2026-08-27 is
1,447,680 lamports on both mainnet and devnet.

**Correction to `VadumInfo.md` §3.2, §7 leg 5 and §14.** The document states that SIMD-0437 "kabul
edildi" and that its first tier "aktive edildi". Fetched from the SIMD repository on 2026-08-29, the
proposal reads `status: Idea` with `feature: (fill in with feature key ... once accepted)`. **No tier
has activated on any cluster**, which is confirmed independently by the live Rent sysvar still
carrying `lamports_per_byte_year = 6960`. `10-RESEARCH-solana.md` SOL-9 half-caught this and wrote
it off as "not observable in the RPC's answer yet"; the correct conclusion was that the SIMD is not
accepted.

The honest sentence: *a five-tier 90% rent reduction is proposed (SIMD-0437, Idea stage); today's
number is 0.00144768 SOL per nonce account and that is what we budget.* Agave 4.2 shipping the code
is not mainnet activation — do not repeat press coverage that conflates the two.

The decision itself is unaffected and correct.

---

## D8 · Mint compatibility is enforced, not assumed — LOCKED

`assertMintCompatible(mint)` runs while online, caches a timestamped verdict, and hard-blocks a mint
with an active transfer hook, a non-zero transfer fee, or `DefaultAccountState: frozen`. It warns on
`permanentDelegate`. See `11-RESEARCH-tokens.md` for the full table and the live extension data for
USDC, USDG and PYUSD.

*Consequence:* `VadumInfo.md` §3.4's claim that the same code runs unchanged on USDG and PYUSD is
withdrawn and replaced by the accurate, stronger claim in `11-RESEARCH-tokens.md`.

---

## D9 · Ed25519 polyfill is mandatory — LOCKED

`@solana/webcrypto-ed25519-polyfill@8.0.0`, loaded conditionally. Chrome shipped WebCrypto Ed25519
in **137 (27 May 2025)** — not May 2026, as an earlier draft of `10-RESEARCH-solana.md` stated.
Safari 17.0 (Sept 2023) and Firefox 129 (Aug 2024) in the same table are correct.

**The decision survives, the argument does not.** Native Ed25519 has been in Chrome for roughly
fifteen months, so the polyfill population is a long tail of un-updated cheap Android and WebView
builds, not the mainstream. Justify D9 on vendor-Chrome and WebView lag on low-end devices, never on
recency.

**Honest limit that must reach the README (and `13-RESEARCH-pwa.md` APP-2).** The polyfill is
`@noble/ed25519` holding key material in module-scoped `WeakMap`s. It honours `extractable: false`
at the API surface, but the private key bytes live in the JS heap and are readable by any XSS or
compromised dependency — native WebCrypto never puts key material in JS memory. "Non-extractable
key" is therefore true on native paths and a *convention* on the polyfill path. Consider gating the
T1/T2 tiers on native WebCrypto being present.

---

## D10 · Dual scanner path — LOCKED (follows from D6)

`BarcodeDetector` where available (Chromium on Android), `zxing-wasm` fallback everywhere else. iOS
has no `BarcodeDetector` in any browser.

*Measurement consequence:* read-success rates must be reported **per engine**. An Android
`BarcodeDetector` number and an iOS WASM number must never be blended into one headline figure.

> ⚠️ **`zxing-wasm` fetches its `.wasm` from a CDN by default, which makes the iOS scanner dead in
> airplane mode.** `zxing-wasm@3.1.3` bakes a jsDelivr URL in at build time
> (`https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.3/dist/…`, confirmed in the shipped bundle). D6
> and D10 together make it the **only** scan path on iOS, so with the radio off the fetch fails and
> the scanner never initialises — on the exact platform and in the exact condition the product is
> built for. The plan discussed WASM warm-up cost and never mentioned this.
>
> **MUST:** bundle the `.wasm` locally, point `prepareZXingModule({ overrides: { locateFile } })` at
> a same-origin URL, add the file to the service-worker precache manifest, and put "cold-start with
> the radio off, then scan a QR" into `42-STREAM-C-apps.md`'s `AIRPLANE-MODE-CHECKLIST`. A scanner that
> works in the office and fails in the field is worse than no iOS support.

---

## D14 · Counterparties are represented with `createNoopSigner` — LOCKED (proven)

The canonical builder passes `authority: createNoopSigner(payer)` and, when the ATA instruction is
included, `payer: createNoopSigner(intent.feePayer)`. Never bare addresses.

> An earlier revision of this decision said `createNoopSigner(merchant)`. **D19 supersedes it**:
> the funder is `intent.feePayer`, which equals `merchant` unless `FEE_PAYER_SEPARATE` is set — and
> that flag is unsupported in v1, so the two coincide today. Written as `intent.feePayer` so the
> builder does not have to change when the relayer path lands.

A bare `Address` for `authority` yields `numRequiredSignatures = 1` on the fresh-blockhash path: the
payer is not marked as a signer, the message verifies offline, and the chain rejects it. Verified in
`experiments/signer-check.mjs` and asserted in `experiments/phase0-derisk.mjs --dry`.

---

## D15 · Nothing depends on the devnet faucet — LOCKED

The public faucet returns HTTP 429 under normal use. Phase 0 accepts `--merchant-key` for a
pre-funded account and only falls back to the faucet with backoff. CI must never call it.

---

---

## D11 · QR error-correction level is EC-Q — LOCKED

Was provisional pending "the Stream B measurement run". It was never actually waiting on a
measurement: the cost is already measured and the benefit is a property of the deployment
environment, not of our code.

| Payload | EC-L | EC-M | **EC-Q** |
|---|---|---|---|
| `AUTH` nonce/dynamic (132 B) | v7 · 45px | v8 · 49px | **v10 · 57px** |

Two QR versions for tolerance of scratched screens, glare and partial occlusion, in a product whose
stated environment is cheap phones at market stalls in sunlight. Still far below the v17–v20 that
`VadumInfo.md` §6.1 budgeted.

The measurement run still reports read-success rate per engine — it just does not get to change this
default. If EC-Q proves unnecessary the change is one config value and a fixture regeneration.

*Consequence:* `24-SPEC-fixtures.md` pins the QR version at **both** EC-M and EC-Q, since EC-Q is the
shipped default and EC-M is the comparison baseline in the measurement report.

---

## D12 · base45 is vendored into `packages/wire`, not depended on — LOCKED

Was provisional, framed as a supply-chain style preference. It is not a preference. `base45@2.0.1`
is **functionally wrong in the security-critical direction**, verified against the installed package:

```
decode("!!!")  -> f7e9      out-of-alphabet chars: indexOf() returns -1 and is used arithmetically
decode("abc")  -> f7e9      lowercase silently accepted
decode("A")    -> 00        1-char tail, invalid per RFC 9285, accepted
decode("ABCD") -> 60e500    length 3n+1, invalid per RFC 9285, accepted (NaN -> 0x00)
```

It throws only on numeric overflow. **Invalid input silently produces wrong bytes**, which surface
later as `SIG_INVALID` — the exact opposite of the `WIRE_BASE45_INVALID` contract that
`23-SPEC-errors.md` promises and `24-SPEC-fixtures.md` tests.

It is also CommonJS-only with no `exports` map, and both `encode` and `decode` use Node's `Buffer`
global, which Vite does not polyfill. D1 locks ES modules only. So it cannot ship into either PWA
without a shim.

Vendoring is ~60 lines of RFC 9285 with `Uint8Array` in and out, a strict alphabet check, and a
length check (`len % 3 ∈ {0, 2}`). Package provenance supports the same conclusion: created
2021-03-20, last modified 2022-04-11, single maintainer.

*Consequence for `41-STREAM-B-wire-client.md` B1:* the done-condition must include a **negative** suite —
out-of-alphabet, lowercase, 1-char tail, overlong group — each raising `WIRE_BASE45_INVALID`. The
original criterion tested only encoding and valid round-trips, so it would have passed with the
defect intact.

---

## D16 · v1 targets devnet only, and carries no priority fee — LOCKED (OWNER)

Mainnet is v1.1. The wire format freezes without any compute-budget field, and `flags` bits 5–7 stay
reserved.

**This closes SOL-13, which was the one open question able to invalidate the frozen format.** A
priority fee cannot be bolted on later at submission time: the merchant is the fee payer but cannot
add a `ComputeBudget` instruction without altering the message the payer signed offline. It must
therefore be part of the canonical input set — i.e. in the QR, i.e. in the wire format. Answering
SOL-13 "yes" after freeze would invalidate every fixture and every layout.

*Consequence:* the README must state plainly that v1 is base-fee-only and is not intended for
congested mainnet. The mainnet path bumps `version` to `0x02` and the natural first use of reserved
bit 5 is `PRIORITY_FEE`, with `computeUnitPrice` (u64) and `computeUnitLimit` (u32) in `INTENT`.

*See also D17 (SIMD-0571), which makes this cost considerably smaller than it first appears.*

---

## D17 · Durable nonce stays the default, with the deprecation hedge reinstated — LOCKED (OWNER)

`VadumInfo.md` §6.3 assessed deprecation risk from **Discussion #415** — a *wrapping* proposal — and
concluded "this is a maintenance risk, not a build risk". That assessment was incomplete. Read in
full on 2026-08-29:

**SIMD-0571, "Soft Deprecation of Durable Nonces"** · PR #571 · author Max Resnick · opened
2026-06-24 · `status: Idea`, no feature key.

It treats a durable-nonce transaction's requested compute-unit price as `0`, for both fee collection
(consensus-critical MUST) and scheduler prioritisation (leader-local SHOULD). The transaction stays
valid and the format is unchanged. Its motivation is spam: last epoch, nonce transactions were ~3.1%
of transactions but ~30% of priority-fee revenue, and **0.5% of nonce fee-payers (555 of 103,672)
drove 97.5% of nonce transactions**.

**Approval state matters more than `status: Idea` suggests:**

| Date | Event |
|---|---|
| 2026-08-20 | Anza (`bw-solana`) **APPROVED** and Firedancer (`ptaffet-jump`) **APPROVED** → "Ready to merge" |
| 2026-08-24 | `ptaffet-jump` **CHANGES_REQUESTED**: *"Although the design is still fine, after some additional discussion, we'd like to talk more internally about the goal of the SIMD."* |

Technically approved by both client teams, then held while Firedancer reconsiders whether they want
the goal at all.

**Why the default does not change.** The proposal's own Impact section addresses our case directly:

> *"Legitimate durable nonce users (e.g. custodians): mostly unaffected. The marginal priority fee in
> blocks is almost always 0 and ~94% of blocks are not full, so a priority-fee-0 transaction lands
> within a slot or two with very high probability."*

Vadum is exactly the user class the proposal sets out to protect, and it operates on a
seconds-to-hours settlement budget, not a slot budget. Losing the ability to bid costs us nothing
that D16 has not already given up — and after activation *nobody* can bid on the nonce path, so the
field levels. One clause is outright favourable: *"a fee-payer able to cover only the base fee is
valid after activation"*, which is our merchant precisely.

**Three things this changes:**

1. **The nonce-provider abstraction returns to v1.** `VadumInfo.md` §9 deliverable #1 promised it as
   a deprecation hedge; `20-ARCHITECTURE.md` dropped it without a decision record. 0571's
   *"durable nonces are expected to be deprecated and eventually removed"* is exactly the sentence
   that hedge exists for. It goes back into `packages/core` and Stream A's task list.
2. **The application addresses 0571 before a reviewer raises it.** It sits in the grantor's own
   repository. The paragraph writes itself: we read it, we are the legitimate-use class it protects,
   we designed the provider abstraction for the removal it anticipates, and we add a *payments*
   legitimate-use case to a primitive whose current legitimate base is custody.
3. **`21-SPEC` cites 0571, not SIMD-0242**, for the rule that a nonce value can never be a live
   blockhash. 0571 states the domain separation normatively and `ptaffet-jump` explicitly says
   *"SIMD-0242 is actually wrong, and this is the right definition"*. This upgrades the replay
   argument in `30-THREAT-MODEL.md` from a 2⁻²⁵⁶ collision claim to a structural one.

*Rules out:* making the fresh-blockhash path co-equal in v1 — it has no at-most-once guarantee and
promoting it would change the wire format and the threat model.

---

## D18 · Transaction message version is `0` — LOCKED

`createTransactionMessage({ version: 0 })`. Never `'legacy'`.

Nothing in the plan specified this and the two are not interchangeable:

| Version | Message bytes | First four bytes |
|---|---|---|
| `'legacy'` | 352 | `[2, 1, 4, 9]` |
| **`0`** | **354** | `[128, 2, 1, 4]` |

`'legacy'` is genuinely defensible — the design excludes Address Lookup Tables by construction — so a
coding session picking it would not be making an unreasonable choice. It would simply produce bytes
that match no fixture and no other stream. This is precisely the decision class `00-INDEX.md`
forbids reaching a coding session.

v0 is chosen because it is the current format and because the fixtures were generated against it.

---

## D19 · The transaction fee payer is `intent.feePayer` — LOCKED

Three sources disagreed. `22-SPEC-core-api.md` says `createNoopSigner(intent.feePayer)`; D14 says
`createNoopSigner(merchant)`; both reference builders hard-code
`setTransactionMessageFeePayer(merchant, m)`. With `FEE_PAYER_SEPARATE` set, the two readings compile
to the same 428-byte length but **different bytes** — `requiredSigs=3` with `[feePayer, merchant, payer]`
versus `requiredSigs=2` with `[feePayer, payer]`.

`verifyAuth` would then throw `SIG_INVALID` with nothing pointing at the cause: the same
lose-a-day failure mode as the SOL-14 trap.

**Normative:** the transaction fee payer, and the funder of
`createAssociatedTokenAccountIdempotent`, are both `createNoopSigner(intent.feePayer)`.
`intent.feePayer` equals `merchant` unless `FEE_PAYER_SEPARATE` is set. D14 and both experiment
scripts are corrected to match.

**Decoder MUST:** reject a payload where `feePayer == payer`. Nothing else prevents a merchant from
pushing the transaction fee and the ATA rent onto a payer the product promises holds zero SOL.

`FEE_PAYER_SEPARATE` (flag bit 3) **stays in v1** but only as a format reservation: the separate
fee-payer flow — who that third party is, how they are funded, how a three-signature transaction is
assembled — is **not designed and not implemented in v1**. Encoders MUST NOT set bit 3; decoders MUST
reject it with `WIRE_FEE_PAYER_SEPARATE_UNSUPPORTED`. This keeps the byte layout stable for a v1.1
relayer without shipping an untested three-party path.

---

## D20 · `NONCE_RETURN` is signed — LOCKED (OWNER)

> **D28 supersedes the signed range below.** The 100-byte layout, the decision to sign, and the rule
> that the payer verifies against the merchant recorded in its own ledger all stand. The signature no
> longer covers `bytes[0..36)`: it covers a reconstructed statement that also binds the payer and the
> prior nonce value, because `bytes[0..36)` alone replays to a different payer.

36 B → **100 B**. The unsigned design was justified only from the payer's side ("fails safe, risks no
funds"), which is true for the payer and false for a third party.

**The attack.** Anyone showing a 36-byte QR — the merchant who took the payment, or a bystander with
a phone — re-arms slot *i* in an honest payer's ledger with a chosen value. The payer later pays a
different merchant M2. M2 rebuilds, the signature verifies (it is over a message containing the bogus
value), M2 hands over goods, M2 submits, the chain rejects. **M2 loses the goods; the payer is
unharmed; the attacker needs no keys and no funds.** A worse variant: merchant M1 takes a payment on
slot 3, withholds submission, hands the payer a `NONCE_RETURN` freeing slot 3, lets the payer re-sign
it to M2, then submits — M1 gets paid, M2 does not.

**Layout** (full byte table in `21-SPEC-wire-format.md`):

| Offset | Size | Field |
|---|---|---|
| 0 | 3 | header (`version`, `type=0x04`, `flags` — **MUST be `0x00`**) |
| 3 | 1 | `nonceIndex` |
| 4 | 32 | `newNonceValue` |
| 36 | 64 | `signature` over `bytes[0..36)` by the merchant's fee-payer key |

**The merchant pubkey is not transmitted.** The payer knows from its own ledger which merchant that
slot was spent on and verifies against that key; a return signed by anyone else is rejected. That
saves 32 bytes *and* binds the return to the actual counterparty, which a transmitted pubkey would
not do.

100 B → 150 base45 chars → QR v6 at EC-M, v8 at EC-Q. Demo shot 8 is unaffected.

*Consequences:* new error code `NONCE_RETURN_UNTRUSTED`; a `nonce-return` fixture with a valid
signature and a negative case with a wrong signer; `42-STREAM-C-apps.md` C8 updated; threat T8 in
`30-THREAT-MODEL.md` recorded as mitigated.

---

## D21 · The nonce pool size is not a security bound — LOCKED

**Retracted claim.** `30-THREAT-MODEL.md` and `31-PARAMETERS.md` stated that N nonce accounts means
at most N concurrent offline payments *"enforced by Solana, regardless of what software the payer
runs"*, and called it "a genuine improvement on the forty-year-old EMV analogy". It was going into
the grant application as the answer to "your client-side limits are not binding". **It is false three
ways**, and both independent reviews found it separately:

1. **The attacker chooses N.** `createAddressWithSeed` accepts any ASCII seed ≤32 bytes. A hostile
   payer opens 100 accounts for 0.145 SOL and gets the rent **refunded** on close. Pool size is
   client-side configuration, unenforceable and invisible to the merchant.
2. **Even N=1 permits unbounded merchant loss.** One nonce value can sign an unbounded number of
   transactions to an unbounded number of merchants. All verify offline; one settles. N bounds what
   the payer can *spend*, never what merchants can collectively *lose*. `31-PARAMETERS.md`'s
   "5 × $5 = $25 exposure" was arithmetic on a bound that does not exist.
3. **The nonce account need not exist at all.** The merchant derives the address from `payer + index`
   and takes the value from the AUTH payload. Offline, nothing can check that the account exists, is
   initialised, has the payer as authority, or holds that value. **An attacker with zero SOL, zero
   tokens and no on-chain accounts signs arbitrarily many payments that pass `verifyAuth`
   perfectly.** Confirmed on devnet: `simulateTransaction` on exactly that payload returns
   `err: "BlockhashNotFound"`, `logs: []`, `unitsConsumed: 0` — never included in a block, so no fee
   and no trace. This is strictly cheaper than the multi-merchant double-spend the threat model
   spends its length on.

**Three artefacts actively concealed it**, which is what made this dangerous rather than merely
wrong: the fraud produces `SUBMIT_NONCE_REJECTED`, whose `42-STREAM-C-apps.md` C7 copy reads *"another
merchant settled this payment first — you were not charged"*; `23-SPEC-errors.md` wires
`LIMIT_FAILED_SENDS` to increment **only** on `SUBMIT_EXECUTION_FAILED`, so the one mitigation never
fires; and `51-DEMO-SCRIPT.md` planned to film that message as the honest-failure clip.

**What replaces it** (OWNER decision, 2026-08-29):

- **The accurate claim.** At most N of a given payer's offline payments can ever *settle*; merchant
  exposure is bounded by per-receipt caps, the queue cap and the number of merchants — not by N.
- **`SUBMIT_NONCE_REJECTED` splits in two.** `SUBMIT_NONCE_STALE` (account exists, value has moved —
  a genuine race, no fee, not the payer's fault) and `SUBMIT_NONCE_ABSENT` (account missing,
  uninitialised, or authority is not the payer — near-certain fraud). Different copy, and the
  failed-send counter increments on `SUBMIT_NONCE_ABSENT` as well as on `SUBMIT_EXECUTION_FAILED`.
- **A mandatory online pre-check in T0 and T1.** Before handing over goods, the merchant makes one
  `getAccountInfo` call on the derived nonce address and verifies: the account exists, state is
  `Initialized`, `authority == payer`, and `blockhash == the claimed nonceValue`. One RPC round trip,
  and it eliminates the attack entirely in the tiers where the merchant is online.
- **T2 keeps the residual risk, stated plainly.** A fully offline merchant cannot perform the check.
  This joins "offline balance verification is impossible without a light client" in the
  explicitly-not-solved list, bounded by the T2 caps.

---

## D22 · Mint-cache staleness follows mint mutability, not the clock — LOCKED

A flat 24-hour TTL on the mint compatibility cache, composed with "refuse to sign for a mint whose
record is stale" (`30-THREAT-MODEL.md`) and "an app that is not opened for weeks"
(`13-RESEARCH-pwa.md`), means **a payer can pay offline only within 24 hours of last being online**.
That deletes the disaster-zone, rural-vendor and both-parties-offline scenarios the project exists
for. The contradiction was unacknowledged and Stream C would have invented a policy for it.

**The rule:** staleness is a property of the mint, not of the calendar.

| Mint class | Example | Policy |
|---|---|---|
| No mutable authority over transfer behaviour — zero extensions, or extensions with null authorities | **USDC** (mainnet and devnet: legacy SPL Token, zero extensions) | **No expiry.** The verdict cannot change without a mint upgrade, which cannot happen silently |
| Authority-mutable — a live `transferHookAuthority`, `transferFeeConfigAuthority`, or `defaultAccountState` authority | **USDG**, **PYUSD** (all authorities at Paxos `2apBGMsS…`) | 24 h TTL. Past it: **warn and cap**, do not hard-block. Offline signing continues under the T2 cap with the staleness shown on the confirmation screen |

`MintRecord` gains `mutable: boolean` — derived by `evaluateMint` from whether any transfer-relevant
authority is non-null. `MINT_RECORD_STALE` becomes a warning for the mutable class rather than a
throw, and never applies to the immutable class.

---

## D23 · Risk parameters signed off — LOCKED (OWNER)

Every value in `31-PARAMETERS.md` is approved as written (2026-08-29), closing PROD-2, PROD-3 and
PROD-4:

N = 5 · T1 per-receipt cap 20 · T2 per-receipt cap 5 · T2 queue exposure cap 50 · failed-send
counter 3 · send window 24 h · payer biometric threshold 10 · pool low-water mark 2.

They ship as configuration, not constants.

**Two corrections carried into `31-PARAMETERS.md`:**

- **Caps are denominated in the mint's base units, not dollars.** An offline device has no price
  feed. v1 assumes a 1:1 USD-pegged mint with 6 decimals, so "20" means `20_000_000` base units, and
  the per-mint cap table lives in configuration. Behaviour for a non-pegged mint is undefined and
  said to be undefined.
- **The exposure arithmetic is rewritten** per D21 — N is not a bound on merchant loss.

---

---

## D24 · Two reference mints, for two different jobs — LOCKED

`PROD-9` said "devnet USDC"; `60-PHASE0-derisk.md` said "create an own mint". Both are right, for
different purposes, and the contradiction was that neither said which.

| Job | Mint | Why |
|---|---|---|
| Phase 0, golden fixtures, CI, integration tests, demo | **An own devnet mint** — 6 decimals, legacy SPL Token, no extensions, mint authority held by the test harness | We must be able to **mint tokens to the payer**. Devnet USDC's mint authority belongs to Circle, so we cannot fund a test payer without a rate-limited external faucet — and D15 forbids depending on one. Shape-identical to devnet and mainnet USDC, so nothing about the message changes |
| `assertMintCompatible` / `evaluateMint` test suite, and every claim in the docs | **Live devnet + mainnet USDC, USDG, PYUSD** — read only | Compatibility evaluation needs no tokens, only `getAccountInfo`. These are the real extension sets the product must judge correctly (`11-RESEARCH-tokens.md`) |

The compatibility suite must also include a **locally created mint with an active transfer hook**, to
prove the hard block actually fires (`50-INTEGRATION.md` test 7). That mint cannot be found on chain;
it has to be created.

*Consequence:* the fixture header records the mint address and states it is a throwaway devnet test
mint, so nobody mistakes fixtures generated against it for USDC-specific behaviour.

---

---

## D25 · Licence is Apache-2.0 — LOCKED (OWNER)

Closes OPS-3 and unblocks bootstrap.

Chosen over MIT for the **explicit patent grant**. This is a field with live commercial patents —
`VadumInfo.md` §8.2 names US 10810581 and 11842333 on offline payment systems — and an Apache-2.0
grant is what makes an institution comfortable building on the SDK. It is also the prevailing
licence across Solana ecosystem libraries.

`21-SPEC-wire-format.md` ships under the same licence for now. If the spec turns out to be the
project's most durable output (`ART-3`), relicensing it CC0 later is a one-line change that Apache-2.0
does not obstruct.

Repository: `github.com/tamerrarda/Vadum`, public from the first commit. (The plan wrote
`tamerarda/vadum`; the GitHub handle has two r's.) It was created private on 2026-09-11 and **went
public on 2026-09-12**, with GitHub's private vulnerability reporting enabled — the channel
`SECURITY.md` points at, which only a public repository can offer. `NOTICE`, `LICENSE` and a
`SECURITY.md` with a disclosure address are bootstrap deliverables.

---

## D26 · No sponsor in v1 — the payer funds their own nonce pool — LOCKED (OWNER)

Closes SPON-1, and it closes SOL-5b as a side effect.

**The attack it removes.** A sponsor funding `createAccountWithSeed` + `initializeNonceAccount(authority = payer)`
hands the payer an account the payer can immediately drain: `WithdrawNonceAccount` requires only the
nonce authority, and that must be the payer for offline advancing to work at all. The payer withdraws
5 × 0.00144768 SOL to any address, generates a fresh keypair, and repeats. **The sponsor is a free
faucet and there is no clean mitigation** — rate-limiting per identity does not help when identities
are free.

**What replaces it.** Pool setup is a one-time online step in which the payer funds their own rent:
**5 × one nonce account's rent, fully refundable** when the pool is closed — 0.0072 SOL when this was
written, about 0.0066 SOL on mainnet on 2026-09-11 (D39), plus the wallet floor at setup (D38).

**The onboarding ceremony collapses, which is a real simplification.** SOL-5b asked whether
`CreateAccountWithSeed` needs both the funder and the base account to sign when `base != from`. With
no sponsor, `from == base == payer`: **one signer, one signature, no two-party ceremony.** The UI is
a single online screen, and `ONB-1` shrinks from "design a co-signing protocol" to "build a pool
setup screen".

**The claim narrows, and must narrow in every document.** `VadumInfo.md` §3.4's *"alıcı hiç SOL
tutmuyor"* becomes:

> The payer needs no SOL **to pay**. Every transaction fee is paid by the merchant. The payer deposits
> a one-time, fully refundable rent deposit — about 0.0066 SOL on mainnet in September 2026 — when
> creating their nonce pool, and gets it
> back when they close it.

That is still a strong onboarding story and it is the true one. Presenting a sponsored pool as
"the payer never touches SOL" would have been a claim the SDK could not keep.

*Revisit in v2* alongside the time-locked vault, where the vault program can hold the rent and the
withdrawal path is program-controlled rather than authority-controlled.

---

## D27 · npm names reserved at bootstrap, real publish at v1 — LOCKED (OWNER)

Closes OPS-5. All four names were free on 2026-08-29: `vadum`, `@vadum/core`, `@vadum/wire`,
`@vadum/client`.

Bootstrap publishes `0.0.0` placeholders to hold the names, with a README pointing at the repository.
The CI release job is written and wired but not triggered until v1 is done, so half-finished packages
never reach a `latest` tag. Versions move together, matching D1's "pin them together, bump them
together" rule for the kit line.

---

## D28 · `NONCE_RETURN` signs a reconstructed statement bound to the payer and the prior value — LOCKED

Supersedes the signed range in D20. The 100-byte layout, the decision to sign, and verification
against the merchant recorded in the payer's own ledger are unchanged.

**The defect.** D20 signed `bytes[0..36)` — header, `nonceIndex`, `newNonceValue`. Neither the payer
nor the value the slot was spent against was covered, so every check in `21-SPEC` rule 12 passed for
a return issued to **someone else**:

- *Cross-payer.* Merchant M settles payer P1's slot 3 and shows the return. Payer P2 also spent slot
  3 at M. P2's ledger names M for slot 3, the signature verifies against M, and the value differs from
  P2's `spentAgainstValue` — so P2 re-arms slot 3 with **P1's** nonce value, signs a dead payment to
  the next merchant, and that merchant absorbs the loss in T2. With N = 5 and every pool starting at
  slot 0 this needs no attacker: the next customer at the till scanning the wrong screen is enough.
- *Stale cycle.* A return from an earlier spend of the same slot at the same merchant also passed, as
  long as its value differed from the current `spentAgainstValue`.

This is T8 again, reached by replay instead of forgery.

**The rule.** The 64-byte signature covers a statement both sides reconstruct and that never crosses
the air gap — the canonical-rebuild idea of D3 applied to the recovery payload:

| Field | Size | Merchant takes it from | Payer takes it from |
|---|---|---|---|
| domain tag, ASCII `vadum:nonce-return:v1` | 21 | constant | constant |
| `payer` | 32 | the settled `VerifiedPayment` | its own address |
| `nonceIndex` | 1 | `auth.nonceRef.index` | the payload |
| `spentAgainstValue` | 32 | `auth.nonceRef.value` | its own ledger |
| `newNonceValue` | 32 | `SubmitOutcome.newNonceValue` | the payload |

**118 bytes signed, 0 bytes added to the QR.** The domain tag separates this signature from every
other use of the merchant's fee-payer key and versions the statement.

*Consequences:* `22-SPEC` `signNonceReturn` / `verifyNonceReturn` take the statement fields;
`wire.decodeNonceReturn` becomes structural only (D30); `client` `Pool.applyNonceReturn` owns the
ledger lookup (D32); new negative fixtures `bad-nonce-return-other-payer` and
`bad-nonce-return-other-prior-value`; T8 in `30-THREAT-MODEL.md` records the replay variant.

---

## D29 · base45 whitespace: the rule stays, its rationale and two fixtures were wrong — LOCKED

`21-SPEC` transport MUST 2 said 2.2% of payloads begin with a space and that a single `.trim()`
corrupts about one payment in fifty. Both figures came from **random** 132-byte arrays. Measured
against the actual format — 200,000 real `AUTH` payloads, and by exhaustion over the encoder's
arithmetic:

| Property | Result |
|---|---|
| A base45 string ends with a space | **Never**, for any input. The last character of a 2-byte group is `floor(n/2025) ≤ 32`; of a 1-byte tail, `floor(b/45) ≤ 5`. Space is index 36 |
| A Vadum payload begins with a space | **Never.** The first group is `version, type`, so every payload starts `W50` (`INTENT`), `X50` (`STATIC_INTENT`), `Y50` (`AUTH`) or `Z50` (`NONCE_RETURN`) |
| A 132-byte `AUTH` contains a space | 94.4% |
| …contains two adjacent spaces | 3.1% — possible only inside one group: 32 of 65,536 group values, 64 free groups |

So `.trim()` is harmless to every v1 payload, and the mandatory fixtures `base45-leading-space` and
`bad-base45-trimmed` were **impossible to generate** — a generator author would loop forever or
quietly invent a substitute, which is a design decision reaching a coding session.

**What stays:** never trim, never normalise, never embed in a URL. It costs nothing, and a future
version byte could change the prefix.

**What changes:** the live hazard is normalisation of *interior* whitespace — collapsing runs,
substituting a non-breaking space, line-wrapping in a log or copy path. The fixtures become
`base45-double-space` (positive) and `bad-base45-whitespace-collapsed` (negative), and the fixture CI
asserts both properties above so the analysis cannot silently rot.

---

## D30 · Receive rules are assigned to a layer, and the codec checks in a fixed order — LOCKED

`21-SPEC`'s thirteen "decoder rules" read as if one function applied all of them. Four cannot live
in the codec under the frozen APIs. The order of checks was unspecified, so a payload breaking two
rules had two correct errors — and `bad-static-fee-payer-separate` in `24-SPEC` contradicted
`21-SPEC`'s own precedence sentence. And one mandatory mitigation had no enforcement point at all.

| Rule | Needs | Enforced by |
|---|---|---|
| 1–6, 8, 10, 11 | the bytes, the caller's mint cache, the answered intent's flags | `wire` |
| 7 — verify against a rebuilt message | `buildMessage` | `core.verifyAuth` |
| 9 — `feePayer ≠ payer` | the intent **and** the `AUTH`; `decodeAuth` receives only the intent's flags | `core.verifyAuth` (merchant) and `core.signAsPayer` (payer refuses an intent naming itself) |
| 12 — `NONCE_RETURN` signature | a signature check and the payer's ledger; `wire` imports only types from `core` | `client` `Pool.applyNonceReturn` → `core.verifyNonceReturn` |
| 13 — dedupe | queue state | `client/queue.ts` |

**Check order**, normative for every codec entry point — structural first, flag legality before
length (length is defined only for legal flags), caller context last:

1. base45 alphabet, length, group range → `WIRE_BASE45_INVALID`
2. fewer than 3 bytes → `WIRE_LENGTH_MISMATCH`
3. version → `WIRE_VERSION_UNSUPPORTED`
4. type unknown → `WIRE_UNKNOWN_TYPE`; known but not this decoder's → `WIRE_UNEXPECTED_TYPE` (new)
5. reserved bits 5–7 → `WIRE_RESERVED_FLAG_SET`
6. bit 3 → `WIRE_FEE_PAYER_SEPARATE_UNSUPPORTED`
7. a flag not allowed for the type → `WIRE_FLAG_NOT_ALLOWED_FOR_TYPE`
8. static constraints → `WIRE_STATIC_CONSTRAINT`
9. exact length for `(type, flags)` → `WIRE_LENGTH_MISMATCH`
10. `AUTH` flags against the answered intent → `WIRE_FLAGS_MISMATCH`
11. mint cached → `MINT_UNKNOWN`; decimals → `MINT_DECIMALS_MISMATCH`; token program →
    `MINT_TOKEN_PROGRAM_MISMATCH` (new)

*Consequences:*

- `wire.decodeNonceReturn` is synchronous and structural; `DecodeContext.ledgerSlot` is removed.
  `wire.peekPayloadType` routes a scanned QR before a typed decoder is chosen.
- Under step 6, `STATIC_INTENT` with bit 3 raises `WIRE_FEE_PAYER_SEPARATE_UNSUPPORTED` in v1; the
  `WIRE_FLAG_NOT_ALLOWED_FOR_TYPE` row for that combination becomes reachable only once bit 3 is
  supported. `24-SPEC` is corrected.
- **Rule 5 also checks the `TOKEN_2022` flag against the cached record.** `21-SPEC` called bit 2 safe
  because an unknown mint is rejected, which covered only unknown mints: a known mint with a false
  flag makes the payer derive the wrong ATAs, the merchant's rebuild uses the same false flag and
  verifies, and the payment dies at execution — charging the merchant a fee and burning the payer's
  slot.
- Error codes keep their names; `23-SPEC` states the raising layer wherever it is not the prefix's
  package. A static-mode `verifyAuth` without `expectedAmount` throws `CANON_AMOUNT_MISMATCH` instead
  of leaving the omission undefined.
- **T1's pre-check is enforced by `client/queue.ts`, not by app discipline.** `Queue.accept` takes the
  `NonceVerdict` and throws the new `LIMIT_PRECHECK_REQUIRED` for a T1 nonce-path acceptance without
  an `ok` verdict. D21 made the pre-check mandatory; leaving the merchant app to remember it was the
  same "the mitigation never fires" failure D21 was written about. `precheckNonce` on a fresh-path
  payment throws `INTERNAL_NOT_APPLICABLE`.

---

## D31 · `AUTH` dedupe keys cover both lifetime paths and are never pruned in v1 — LOCKED

Rule 13 keyed on `(payer, nonceIndex, nonceValue)` and applied "while that key is live in the queue".
Two gaps:

1. **After settlement the key stopped being live**, so a payer could re-show an already-settled `AUTH`
   to an offline merchant: it verifies, passes dedupe, and dies on chain. The merchant had already
   recorded that payment — it only has to remember it.
2. **The fresh path has no nonce**, so the key was undefined on the one path with no at-most-once
   guarantee at all.

| Path | Dedupe key | Why this key |
|---|---|---|
| durable nonce | `nonce:${payer}:${nonceIndex}:${nonceValue}` | Broader than the message: it also rejects a *different* amount signed against the same slot and value, which is a double-spend attempt against this merchant |
| fresh blockhash | `fresh:${payer}:${base58(sha256(messageBytes))}` | Keyed on the message, not the signature — Safari's Ed25519 is non-deterministic, so one message can arrive with two different valid payer signatures |

Keys are checked against **every** payment the queue has accepted, in any state — `queued`,
`submitting`, `settled`, `failed`, `voided` — and v1 never prunes them. A key is under 100 bytes; ten
thousand payments is under a megabyte. `QueuedPayment.id` is this key.

---

## D32 · Payer slot state has one owner, and online reconciliation re-arms settled slots — LOCKED

Two gaps between `23-SPEC` and `26-SPEC` that Streams B and C would each have filled differently:

1. **Nothing could mark a slot spent.** `23-SPEC` requires the payer to mark a slot spent at signing
   time, and `26-SPEC`'s `Pool` exposed `slots[].state` and `spentAgainst` — but had no method that
   set either, while `42-STREAM-C-apps.md` C3 built a separate spent-slot ledger. Two state machines for one
   fact.
2. **Settled slots never came back.** `23-SPEC` reconciliation step 2 said *"record the new value,
   keep the slot spent"*. Read literally, an honest payer's pool shrinks by one slot per payment until
   a `NONCE_RETURN` arrives or the pool is closed and recreated.

**The rule.**

- `client/pool.ts` is the **single owner** of slot state, persisted through `KeyValueStore`. It gains
  `reserveSlot(merchant, now)` — picks the lowest-index unspent slot, records `spentAgainst`, and
  **persists before resolving**; the payer app calls `signAsPayer` only after it resolves — and
  `applyNonceReturn(payload)`, which looks up the slot record, calls `core.verifyNonceReturn`, and
  re-arms the slot only on success.
- Stream C owns **durability**, not state: the IndexedDB `KeyValueStore`, the `localStorage` mirror,
  the pool epoch marker, RECOVERY detection, and the standalone-mode gate.
- **Reconciliation re-arms settled slots.** If the on-chain value differs from `spentAgainstValue`,
  every transaction signed against the old value is dead, so the slot returns to `unspent` holding the
  new value; `reconcile().settled` lists them. `refresh()` reads values and never changes slot state.

---

## D33 · Stream 0 — bootstrap, the fixture generator and Phase 0 have an owner — LOCKED

Three prerequisites for parallel work had no task and no owner: the repository bootstrap
(`20-ARCHITECTURE.md`, "before streams start"), the fixture generator (`24-SPEC`, "before streams
start, needs no chain"), and a Phase 0 script that matches `60-PHASE0-derisk.md` — the existing one
uses a sponsor, the blockhash confirmer, and a replay assertion that cannot fail (D35).

All three go to **one sequential session, Stream 0**, which runs before A, B and C branch. Its task
list is `39-STREAM-0-bootstrap.md`.

Two properties are load-bearing:

- **The generator is an independent reference implementation.** `packages/fixtures` depends on
  `@solana/kit`, the program packages and `qrcode` directly, and **never on `@vadum/*`**. Fixtures
  produced by the code they test prove nothing.
- **Phase 0 gates spec freeze and Streams A/B/C (G0), not Stream 0.** The generator needs no chain, so
  it runs alongside Phase 0; if Phase 0 fails, the fixtures are discarded along with the design.

Fixture-backed fakes of `core`, `wire` and `client` for the apps are Stream C's own test doubles
(`42-STREAM-C-apps.md` C0.5), not a Stream 0 deliverable.

Owner prerequisites are tracked as `OPS-6` in `02-OPEN-QUESTIONS.md`: Node ≥ 24 on the build machine
(the local toolchain was 22.18 on 2026-09-11 — D1), the repository initialised (D25), and a
devnet-funded key for Phase 0 (D15).

---

## D34 · Core API signatures corrected against the kit 8.0.0 type definitions — LOCKED

Checked against the published `.d.ts` files of `@solana/kit@8.0.0`, `@solana/addresses@8.0.0`,
`@solana/transaction-messages@8.0.0`, `@solana/transactions@8.0.0` and `@solana/rpc-types@8.0.0`.
Four frozen signatures would not have compiled as written or contradicted their own prose, and
Stream A would have had to change a frozen interface on its first day.

| Was | Problem | Now |
|---|---|---|
| `NonceProvider.applyLifetime<T>(msg: T, input): T` | Synchronous, but the nonce account address comes from `createAddressWithSeed`, which returns `Promise<Address>`. And kit's lifetime setters return a transformed type — the durable-nonce one prepends an instruction — not `T` | `applyLifetime(msg: TransactionMessage & TransactionMessageWithFeePayer, input): Promise<TransactionMessage & TransactionMessageWithFeePayer & TransactionMessageWithLifetime>` |
| `evaluateMint(raw)` | The spec says `checkedAt` is received "as an argument" and `core` reads no clock — but there was no argument | `evaluateMint(raw, checkedAt)` |
| Stubs throw `VadumError('NOT_IMPLEMENTED')` | Not in the taxonomy and outside every `VadumErrorCode` prefix, so A0's stubs fail A1's exhaustiveness test | `INTERNAL_NOT_IMPLEMENTED`; CI fails G1 if it survives in `packages/core/src` |
| Nonce values and blockhashes typed `Address` | kit brands them `Nonce` (`@solana/transaction-messages`) and `Blockhash` (`@solana/rpc-types`); `setTransactionMessageLifetimeUsingDurableNonce` requires a `Nonce` | `NonceRef.value` and every `spentAgainstValue`, `newNonceValue`, `onChainValue`: `Nonce`. `Lifetime.fresh.blockhash`: `Blockhash`. The single conversion from `fetchNonce`'s `Address`-typed field lives in `client/rpc.ts` |

The last row is not cosmetic. An address passed where a nonce value belongs compiles silently and
fails at settlement, which is the failure class this project is built to avoid; the brand makes it a
type error.

---

## D35 · Phase 0's at-most-once assertion signs a different message — LOCKED

`60-PHASE0-derisk.md` called ASSERT B "the whole point": *re-submitting the identical transaction is
rejected*. That assertion **cannot fail**. An identical transaction would be rejected even if nonces
gave no protection at all — duplicate detection alone rejects it, exactly as it rejects a
fresh-blockhash transaction resubmitted inside its window. Passing it cannot distinguish a working
at-most-once guarantee from a broken one, and the property the threat model rests on is different:
*of several **different** transactions signed against one nonce value, at most one lands.*

**The assertion.** While offline, the payer signs two different payments against the same nonce value
(different amounts). Both verify offline. Payment 1 is submitted and lands (ASSERT A). Payment 2 is
then submitted and must be rejected at validation, with the merchant's SOL balance unchanged and the
nonce account's value unchanged by it (ASSERT B). The identical-replay check stays in the log as a
control, labelled as one.

Phase 0 also observes on chain two things the error taxonomy currently takes from documentation: an
**execution failure** charges the fee payer and advances the nonce (`SUBMIT_EXECUTION_FAILED`, SOL-7 —
the failed-send counter depends on it), and a **fabricated nonce** is rejected at no cost with an
absent account (`SUBMIT_NONCE_ABSENT`, D21).

---

## D36 · QR payloads are rendered as one explicit alphanumeric segment — LOCKED

Found by Stream 0 while generating the fixtures. `qrcode@1.5.4` segments a string automatically, and a
real nonce-path `INTENT` always contains a digit run: the high bytes of a u64 amount are zero, zero
bytes encode to `000`, and the encoder turns the run into a numeric segment. Measured over 2,000
payloads of each shape, at EC-M and EC-Q:

| Payload | Automatic segmentation mixes modes | QR version differs from one alphanumeric segment |
|---|---|---|
| `INTENT` nonce, 76 B | **100%** | 0 of 4,000 encodings |
| `AUTH` static, 140 B | 0.1% | 0 of 4,000 |
| every other type | 0% | 0 of 4,000 |

Automatic segmentation has not changed a version at these sizes — but nothing guarantees it, it makes
`QrRender.segmentMode` report something other than `alphanumeric` for every dynamic intent, and
`21-SPEC`'s statement that every payload encodes as one alphanumeric segment held only for the random
payloads it had been measured on.

**The rule.** `wire.renderQr` encodes the base45 string as a single explicit alphanumeric segment —
`QRCode.create([{ data, mode: 'alphanumeric' }], …)` — never as a bare string. The QR version is then a
function of payload length and EC level alone, the `21-SPEC` size table is exact by construction, and
`segmentMode` is `alphanumeric` for every payload. The fixture generator does the same.

---

## D37 · base45 rejects a 2-character tail above 0xFF — LOCKED

Found by Stream 0. `25-SPEC` listed three conditions for `WIRE_BASE45_INVALID`: a character outside the
alphabet, a length where `len % 3 == 1`, and a 3-character group above `0xFFFF`. It missed the fourth.
A 2-character tail encodes a single byte, so its value is at most 255 — but `::` decodes to 2,024. A
decoder that does not check it truncates silently and produces a wrong final byte, the failure class D12
exists to prevent.

The rule joins receive rule 11 and check-order step 1, and the new negative fixture
`bad-base45-tail-overflow` (`000::`) tests it. The codec negative suite is now twenty-one cases, and the
full negative set thirty-three.

---

## D38 · Pool setup leaves the payer's wallet at zero or rent-exempt — LOCKED

Found by Phase 0 on devnet, 2026-09-11. The first run funded the payer with exactly the pool's rent plus
a fee buffer, so the setup transaction would have left 5,000 lamports in the wallet. Simulation rejected
it: *"Transaction results in an account (0) with insufficient funds for rent"*. A system account must end
every transaction holding either zero lamports or at least its rent-exempt minimum; whatever SIMD-0392
relaxes, it did not relax this case.

`26-SPEC`'s `estimateSetupCost` returned `N × nonce rent` and called it the cost. A payer following it
fails exactly as the script did, and nothing specified which error to raise.

**The rule.**

- `Pool.estimateSetupCost(size)` returns its three parts, each read at call time (D7): the nonce rent for
  `size` slots, the setup fee, and the wallet's own rent-exempt minimum
  (`getMinimumBalanceForRentExemption(0)`).
- `Pool.create` checks the wallet before sending. It proceeds when the balance is exactly rent + fee (the
  wallet ends at zero) or at least rent + fee + the wallet minimum; otherwise it throws the new
  `NONCE_POOL_UNDERFUNDED`, with `detail` carrying the three parts and the shortfall.
- The onboarding screen (`42-STREAM-C-apps.md` C0) asks for the full total, not the rent alone.
- **Closing the pool is the same trap one transaction later.** The fee payer must still be rent-exempt
  *after* its fee is deducted, and the lamports the withdrawal credits in that same transaction do not
  count toward it. A payer left by `create` at exactly `getMinimumBalanceForRentExemption(0)` therefore
  cannot close its own pool: devnet refused it on 2026-09-12 with the same message, during the Stream B
  verification run. `Pool.close` checks the balance first and raises `NONCE_POOL_UNDERFUNDED` with that
  reason rather than letting the chain refuse it, and a payer app that intends to close later funds
  `walletMinimum + fee`.

The second run funded the wallet minimum as well, and step 2 passed with one signature (D26).

---

## D39 · Rent is falling on the live clusters; rent figures in the plan are dated, not constants — LOCKED

Found by Stream 0 on 2026-09-11 while diagnosing D38. `getMinimumBalanceForRentExemption(80)`, the rent
of one nonce account:

| Cluster | 2026-08-27 (SOL-9) | **2026-09-11** | `lamports_per_byte_year` | SIMD-0437 tier |
|---|---|---|---|---|
| mainnet-beta | 1,447,680 | **1,317,264** | 6,333 | first |
| devnet | 1,447,680 | **1,056,640** | 5,080 | second |

Both public endpoints reported `solana-core 4.3.0-rc.0`. The SIMD-0437 file in the repository still
reads `status: Idea` with no feature key and was last changed on 2026-02-13 — **yet its schedule is
visibly in effect.**

Two earlier corrections were therefore right about what they measured and wrong about what followed: D7's
"no tier has activated on any cluster" and `03-VADUMINFO-ERRATA.md` E1 were true on 2026-08-29 and are
false now. `VadumInfo.md`'s *"ilk kademe aktive edildi"* is true of mainnet today; its *"kabul edildi"*
still has no source in the SIMD file.

**The rule.**

- D7 stands and is now load-bearing: rent is read at call time, everywhere, never hardcoded.
- Every rent figure in the plan carries a cluster and a date. The N = 5 pool deposit is quoted as *"about
  0.0066 SOL on mainnet in September 2026, falling as SIMD-0437's tiers activate"*, not as 0.0072 SOL.
- Arithmetic written with 0.00144768 SOL — D21's "100 accounts for 0.145 SOL", D26's sponsor faucet — is
  historical and left as written; none of those conclusions depends on the exact rent.

---

## Provisional — needs a measurement before locking

| ID | Decision | Confirm by |
|---|---|---|
| D13 | Demo device pair. Leaning **two Android phones** for the native scanner path, with iOS proven separately | Stream C, before filming |

D11 and D12 were on this list and are now **locked above**. Neither was genuinely waiting on a
measurement — D11's cost was already measured and its benefit follows from the deployment
environment, and D12 turned out to be a correctness question, not a supply-chain preference. Leaving
a decision "provisional" because nobody wanted to make it is the failure mode `00-INDEX.md` warns
about; D13 is the only entry that survives it, and it depends on which handsets are physically
available.

---

## Still owed before spec freeze

The three decisions previously listed here — licence, sponsor, npm publishing — were closed by D25,
D26 and D27. **No design decision blocks spec freeze.** D13 is provisional by nature and blocks only
filming.

**Phase 0 passed on devnet on 2026-09-11** (`plan/references/phase0-log.md`), and OPS-6 is closed. Nothing
left blocks spec freeze; tagging it (Stream 0 task 0.6) is the owner's call. Still open and non-blocking,
all tracked in `02-OPEN-QUESTIONS.md`:

| ID | What | Blocks |
|---|---|---|
| WIRE-6 | `32-MEASUREMENT-METHOD.md` written | Stream B's B5 and any measurement data — not spec freeze |
| ~~OPS-7~~ | ✅ Closed 2026-09-12 — the repository is public, and private vulnerability reporting is enabled | — |
| NONCE-9 | Releasing an abandoned slot by self-advancing the nonce | Nothing in v1 |
