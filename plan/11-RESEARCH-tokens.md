# Research — SPL Token vs Token-2022, and mint compatibility

Answers to the `TOK-*` questions. All extension data below was read from **mainnet-beta via
`getAccountInfo` with `jsonParsed` encoding on 2026-08-27**, not from documentation.

---

## First, the thing that is not a problem

**The project's stablecoin is USDC, and USDC is the unconditionally easy case.**

| | Mainnet USDC | Devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) |
|---|---|---|
| Owner program | `Tokenkeg…` legacy SPL Token | `Tokenkeg…` legacy SPL Token |
| Decimals | 6 | 6 |
| Extensions | **none** | **none** |

No transfer hook, no transfer fee, no frozen-by-default, no permanent delegate. Nothing to guard
against, and devnet is shape-identical to mainnet so fixtures generated on devnet hold on mainnet.
**Nothing below changes the product's design.**

---

## The correction: `VadumInfo.md` §3.4 makes an extra claim that is wrong

The document says:

> *"Yaptığımız şey teknik olarak herhangi bir SPL mint üzerinde `transferChecked` — USDC'ye özel
> hiçbir şey yok. […] aynı kod **USDG** ve PYUSD ile de değişmeden çalışıyor."*

Live chain data:

| Mint | Address | Owner program | Extensions |
|---|---|---|---|
| **USDC** | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `Tokenkeg…` (legacy SPL Token) | **none** |
| **USDG** | `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` | `Tokenz…` (**Token-2022**) | 8, incl. `transferHook`, `transferFeeConfig`, `permanentDelegate` |
| **PYUSD** | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | `Tokenz…` (**Token-2022**) | identical set to USDG |

This is an *additional* claim layered on top of the USDC design, made deliberately as a "free
alignment" gesture because the grant pays in USDG. They are not the same program, so "unchanged
code" is false on its face. But the interesting part is
what the extensions actually contain:

```
USDG / PYUSD (identical):
  transferHook        -> { authority: 2apBGMsS…, programId: null }     ← no hook installed
  transferFeeConfig   -> { transferFeeBasisPoints: 0, maximumFee: 0 }  ← no fee charged
  permanentDelegate   -> { delegate: 2apBGMsS… }                       ← issuer can claw back
```

So **today** both mints are offline-compatible: no hook program to resolve, no fee to reconcile.
But `transferHook.authority` and `transferFeeConfigAuthority` are both set to a live Paxos
controller (`2apBGMsS…`, the same address for both mints — Paxos issues both). Either can be
switched on at any time, without warning, and an offline payer would have no way to know.

**The correct claim, which is stronger than the original:**

> Vadum works with any SPL Token or Token-2022 mint whose transfer hook is unset and whose transfer
> fee is zero. USDC qualifies unconditionally. USDG and PYUSD qualify today, but both are
> authority-mutable, so the SDK re-validates a mint's extension state on every online session and
> refuses to build offline payments against a mint whose hook or fee has since been activated.

This turns an incorrect boast into a shipped feature (`assertMintCompatible`) and a threat-model
entry. **Fix `VadumInfo.md` §3.4 before it is quoted anywhere.**

**Scope of the fix: one sentence in the document, plus a guard in the SDK.** The reference mint stays
USDC, the canonical builder is unchanged, and no stream's work is affected. `assertMintCompatible`
exists so that pointing the SDK at a different mint either works correctly or refuses cleanly —
which is what "mint-agnostic" should have meant in the first place.

---

## TOK-3 · Which extensions break the offline flow — RESOLVED

| Extension | Effect offline | Verdict |
|---|---|---|
| `transferHook` with non-null `programId` | Extra accounts come from an on-chain `ExtraAccountMetaList`; cannot be resolved without RPC. Canonical rebuild is impossible. | **HARD BLOCK** |
| `transferFeeConfig` with non-zero bps | Amount received ≠ amount sent; merchant's offline "is the amount correct" check is wrong; `transferCheckedWithFee` is required | **HARD BLOCK** |
| `defaultAccountState: frozen` | A newly created ATA arrives frozen and needs an issuer thaw. Offline ATA creation becomes useless. | **HARD BLOCK** for the create-ATA branch |
| `permanentDelegate` | Issuer can move funds after settlement. Does not break construction. | **WARN** — threat model entry |
| `confidentialTransferMint` | Only matters if confidential transfer is *used*; plain `transferChecked` is unaffected | **ALLOW** |
| `metadataPointer`, `tokenMetadata` | No effect on transfer construction | **ALLOW** |
| `mintCloseAuthority` | Does not break construction, but it is a **live authority** — on USDG and PYUSD it points at the same Paxos address (`2apBGMsS…`) as every other authority on those mints | **WARN** |
| `pausable` (if present) | Transfers can be halted; does not break construction | **WARN** |

### Freeze authority — missing from the table above, and it has a real failure mode

Live data, both clusters: mainnet USDC has `freezeAuthority: 7dGbd2QZ…`, devnet USDC has
`CJtyoKSL…`. The extension table covers `defaultAccountState` but said nothing about a plain freeze
authority, which every USDC-class mint has.

The issuer can freeze **either** ATA — the payer's or the merchant's — at any moment. Every queued
offline payment against a frozen account then fails **at execution**, which per SOL-7 means the
merchant **pays the fee** and the payer's nonce slot is **consumed**. That is the expensive failure
class, not the free one.

| Extension | Effect offline | Verdict |
|---|---|---|
| `freezeAuthority` non-null | Cannot be detected offline; queued payments fail at execution if either ATA is frozen | **WARN**, and the T1 online path SHOULD check both ATAs' frozen state before handover |

`assertMintCompatible(mint)` implements this table, runs while online, and caches a timestamped
verdict. **Staleness policy is D22**, not a flat TTL: an immutable mint such as USDC never goes
stale, because its verdict cannot change without a mint upgrade; only authority-mutable mints
(USDG, PYUSD) expire, and expiry warns and caps rather than hard-blocking. A flat 24-hour TTL would
have meant a payer can pay offline only within 24 hours of last being online — deleting the
disaster-zone and rural-vendor scenarios the project exists for.

---

## TOK-4 · ATA derivation — RESOLVED

`findAssociatedTokenPda({ owner, mint, tokenProgram })` from `@solana-program/token`.

**The token program address is part of the ATA seeds.** The same owner and mint therefore produce
*different* ATAs under legacy SPL Token and Token-2022. The token program is consequently part of
the canonical input set and must be derivable from the intent — it is, since it follows from the
mint, and the mint is in QR#1.

Constants exported: `TOKEN_PROGRAM_ADDRESS`, `ASSOCIATED_TOKEN_PROGRAM_ADDRESS`. Token-2022's
address comes from `@solana-program/token-2022`.

---

## TOK-5 · `transferChecked` across both programs — RESOLVED

`getTransferCheckedInstruction({ source, mint, destination, authority, amount, decimals }, { programAddress })`
has the same shape for both programs; only `programAddress` changes. Instruction data (discriminator
+ `u64 amount` + `u8 decimals`) is identical.

`transferChecked` remains the right choice over `transfer`: mint and decimals are bound into the
instruction, so an offline merchant can verify both without touching chain state.

**Confirmed offline** — no chain access needed, so `60-PHASE0-derisk.md` step 12 is dropped.
Compiling the instruction under both `programAddress` values gives identical instruction data
`0ca02526000000000006` and identical account roles `1,0,1,0`. Only `programAddress` and the derived
ATAs differ, and the ATA difference is expected (TOK-4).

---

## TOK-6 / TOK-7 · Creating the merchant's ATA — RESOLVED by D5: the instruction stays

`getCreateAssociatedTokenIdempotentInstruction` funds rent from an explicit `payer` account, which
can differ from the ATA `owner`. The funder is `createNoopSigner(intent.feePayer)` (D19), so the
merchant funds their own ATA from their own SOL and the payer never spends any.

> ⚠️ **An earlier revision of this section recommended the opposite** — dropping the instruction from
> the v1 canonical message — and that recommendation was never withdrawn after `01-DECISIONS.md` D5
> locked the other way. `40-STREAM-A-core.md` A4 sends Stream A into this file for the TOK-3 blocker
> table, so a stale "drop it" sitting beside a live "keep it" was a coin flip on the shape of the
> canonical message, and every fixture with it. **The recommendation is withdrawn. D5 governs.**

The earlier reasoning was also wrong on its own terms. It argued the instruction is pointless because
"the merchant knows whether their own ATA exists" and "in the fully-offline-merchant mode nobody can
fund rent anyway". The second half is the error: the rent is funded **at submission time, when the
merchant is back online**. An offline merchant who has never received this mint still ends up with a
working ATA, without any onboarding precondition.

**And the decision costs zero QR bytes** — the branch is driven by a flag bit in the intent, so it
never crosses the air gap (D5's measured table: 354 B → 396 B compiled, and 132 B → 132 B on the wire
— D5 prints 131, from before the 3-byte header).

*Consequence:* the `DefaultAccountState: frozen` edge case stays live, which is why TOK-3 hard-blocks
such mints.

---

## Reference mints — superseded by D24

An earlier revision put devnet USDC into Phase 0 and the demo. That cannot work: devnet USDC's mint
authority is Circle's, so a test payer could only be funded through a rate-limited external faucet,
which D15 forbids depending on. **D24 governs:**

| Job | Mint |
|---|---|
| Phase 0, golden fixtures, CI, integration tests, demo | **An own devnet test mint** — 6 decimals, legacy SPL Token, no extensions, mint authority held by the harness. Shape-identical to USDC |
| `evaluateMint` / `assertMintCompatible` suite, and every claim in the docs | **Live** devnet and mainnet USDC (devnet: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`), USDG and PYUSD — read only |
| Proving the hard block fires | A locally created mint with an **active** transfer hook, which cannot be found on chain |
