# Research — Prior art

Supersedes `VadumInfo.md` §8. Scan date **2026-08-27**. Covers the blind spot §8 admitted to
(hackathon archives) and corrects one materially wrong assessment.

---

## Correction: Zypp is bigger than §8 says — and the whitepaper settles it

`VadumInfo.md` §8.1 assesses `Coding-With-Josh/zypp` as "7 commits, 0 stars, early prototype". There
is a **second, more organised entity** the scan missed: **Zypp Labs** — `zypp.fun`, GitHub org
`zypp-labs`.

| | |
|---|---|
| Positioning | "Offline-First Payment Infrastructure Research" |
| Claimed products | Zypp Wallet (ZP-001), Zypp **SDK** (ZP-002), Zypp **Relay** (ZP-003), Zypp Research (ZP-004) |
| Whitepaper | *Delay-Tolerant Networking and Solana Transaction Propagation for Offline-First Payments*, v1.0, **19 March 2026**, 9 pages |
| Author | Joshua Idele, Founder & Lead Engineer |
| Protocol status shown on site | "LIVE" |
| Actual code — `zypp-labs/the-zypp-wallet` | **0 stars, 0 forks, 3 commits**, MIT, React Native |

**The two Zypps are one person.** `Coding-With-Josh/zypp` (7 commits) and `zypp-labs/the-zypp-wallet`
(3 commits) share the same founder; "Zypp Labs" is the rebranded org. Combined published code: ten
commits, zero stars, last moved five months ago.

It is still **the most dangerous item for the application** — it occupies the identical narrative
space with better packaging, and a reviewer searching "Solana offline payments" finds it first.
Dismissing it as a prototype would read as not having looked.

### What the whitepaper actually says — full text read, 2026-08-27

Local copy: `references/zypp-labs-whitepaper-v1.0-2026-03-19.txt`.

Structure: DTN primer (Store-Carry-and-Forward, Bundle Protocol) → Solana's Turbine propagation →
a proposal to carry **Offline Transaction Bundles** between phones and merchant "data mules" over
Bluetooth / NFC / local Wi-Fi, forwarded opportunistically until some node reaches connectivity and
injects them into Turbine. Product implications follow: offline wallets (TOSS), a merchant relayer
network (ZRN), community mesh, staking-and-slashing for unreliable mules.

**Keyword audit of the full text:**

| Term | Occurrences |
|---|---|
| `nonce` | **0** |
| `durable` | **0** |
| `double-spend` / `double spend` | **0** |
| `replay` | **0** |
| `blockhash` | **1** |
| `TTL` | 12 — but only as a product rule for discarding stale bundles |

The single `blockhash` mention is in the problem statement (§2): *"blockhash expiration penalizes
unstable connectivity."* The paper names the constraint once and never returns to it.

### Why this is decisive

Every mechanism the paper proposes is about **transport**. None is about **validity**. And the
central architecture is not merely silent on expiry — it is categorically incompatible with it:

> *"The data mule then carries this bundle until it establishes connectivity […] or even physical
> transport of the device."*

A signed Solana transaction on a fresh blockhash is valid for well under a minute — about 45 seconds since the 300 ms slot tier activated on
2026-08-26 (`03-VADUMINFO-ERRATA.md` E3). A data mule that carries
a bundle across town — let alone by physically transporting the device — arrives with a dead
transaction, every single time. The delivery network is designed in detail; nobody checked whether
the cargo survives the trip.

**Durable nonce is exactly what makes the cargo survive.** That is the one-sentence version of this
project, and a named competitor's own whitepaper is the evidence for it.

Two further gaps: double-spending is never mentioned in nine pages, and the security section is four
bullets about custody (non-custodial, keys never leave the device, on-chain settlement, no new trust
assumptions) — none of which touch the actual hard problem. The reference list has three entries,
one of which is the whitepaper citing itself.

### How to use this in the application

Not as a takedown. As proof the problem is real:

> *Zypp Labs published a whitepaper in March 2026 identifying the same constraint we do —
> "blockhash expiration penalizes unstable connectivity" — and proposed a delay-tolerant transport
> layer to carry signed transactions between devices. It does not mention durable nonces, and a
> transaction carried by a data mule expires in under a minute. The gap in offline Solana payments
> is not transport. It is transaction validity, and that is the gap we close.*

An independently-authored competitor that states your problem and fails to solve it is the strongest
possible prior-art section. It proves the problem is real, proves the gap is real, and lets the
technical depth show without any claim about being first to notice.


---

## The answer to "does a fresh-blockhash project already exist?"

Yes — and that is an argument *for* durable nonce being the default, not against it.

| What exists | What it is | Why it does not close the gap |
|---|---|---|
| Zypp Labs / Zypp Wallet | Offline-first wallet + SDK + relay, marketing-complete | Expiry never addressed; 3 commits |
| `Coding-With-Josh/zypp` | BLE/NFC proximity prototype | 7 commits, no double-spend mechanism |
| Solana Cookbook *Sending Offline Transactions*, Anza CLI *offline-signing* | Official documentation | Docs, not a product; air-gap/treasury framing |
| Solana Pay partial signing | Merchant co-signs a transaction request | Wallet must be **online** to fetch it |
| **PayD** (Devpost) | Offline transaction wallet, QR + WiFi Direct, TEE | **Not a blockchain project** — relies on a central authority server for verification and recovery |
| **Chainflow Offline Signer CLI** (Colosseum Codex, 16 Jan 2026) | Open-source CLI, **durable nonce based** | Treasury / cold storage / validators. Not payments, no QR, no merchant side |
| Ripe (Renaissance hackathon winner) | QR merchant payments, SE Asia | Fully online |
| DFNS, Fordefi | Durable nonce in production | Institutional custody and policy controls, not payments |

**Conclusion, and it is stronger than §8's:** the fresh-blockhash approach to offline Solana payments
is not unexplored — it is the obvious approach, it has been attempted, and it fails on the sub-minute
expiry window. The durable-nonce approach is production-proven but only in custody. **Nobody has joined the
two.** That sentence is the project's claim to originality, and it survives the widened scan.

---

## Effect on PROD-1 (default path) — RESOLVED

`VadumInfo.md` open question #11 asked which path the SDK defaults to. Two independent facts now
settle it toward **durable nonce**:

1. **Positioning.** Defaulting to fresh blockhash puts Vadum in the same bucket as Zypp Labs — an
   offline-first wallet with an unaddressed expiry window. The novel primitive would not be on the
   default path.
2. **Scope.** The both-parties-offline mode is in v1. Fresh blockhash cannot serve it at all: a
   sub-minute window does not survive a merchant queue. Durable nonce is the only path that covers
   all three v1 modes.

Fresh blockhash stays in the SDK as an **opt-in** optimisation for merchants who declare solid
connectivity, and as the deprecation hedge described in `VadumInfo.md` §3.6. It is a documented
alternative, not the default.

---

## Still open

| ID | Question | Note |
|---|---|---|
| ~~ART-1b~~ | Read the Zypp Labs whitepaper end to end | ✅ **Resolved** — read in full on 2026-08-27 (above), and the keyword audit was independently reproduced on 2026-08-29 (`02-OPEN-QUESTIONS.md`). It does not discuss durable nonces |
| ART-1c | Colosseum project directory + Devpost systematic sweep | Search engines surface winners, not the long tail. Needs a directory walk, not a query |
| ART-3 | Is there an existing spec/SIMD for QR-transported offline Solana payments? | Nothing found so far. If genuinely absent, `21-SPEC-wire-format.md` is the project's most durable output |
| ART-4 | Stablecoin volume figure — one metric, one number, one date | Sources diverge badly (35.5% vs 42.3%; $650B vs $960B for the same month). **Recommendation: drop the figure from the application entirely.** The argument rests on §7 legs 1–3, not on volume share |
