# Threat model

Consolidates `VadumInfo.md` §5 and adds what the research turned up. The document's instinct is
right and should be kept: **if we write the risk, we look competent; if the reviewer finds it, the
project dies.**

Two of the original threats are now **structurally eliminated** rather than mitigated. That is worth
stating loudly, because it is a design result, not a promise.

---

## Eliminated by design

### Malicious merchant instruction injection (`VadumInfo.md` §5.7) — GONE

The document worries that a merchant could embed `Approve`, `SetAuthority`, `CloseAccount` or a
second transfer into QR#1, and proposes a strict whitelist as defence.

**With canonical rebuild there is no attack surface to whitelist.** The payer never receives a
transaction. It receives an intent — merchant, mint, amount, decimals — and **builds the message
itself**. There is nowhere to hide an instruction.

The whitelist (`assertCanonical`) still ships, as defence in depth over the payer's *own* output. But
the answer to a reviewer is structural: *no side ever signs or accepts a message it did not build.*

### Transaction replay — GONE on the durable-nonce path

One nonce value, one transaction.

**The qualifier matters and was missing.** At-most-once is a property of the *durable-nonce* path
only. The fresh-blockhash path (D4, opt-in) has **no such guarantee** — two transactions can be
signed against the same fresh blockhash and, if the balance covers both, **both land**.
`VadumInfo.md` §3.5 states this correctly; the earlier draft of this document dropped the
qualifier, and this document is the one that gets quoted.

**The supporting argument is now structural rather than probabilistic.** An earlier draft argued
that a blockhash can never be a valid nonce value because a collision is vanishingly unlikely — a
2⁻²⁵⁶ argument. **SIMD-0571 states the domain separation normatively**, as the basis for its
classification rule:

> *"Because durable nonce values are domain-separated from blockhashes (a stored nonce value can
> never equal a live blockhash), the two cases are mutually exclusive for any signed transaction."*

That is protocol text, not a probability estimate. There is also a second, independent separation:
the two paths compile to **different message lengths** (354 B vs 248 B in the measured case), so a
signature over one can never verify against the other regardless of hash values.

Cite SIMD-0571 for this, **not SIMD-0242** — 0571's author was explicitly told by Firedancer's
reviewer that *"SIMD-0242 is actually wrong, and this is the right definition"*.

---

## Live risks

### T1 · Multi-merchant double-spend (`VadumInfo.md` §5.2)

Unchanged and unsolved. N nonce accounts means N simultaneously valid payments to N merchants; one
lands, the rest fail; the losers gave up goods. Client-side honesty does not bind an attacker who
writes their own signer.

**A claim that was here has been retracted.** An earlier revision said:

> ~~EMV limits consecutive offline transactions with a counter inside the card's own software, which
> a capable attacker can bypass. Vadum's equivalent is the nonce pool size, and it is **enforced by
> Solana**. N nonce accounts means at most N concurrent offline payments regardless of what software
> the payer runs.~~

**This was false, and it was the sentence intended for the grant application.** Full reasoning is in
`01-DECISIONS.md` D21; the short version is three independent failures: the attacker chooses N
(seeds are free and rent is refundable); even N=1 lets one nonce value sign unlimited payments to
unlimited merchants; and the nonce account need not exist at all (T6 below).

**The accurate claim, which is still worth stating:**

> At most N of a given payer's offline payments can ever **settle** — that part is enforced by
> Solana. What is *not* bounded is how many merchants can be shown a valid-looking payment in the
> meantime. Merchant exposure is bounded by per-receipt caps, the queue cap, and, in the tiers where
> the merchant is online, by a one-RPC nonce pre-check.

**Bounded by:** per-receipt caps and queue exposure cap (`31-PARAMETERS.md`), and decisively by tier
— see T0 below.

**And, decisively:** in tier T0 — merchant online, waits ~1 s for confirmation — the risk is **zero**.
T0 is the primary scenario. The entire double-spend discussion is about T1 and T2, which are opt-in.

### T2 · Merchant fee drain — NEW

A payer signs against an underfunded token account. The transaction passes validation, fails at
execution, **the nonce advances and the merchant pays the fee** (SOL-7). 10,000 lamports for a
two-signature payment — 5,000 per signature, observed on devnet in Phase 0 — but repeatable.

**Mitigation:** consecutive failed-send counter (`31-PARAMETERS.md`, default 3), and in T0/T1 the
online merchant can check the payer's balance before handing over goods.

**Note the asymmetry, it is in our favour:** a merchant who *loses* a double-spend race pays nothing
— that failure is a validation rejection, which is free.

### T3 · Merchant grief

A merchant takes a signed payment and never submits it. No funds are lost, but the payer marks the
slot spent at signature time (fail-safe, `23-SPEC-errors.md`) and their offline capacity drains. With
pool size N, N griefs lock the payer out until they reconnect.

**Mitigation:** the `NONCE_DESYNC` reconciliation procedure in `23-SPEC-errors.md` — on the next
online session, a slot whose on-chain value is unchanged past the send window is presumed abandoned
and released, and a slot whose value has moved is re-armed (D32). Plus a payer-side warning on
unfamiliar merchants.

An earlier draft said full mitigation was "payment cancellation by self-advancing the nonce,
deferred to v2". See **T7**: that capability is not deferred, because it was never ours to defer.

### T4 · Local ledger loss — real, but not for the reason this document gave

A payer whose spent-slot ledger is gone signs against already-spent nonces, producing dead
transactions while merchants believe they were paid. The **RECOVERY** design is right and stays.

**The premise behind it was wrong, and it was ranked "the most likely failure in practice" on that
basis.** An earlier revision asserted that iOS clears script-writable storage after 7 days of disuse,
that PWA storage is cleared after weeks, and that `navigator.storage.persist()` requires notification
permission to take effect. All three are wrong for the case that matters:

> WebKit, *CNAME Cloaking and Bounce Tracking Defense* (2020-11-12): *"we have implemented an
> **explicit exception for the first-party domain of home screen web applications** to make sure ITP
> always skips that domain in its website data removal algorithm."*

Still standing policy, and unconditional in current WebKit source. Two further corrections: the
"7 days" counter is **operating dates** — days Safari actually ran — not calendar days; and
`persist()` is granted through that same exemption set, automatically for a home-screen app and never
for a Safari tab. **No prompt, no notification permission, no UI.**

An installed PWA — which the payer app is by definition — is exempt. The eviction the document
described as routine does not happen to it.

**What is actually live**, and what the RECOVERY state must be justified by:

| Cause | Reality |
|---|---|
| Used as a **Safari tab**, not installed | Not exempt. ITP applies fully — this is the real iOS exposure |
| Reinstall, or the user clearing site data | Ledger gone, and no platform prevents it |
| New device | The ledger does not travel |
| Android storage pressure | Chrome evicts under pressure without the iOS-style exemption |
| Genuine crash mid-write | The mirror exists for this |

**Mitigation:** RECOVERY state — offline signing is *blocked* until one online session restores pool
state (`13-RESEARCH-pwa.md`, Stream C task C3). Fail safe, never silent. **Plus a standalone-mode
check**: if the app is running in a browser tab rather than as an installed app, offline signing is
disabled and the user is asked to install first. That is the correct control, and it replaces the
notification-permission prompt `42-STREAM-C-apps.md` C3 previously mandated — a real permission prompt, on
a payments wallet, buying nothing.

### T5 · QR substitution (`VadumInfo.md` §5.8)

Unchanged. An offline payer cannot verify that the address on a sticker belongs to that merchant.
Same fraud as sticker-swapping on Chinese and Indian QR rails.

**Mitigation:** remembered merchants, warn on first payment to a new one. **Worse in static mode**
(D6) — a printed sticker is exactly what gets covered over. Say so in the docs rather than hoping
nobody notices.

Kit's `OffchainMessageEnvelope` API is the clean path to signed merchant identity in v2.

### T6 · Fabricated nonce — the cheapest attack in the system, and it was not in this document

An attacker needs **no SOL, no tokens, and no on-chain accounts at all**.

`verifyAuth` is pure and performs no I/O. No decoder rule requires the nonce account to exist. So a
throwaway keypair plus an invented 32-byte `nonceValue` produces an `AUTH` that passes offline
verification **perfectly** — correct signature over a correctly rebuilt message — and dies on chain.
Verified on devnet: `simulateTransaction` on exactly that payload returns `err: "BlockhashNotFound"`,
`logs: []`, `unitsConsumed: 0`. It is never included in a block, so there is **no fee and no trace**.

This is strictly cheaper than the multi-merchant double-spend in T1, which at least requires funding
a real account and creating real nonce accounts.

**Three artefacts were concealing it**, which is what made it dangerous rather than merely missing:

1. The fraud produced `SUBMIT_NONCE_REJECTED`, whose merchant copy read *"another merchant settled
   this payment first — you were not charged."* **The UI reassured the defrauded merchant.**
2. `LIMIT_FAILED_SENDS` incremented only on `SUBMIT_EXECUTION_FAILED`, so the one mitigation never
   fired for this attack.
3. `51-DEMO-SCRIPT.md` planned to film that message as the project's honest-failure clip.

**Mitigations (D21):**

- `SUBMIT_NONCE_REJECTED` splits into `SUBMIT_NONCE_STALE` (real race, no counter) and
  `SUBMIT_NONCE_ABSENT` (near-certain fraud, increments the counter), with different copy.
- **A mandatory online pre-check in T0 and T1** — one `getAccountInfo` on the derived nonce address,
  verifying existence, `Initialized` state, `authority == payer`, and `value == claimed`. Performed
  **before handover**, which is what actually prevents the loss. `client/queue.ts` refuses a T1
  acceptance without a passing verdict, so no app can forget it (D30).
- **T2 cannot perform it.** A fully offline merchant has no way to check, so in T2 this attack is
  unmitigated and bounded only by the T2 caps. That belongs in the not-solved list below.

### T7 · The payer can void every queued payment, for free, at any time

`AdvanceNonceAccount` and `WithdrawNonceAccount` require only the **nonce authority** — which is the
payer, necessarily, because offline advancing is the whole mechanism. A payer therefore signs N
payments, comes online, and self-advances or closes every nonce account. Every queued payment dies at
validation. **Cost: zero, with the rent refunded.**

`01-DECISIONS.md` D6 filed "payment cancellation by self-advancing the nonce" as a **v2 feature**.
Deferring the feature does not defer the capability: it exists today whether or not we ship a button
for it, and it is strictly cheaper and more reliable for an attacker than the multi-merchant race
this document previously concentrated on.

**Consequence:** the send window and the pool size bound **honest failure only**. Neither binds an
attacker. Say so wherever they are described as risk controls.

**Mitigation:** none at the protocol level in v1. Merchants who need certainty use T0 and wait ~1
second for confirmation, which closes this and T1 and T6 simultaneously. The v2 time-locked vault
(`VadumInfo.md` §11) is the structural answer, because the withdrawal path becomes
program-controlled rather than authority-controlled.

### T8 · Poisoned `NONCE_RETURN` — MITIGATED by D20

Recorded because the reasoning is instructive, not because it remains live.

The recovery payload was **unsigned**, justified as failing safe: *"a wrong value makes the payer's
next transaction fail validation, which costs nothing and risks no funds."* True for the payer, and
the payer is the wrong party to reason about.

Anyone showing a 36-byte QR re-armed slot *i* in an honest payer's ledger with a chosen value. The
payer then paid a **different** merchant M2, whose offline verification passed, who handed over
goods, and whose submission was rejected. **M2 absorbed the loss; the attacker needed no keys and no
funds.** A sharper variant needed no third party: M1 takes a payment on slot 3, withholds
submission, hands the payer a return freeing slot 3, waits for the payer to re-sign it to M2, then
submits.

**Mitigated (D20):** the payload is signed by the merchant's fee-payer key, and the payer verifies
against the merchant recorded **in its own ledger** for that slot. 36 B → 100 B, QR v6 at EC-M.
Forging one now requires that specific merchant's private key.

**Replay variant — found 2026-09-11, mitigated by D28.** Signing only the payload bytes left the
signature unbound to the payer and to the slot's prior value. A genuine return for payer P1's slot 3
therefore re-armed slot 3 for any other payer who had spent it at the same merchant, and an old return
replayed in a later cycle — with N = 5 and every pool starting at slot 0, without any attacker at all.
The signature now covers a reconstructed statement (domain tag, payer, index, prior value, new value)
that the payer rebuilds from its own address and ledger. Zero extra QR bytes.

**The general lesson, worth keeping:** "fails safe" must name *which party* it fails safe for. Every
remaining "this is harmless" claim in this document has been re-read with that question in mind.

### T9 · Sponsor rent theft — REMOVED by D26

A sponsored nonce pool was a free faucet. The sponsor funds `createAccountWithSeed` +
`initializeNonceAccount(authority = payer)`; the payer then calls `WithdrawNonceAccount` — which needs
only the nonce authority — sends the rent anywhere, generates a fresh keypair, and repeats. There is
no clean mitigation, because the payer *must* be the authority for offline advancing to work, and
rate-limiting per identity is meaningless when identities are free.

**Removed by scope (D26): there is no sponsor in v1.** The payer funds their own refundable rent
(about 0.0066 SOL for N=5 on mainnet in September 2026, D39). The claim narrows honestly — the payer needs no SOL **to pay**, and makes a
one-time refundable deposit to create the pool.

### T10 · Privacy — the payment QR is a linkable identity

The `AUTH` payload carries the payer's **raw public key**, and the seed scheme `vadum-0` … `vadum-255`
makes the payer's entire nonce pool enumerable by anyone who holds it.

Consequences: a merchant — or a bystander who photographs the screen — can link the payer to their
complete on-chain history, and can read how much offline capacity the payer has left by checking
which slots are still unspent. The second is a targeting signal, not just a privacy leak.

This is not worse than a Solana Pay transfer, which also reveals the payer's address. It is worse
than cash, which is the thing being replaced, and the README should not imply otherwise.

**Mitigation:** none in v1. Documented, not solved. A per-merchant derived identity would require
either an on-chain program or abandoning the derived-nonce-address trick that saves 32 QR bytes.

### T11 · Mint authority mutation

USDG and PYUSD carry `transferHook` and `transferFeeConfig` extensions that are **currently inert**
(`programId: null`, 0 bps) but whose authorities are live Paxos-controlled addresses
(`11-RESEARCH-tokens.md`). Either can be switched on without warning, at which point offline
construction silently produces wrong transactions.

**Mitigation:** `assertMintCompatible` re-validates on every online session. An offline payer refuses
to sign for a mint whose record is **absent**. A **stale** record follows D22: for an authority-mutable
mint such as USDG or PYUSD, signing past the 24 h TTL continues under the T2 cap with the staleness
shown; an immutable mint such as USDC never goes stale. An earlier revision refused stale records
outright, which would have limited offline payment to 24 hours after last being online.

Both mints also carry `permanentDelegate` — the issuer can move funds after settlement. Not our
threat, but it belongs in the docs.

---

---

## Explicitly not solved

Three things, not one. The first was always here; the second and third were found by the reviews.

1. **Offline balance verification.** Unchanged from `VadumInfo.md` §5.6, and the sentence should
   survive into the application verbatim:

   > *Fully offline balance verification is theoretically impossible without a light client. We do
   > not claim to have solved it; we bound it with amount caps, queue limits and a send window.*

2. **Offline nonce-validity verification (T6).** A fully offline merchant cannot check that the
   nonce account behind a payment exists at all. In T0 and T1 one RPC call closes this completely.
   **In T2 it is unmitigated**, and T2's caps exist for exactly this reason. This is a *stronger*
   admission than item 1 — the attack is cheaper — and it must be stated as plainly.

3. **Payer-initiated voiding (T7).** A payer can kill every queued payment for free by advancing or
   closing their own nonce accounts. No client-side control binds this.

The literature agrees the real answer to all three is tamper-resistant hardware, and that
intermittently-offline designs are the practical ones (`VadumInfo.md` §8.2). Our primary scenario is
exactly that — and T0, where the merchant waits one second for confirmation, carries **none** of
these risks. The entire threat surface above is the price of not waiting.
