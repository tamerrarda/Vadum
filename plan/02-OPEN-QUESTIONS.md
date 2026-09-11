# Open Questions Tracker

Every question that must be answered before a coding session can start. A question is
**RESOLVED** only when it has a concrete answer *and* a source or a passing experiment.
Anything still `OPEN` at spec-freeze time is a blocker unless it is explicitly marked non-blocking,
with the reason.

Status legend: `OPEN` · `RESEARCHING` · `RESOLVED` · `DEFERRED-V2`

While the streams run, nobody edits this file: each stream appends to
`plan/questions/stream-{0,a,b,c}.md`, and this file is reconciled at integration.

---

## SOL — Solana protocol & @solana/kit

| ID | Question | Why it blocks | Status |
|---|---|---|---|
| SOL-1 | Exact `@solana/kit` API for building a durable-nonce transaction message (function names, package, signatures) | Stream A cannot write `buildMessage` without it | ✅ RESOLVED — 10 |
| SOL-2 | Exact `@solana-program/system` instruction builders: `advanceNonceAccount`, `createAccountWithSeed`, `initializeNonceAccount`, `withdrawNonceAccount`, `authorizeNonceAccount` | Nonce pool lifecycle | ✅ RESOLVED — 10 |
| SOL-3 | Nonce account binary layout: field order, byte offsets, enum values for version/state | Reading the nonce value offline and online | ✅ RESOLVED — 10 |
| SOL-4 | Is Solana message account-ordering deterministic and stable across kit versions? What is the exact ordering algorithm? | The entire canonical-rebuild trick depends on this | ✅ RESOLVED — experiment |
| SOL-5 | `createAccountWithSeed` address derivation formula, and which parties must sign when `base != from` | Nonce address derivation from payer pubkey + index; sponsored setup ceremony | ✅ RESOLVED — derivation confirmed. **SOL-5b is moot under D26**: with no sponsor, `from == base == payer`, so there is one signer and no two-party ceremony |
| SOL-6 | What exactly does a signer sign — the compiled message bytes? How to reproduce those bytes for offline `ed25519.verify`? | Merchant-side offline verification | ✅ RESOLVED — experiment |
| SOL-7 | Fee semantics: does a durable-nonce tx that fails *nonce validation* pay a fee? Does one that fails *at execution* pay a fee? | Merchant fee-DoS exposure, queue limits | ✅ RESOLVED — 10. Both halves are observed on chain in Phase 0 steps 11 and 14 (D35) |
| SOL-8 | After `AdvanceNonceAccount` executes, what is the new stored nonce value and is it predictable? | The "merchant returns the advanced nonce over QR" recovery flow | ✅ RESOLVED — 10 |
| SOL-9 | Rent-exempt minimum for an 80-byte nonce account, today, on devnet and mainnet, given SIMD-0437 rollout state | Pool cost, `31-PARAMETERS.md` | ✅ RESOLVED — live RPC; SIMD-0437 not accepted (D7) |
| SOL-10 | Does kit run in a browser without Node polyfills? Ed25519 in WebCrypto vs `@noble/curves` | PWA bundle, Stream C | ✅ RESOLVED — 10 |
| SOL-11 | Devnet practicalities: RPC endpoint, airdrop limits, rate limits, creating a test mint | Phase 0 | ✅ RESOLVED — faucet unusable (429); D15 + `--merchant-key`. Funding is an owner task, tracked as **OPS-6** |
| SOL-12 | Can the payer's own account be a non-writable signer (payer holds no SOL, pays no rent)? Any post-execution `min_balance` check that breaks this? | The "payer holds zero SOL" claim | ✅ RESOLVED — see below |
| SOL-13 | Priority fees / compute budget instructions — do we need them, and do they break the canonical rebuild? | Message determinism | ✅ RESOLVED — **D16**: none in v1 (devnet only). Structurally they cannot be added at submission time, so this had to be decided, not measured |

## TOK — Tokens

| ID | Question | Why it blocks | Status |
|---|---|---|---|
| TOK-1 | Which token program does devnet USDC use? Which does mainnet USDC use? | Phase 0 and reference mint | ✅ RESOLVED — 11 |
| TOK-2 | USDG mint address on Solana and its exact Token-2022 extension set | Grant is paid in USDG; the doc claims compatibility | ✅ RESOLVED — 11 |
| TOK-3 | Which Token-2022 extensions break offline construction or offline verification, and how are they detected? | `assertMintCompatible` in Stream A | ✅ RESOLVED — 11 |
| TOK-4 | ATA derivation seeds — do they differ between SPL Token and Token-2022? | Both sides must derive the same ATA | ✅ RESOLVED — 11 |
| TOK-5 | `transferChecked` account list and data layout for both programs — identical? | Canonical builder | ✅ RESOLVED offline — identical instruction data `0ca02526000000000006` and identical account roles `1,0,1,0` under both programs; only `programAddress` and the derived ATAs differ. Phase 0 no longer needs a Token-2022 step |
| TOK-6 | `createAssociatedTokenAccountIdempotent` — who funds the rent, and can the funder differ from the owner? | "Payer holds no SOL" | ✅ RESOLVED — D5: kept; the fee payer (`intent.feePayer`, the merchant in v1) funds rent (D19) |
| TOK-7 | Does a newly created ATA under a `DefaultAccountState: frozen` mint arrive frozen? | Whether offline ATA creation is ever useful | ✅ RESOLVED — 11 TOK-3: hard block |

## WIRE — Encoding & QR

| ID | Question | Why it blocks | Status |
|---|---|---|---|
| WIRE-1 | Is there a maintained base45 npm package, or do we implement RFC 9285 ourselves? | Stream B | ✅ RESOLVED — vendored (D12) |
| WIRE-2 | QR alphanumeric capacity table — exact character counts for versions 4–12 at EC levels L and M | Predicting QR version from payload size | ✅ RESOLVED — 12 |
| WIRE-3 | Which QR render library, and does it expose the chosen version + EC level for measurement? | Measurement report is a deliverable | ✅ RESOLVED — 12; `qrcode@1.5.4`, pinned (20) |
| WIRE-4 | Scanning: `BarcodeDetector` support matrix in 2026; fallback library choice | Stream C camera path | ✅ RESOLVED — 12 |
| WIRE-5 | Should QR #1 be a `solana:` Solana Pay URL for ecosystem interop, or a raw Vadum payload? | Affects wire format and positioning | ✅ RESOLVED — raw payload; Solana Pay compat is not viable (no nonce field) |
| WIRE-6 | Measurement methodology: what exactly gets reported (read success rate, time-to-read distribution, device matrix, lighting) | Deliverable #3 is the strongest empirical output | 🟡 OPEN — **must be written into `32-MEASUREMENT-METHOD.md` before Stream B starts B5 and before any data is collected.** Handing it to a coding session is the plan's own failure condition, and a methodology written after the data is not a methodology. *Blocking scope narrowed 2026-09-11:* it does not block spec freeze or Streams A and C, because `25-SPEC`'s `measure.ts` types already carry device and lighting as vocabulary strings the method defines — writing the method changes no frozen signature. Device choice depends on the handsets physically available (D13) |
| WIRE-7 | Fallback if a payload does not fit: split into two QRs, or animated QR? Decide now, not later | Stream B design | ✅ RESOLVED — 12: moot, largest payload is 140 B |

## APP — PWA runtime

| ID | Question | Why it blocks | Status |
|---|---|---|---|
| APP-1 | Does a service-worker PWA reliably launch and function in airplane mode on Android Chrome and iOS Safari? | The entire demo | 🟡 PARTIAL — non-blocking for freeze: resolved in principle (13), proven on real devices by Stream C (C1, C9) |
| APP-2 | Key storage: IndexedDB vs WebCrypto non-extractable keys — can we sign ed25519 with a non-extractable key in browsers? | Signer security posture | ✅ RESOLVED — 13 (non-extractable CryptoKey + polyfill) |
| APP-3 | Camera constraints for reliable QR scanning on cheap Android (resolution, focus, torch) | Read success rate | 🟡 PARTIAL — non-blocking for freeze: empirical, belongs to the measurement run |
| APP-4 | Durable local state: how to persist "nonce N is spent" so it survives crash but is honest about reinstall | VadumInfo §5.9, hardest operational part | ✅ RESOLVED — 13 + 30 (RECOVERY state, fail-safe) + **D32** (slot state owned by `client/pool.ts`, durability by Stream C) |
| APP-5 | iOS PWA limitations that could kill the demo (storage eviction, camera in standalone mode) | Device choice for the video | ✅ RESOLVED — 13 |

## PROD — Product parameters & decisions

| ID | Question | Why it blocks | Status |
|---|---|---|---|
| PROD-1 | Default path: fresh blockhash or durable nonce? (VadumInfo Q11) | SDK default, docs, demo | ✅ RESOLVED — D4: durable nonce default |
| PROD-2 | Nonce pool size N — the number we publish, and the risk math behind it (VadumInfo Q4) | `31-PARAMETERS.md` | ✅ RESOLVED — **D23**: N=5 signed off. But see **D21**: N is *not* an attacker bound, and the published risk math is rewritten accordingly |
| PROD-3 | Per-receipt amount cap and merchant queue exposure cap — actual numbers | Threat model credibility | ✅ RESOLVED — **D23**: T1 20 / T2 5 / queue 50, in the mint's base units, not dollars |
| PROD-4 | Send window (product-level TTL) — actual duration, and what happens when it expires | Threat model | ✅ RESOLVED — **D23**: 24 h. Bounds honest failure only; a payer can void the queue at will (**T7**) and a modified merchant app can ignore the window |
| PROD-5 | Is the static-merchant-QR mode (buyer enters amount, one QR hop) in v1? | Scope | ✅ RESOLVED — D6: IN |
| PROD-6 | Secure element / attestation in v1? (VadumInfo Q7) | Scope | ✅ RESOLVED — D6: deferred to v2 |
| PROD-7 | Failure UX: what the merchant sees when a send fails, what the payer sees when a nonce desyncs (VadumInfo Q5) | Stream C | ✅ RESOLVED — 42 C7 (decisions made and the load-bearing copy stated; the rest is writing) |
| PROD-8 | Payment cancellation via self-advancing the nonce | Feature + threat model | ✅ RESOLVED — D6: deferred to v2 |
| PROD-9 | Which reference mint for the demo | Phase 0 and demo | ✅ RESOLVED — **D24**, and it is two mints, not one. `60-PHASE0-derisk.md` said "create an own mint" while this row said devnet USDC; both are right for different jobs |

## ART — Prior art & positioning

| ID | Question | Why it blocks | Status |
|---|---|---|---|
| ART-1 | Hackathon archive scan: Colosseum project directory and Devpost (VadumInfo Q8) | The only known blind spot in §8 | 🟡 PARTIAL — 14 (ART-1c: directory walk still needed). Non-blocking for code; must finish before the grant application |
| ART-2 | Chainflow Offline Signer CLI — scope, repo, overlap with Vadum | Newly discovered prior art | ✅ RESOLVED — 14 (durable nonce, but treasury/cold-storage, not payments) |
| ART-1b | Read the Zypp Labs whitepaper end to end | Would invalidate the analysis if it discussed durable nonces | ✅ RESOLVED — 14: it does not. nonce=0, durable=0, double-spend=0 |
| ART-3 | Is there an existing spec/SIMD for QR-transported offline Solana payments? | Whether our wire format is genuinely new | 🟡 PARTIAL — nothing found; if truly absent, 21-SPEC is the most durable output. Non-blocking for code |
| ART-4 | Stablecoin volume figure — one metric, one number, one date, one source (VadumInfo Q9) | Sources diverge badly; wrong number costs credibility | ✅ RESOLVED — 14: drop the figure from the application |

| SOL-14 | Must the token authority be passed as a signer rather than a bare address? | Fresh path silently drops the payer's signer flag | ✅ RESOLVED — 10 SOL-14 + D14 |

## OPS — Repo & delivery

| ID | Question | Why it blocks | Status |
|---|---|---|---|
| OPS-1 | Monorepo tooling: pnpm workspaces + which test runner and build tool | All streams | ✅ RESOLVED — 20 (pnpm + Vitest + Vite) |
| OPS-2 | How do three parallel sessions avoid merge conflicts — branch strategy and file ownership | Parallelism | ✅ RESOLVED — 20 (disjoint file ownership) + 50 (branch order) |
| OPS-3 | License and repo location (`tamerrarda/Vadum`) | Public good positioning | ✅ RESOLVED — **D25**: Apache-2.0, `github.com/tamerrarda/Vadum`, public from the first commit. Created private; visibility is OPS-7 |
| OPS-4 | CI: what runs on every push, and what gates the spec-freeze | Quality | ✅ RESOLVED — 20 + 24 (golden fixtures gate) + 39 (Stream 0 task 0.2) |
| OPS-6 | Owner prerequisites for Stream 0: **Node ≥ 24** on the build machine (the local toolchain was 22.18 on 2026-09-11, and the token packages declare `engines.node >=24.0.0` — D1); **the repository initialised** — the workspace is not yet under version control, so "spec freeze" has no commit to point at; **a devnet key with ≥ 0.5 SOL** for Phase 0 (D15) | Stream 0 (D33) | 🟡 PARTIAL — Node 24.18 found under nvm and pinned in `.nvmrc`; the repository initialised on 2026-09-11 with `tamerrarda/Vadum` as its remote. **Still owed: devnet SOL** for the throwaway key in `.devnet/merchant.json` (the RPC airdrop returned `-32603`), which blocks Phase 0 only |
| OPS-7 | Repository visibility. D25 says public from the first commit; `tamerrarda/Vadum` was created private. Settle two things before it goes public: `VadumInfo.md` describes itself as *"ekip içi bilgilendirme"* (internal to the team) and sits in the first commit's history, alongside candid grant strategy and competitor notes in `plan/`; and the GitHub private vulnerability reporting that `SECURITY.md` points at can only be enabled on a public repository | Public-good positioning (D25), `SECURITY.md` | 🟡 OPEN — owner decision; blocks neither Stream 0 nor the streams |


---

## Closed by the independent review — 2026-08-29

Two independent adversarial reviews of this workspace ran on 2026-08-29. Their findings are recorded
in `01-DECISIONS.md` (D11, D12, D16–D24), `30-THREAT-MODEL.md` (T7–T10) and the specs. The questions
they settled:

| ID | Answer | Evidence |
|---|---|---|
| SOL-12 | **Yes.** A zero-SOL payer works as a non-writable signer. The compiled header is `numSignerAccounts: 2, numReadonlySignerAccounts: 1`, and SIMD-0392 (`relax_post_exec_min_balance_check`, already in Agave 4.2 and live on devnet/testnet) is a *relaxation* of the post-execution check — it makes this safer, not riskier. The plan was over-worried; it stayed open only because Phase 0 was the designated closer | Compiled header + SIMD-0392 text |
| SOL-13 | **Not in v1** (D16). Also, structurally impossible to add later at submission time — the merchant cannot add a `ComputeBudget` instruction without altering the message the payer signed | By construction |
| TOK-5 | **Identical** across both token programs | `getTransferCheckedInstruction` compiled under both `programAddress` values |
| SOL-4 | Canonical rebuild is byte-identical **across kit 8.0.0 and 8.1.0** for identical inputs, so D3's load-bearing risk survives this particular bump | Compiled the same fixed inputs under both versions |
| ART-1b | Zypp whitepaper keyword audit reproduces exactly: `nonce` 0, `durable` 0, `double-spend` 0, `replay` 0, `blockhash` 1, `TTL` 12 | Independent count on the local copy |
| — | The nonce-cannot-live-in-an-ALT rule, inferred in `10-RESEARCH` from a kit error constant, is protocol law | SIMD-0242 `Implemented` — **but cite SIMD-0571 instead**, which supersedes its definition (D17) |

### Newly opened

| ID | Question | Why it blocks | Status |
|---|---|---|---|
| ~~SPON-1~~ | ✅ **CLOSED — D26: no sponsor in v1.** Original question: does a sponsor exist at all? A sponsored pool is a free faucet: the sponsor funds `createAccountWithSeed` + `initializeNonceAccount(authority = payer)`, after which the payer can `WithdrawNonceAccount` the rent to any recipient and repeat with a fresh keypair. There is no clean mitigation — the payer *must* be the authority to advance offline | `client/pool.ts`, Stream C onboarding, and the "payer never needs SOL" story | ✅ RESOLVED — D26 |
| ONB-1 | Pool setup has no owner, no UI and no API, and `51-DEMO-SCRIPT.md` puts "pool created and funded" in pre-filming setup — so the video steps over it. **Simplified but not closed by D26**: with no sponsor it is a single-signer, single-screen online flow rather than a co-signing protocol, but Stream C still has no task for it and Stream B still has no `pool.ts` API for it | Stream C onboarding, `26-SPEC-client-api.md` | ✅ RESOLVED — `26-SPEC` `Pool.estimateSetupCost` / `Pool.create`, and task C0 in `42-STREAM-C-apps.md` |
| ~~OPS-5~~ | ✅ **CLOSED — D27**: names reserved at bootstrap, real publish at v1 | | |
| WIRE-8 | `NONCE_DESYNC` has an error code but no reconciliation algorithm. The payer marks a slot spent at signing time (fail-safe); if the merchant never submits (T7/grief), the slot is unspent on chain and nothing specifies the online reconciliation that compares the chain value to the recorded pre-signing value and releases it | Straddles `client/pool.ts` (Stream B) and the payer ledger (Stream C) — both will invent it | ✅ RESOLVED — `23-SPEC` reconciliation procedure, `26-SPEC` `Pool.reconcile`, and **D32** (one owner for slot state; settled slots re-arm) |
| PRIV-1 | The `AUTH` payload carries the payer's raw pubkey, and the `vadum-<i>` seed scheme makes the whole nonce pool enumerable by anyone holding it. A merchant — or a bystander photographing the screen — can link the payer to their full on-chain history and read their remaining offline capacity | Threat model and README completeness | ✅ RESOLVED — documented as **T10** in `30-THREAT-MODEL.md`; no v1 mitigation, and the README says so |

### Process note

~~`40-STREAM-A-core.md` says "Streams B and C are blocked until [A0]", `41-STREAM-B-wire-client.md` says "You are not
blocked by Stream A", and `42-STREAM-C-apps.md` says "You are not blocked by A or B". All three are
normative task documents and they contradict each other.~~ **Fixed 2026-09-11.** `50-INTEGRATION.md`
now states the real dependency — Stream 0 (bootstrap, fixtures, Phase 0) and then Stream A's A0 stubs
land on `main` before B and C branch — and all three stream documents say the same. `42-STREAM-C-apps.md`
C0.5 owns the fixture-backed fakes that keep the apps from throwing `INTERNAL_NOT_IMPLEMENTED` on day
two.

Three parallel sessions appending to *this file* is itself a merge conflict. Each stream appends to
`plan/questions/stream-{0,a,b,c}.md` instead, and this file is reconciled at integration. All four task
documents now say so.

---

## Closed by the go/no-go review — 2026-09-11

A go/no-go review of the whole workspace on 2026-09-11 concluded the design was sound but not ready to
freeze: several normative specs could not be implemented as written, and the execution documents still
instructed behaviour the decisions had retracted. Its findings, and where each is closed:

| ID | Finding | Closed by |
|---|---|---|
| REV-1 | `NONCE_RETURN` signed only `bytes[0..36)` — no payer, no prior value — so a genuine return for one payer's slot re-armed the same slot index for any other payer of that merchant, and old returns replayed across cycles | **D28** — signs a reconstructed 118-byte statement; 0 QR bytes |
| REV-2 | "2.2% of payloads begin with a space; trimming corrupts one payment in fifty" came from random bytes. No Vadum payload can start with a space and no base45 string can end with one, so two mandatory fixtures could not be generated | **D29** |
| REV-3 | Four `22-SPEC` signatures did not compile against kit 8.0.0 or contradicted their own prose: `applyLifetime` (sync, `T → T`), `evaluateMint` (no `checkedAt`), `NOT_IMPLEMENTED` (not a code), nonce values typed `Address` | **D34** |
| REV-4 | Receive rules 7, 9, 12 and 13 had no implementable home in the codec; no check order existed, and `bad-static-fee-payer-separate` contradicted the spec's own precedence sentence; rule 5 ignored the `TOKEN_2022` flag for known mints; T1's mandatory pre-check had no enforcement point | **D30** |
| REV-5 | Dedupe stopped at settlement and was undefined on the fresh path | **D31** |
| REV-6 | No API could mark a slot spent while two components kept separate spent-slot records; reconciliation never re-armed a settled slot | **D32** |
| REV-7 | Phase 0's ASSERT B (identical replay) could not fail; with RPC preflight on, the fee behaviour of failures is not observable at all | **D35**, `60-PHASE0-derisk.md` observation method |
| REV-8 | Bootstrap, the fixture generator and a conforming Phase 0 script had no owner | **D33** — Stream 0, `39-STREAM-0-bootstrap.md` |
| REV-9 | base45 was justified by density. Measured with `qrcode@1.5.4`, raw bytes in byte mode give the same QR version for every payload, and one smaller for the fresh `INTENT` at EC-Q | Decision unchanged; rationale corrected in `12-RESEARCH-wire-qr.md` and `21-SPEC` transport MUST 5 (transport safety); `03-VADUMINFO-ERRATA.md` E11 |
| REV-10 | Rules 4 and 5, the base45 group overflow and static-mode `expectedAmount` had no negative fixture, and several negatives named no entry point | `24-SPEC` — thirty-two negatives, each with a `target` (thirty-three after D37) |
| REV-11 | The execution documents still instructed retracted behaviour (task numbers as they stood before the rewrite): sponsored pools (`41` B7, `60`), a notification-permission prompt (`42` C3), the reassuring `SUBMIT_NONCE_REJECTED` copy (`42` C7, `50`), an unsigned 36-byte return (`42` C8, `50`), a TTL cache that hard-blocks (`20`, `41` B6), the blockhash confirmer (`60`); `41` and `42` did not list their own API specs as reading | Rewritten: `00`, `20`, `40`, `41`, `42`, `50`, `51`, `60`, `experiments/README.md`; `39` added |

### Newly opened — non-blocking

| ID | Question | Why it matters | Status |
|---|---|---|---|
| NONCE-9 | Should reconciliation release an abandoned slot by **self-advancing** the nonce rather than reusing the unchanged value? Reuse after the 24 h window means a merchant who submits late — honestly offline for 30 h, or running a modified app that ignores the window — races the payer's next payment on that slot. Self-advancing makes the old payment definitively dead, but costs the payer a ~5,000-lamport fee, i.e. a small SOL float after D26 | Payer capacity versus late-merchant loss | 🟡 OPEN — **non-blocking**: v1 ships the window rule in `23-SPEC`, and the late merchant's loss is stated there. An owner call, not a technical one |

---

## Found by Stream 0 — 2026-09-11

Writing the independent fixture generator exercised every spec it reads. What it found, and where each
finding is closed:

| ID | Finding | Closed by |
|---|---|---|
| S0-1 | `qrcode` segments strings automatically. Every nonce-path `INTENT` carries a digit run — the zero bytes of the u64 amount — that becomes a numeric segment, so "every payload is one alphanumeric segment" held only for random payloads | **D36** — `renderQr` encodes one explicit alphanumeric segment |
| S0-2 | The base45 rules omitted a 2-character tail above `0xFF` (`::` decodes to 2,024) | **D37**, and fixture `bad-base45-tail-overflow` |
| S0-3 | The fixture shapes left decisions to the consumer: positive cases had no `auth` object, so Stream A could not call `verifyAuth` before `wire` existed; bigints and bytes had no JSON convention; `bad-fee-payer-is-payer` had two entry points and no way to say so; mint-cache and queue contexts had no encoding | `24-SPEC` file shape, JSON conventions and `target` rules; the types are exported by `@vadum/fixtures` |
| S0-4 | Observed while building the reference builder, recorded as evidence: the token-2022 package's builders compile messages byte-identical to `@solana-program/token` with the program address overridden (TOK-5), and applying the lifetime before or after the instructions compiles identical bytes, as the D34 `NonceProvider` design assumes | No change needed |
