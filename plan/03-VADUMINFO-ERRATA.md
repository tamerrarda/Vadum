# Errata — `VadumInfo.md`

Corrections to the source document, found by research and by two independent reviews. **`VadumInfo.md`
is the basis of the grant application**, so every item here is a claim a Solana-literate reviewer
could check and find wrong.

Nothing has been edited in `VadumInfo.md` itself yet. This file is the changelist; applying it is a
single pass once the owner approves.

Severity: **CREDIBILITY** — a reviewer opens one linked file and finds the opposite · **ACCURACY** —
wrong but not adversarially checkable · **SCOPE** — a claim the shipped product will not keep.

---

## E1 · SIMD-0437: the document says Idea, the chain shows its first tier — CREDIBILITY, revised 2026-09-11

> **Revised on 2026-09-11 (D39).** The entry below was accurate on 2026-08-29 and is wrong now. One nonce
> account's rent is **1,317,264 lamports on mainnet** (`lamports_per_byte_year` 6,333, SIMD-0437's first
> tier) and 1,056,640 on devnet (5,080, the second tier). The SIMD file still reads `status: Idea`. So
> §3.2's *"şu an ilk kademedeyiz"* is true of mainnet today, and *"kabul edildi"* is still unsourced.
> The document's own caution — do not present the finished number as today's — was the right instinct.

**Where:** §3.2 (*"SIMD-0437 kabul edildi… Agave 4.2 mainnet feature aktivasyonu 17 Ağustos 2026
haftasında başladı… Şu an ilk kademedeyiz"*), §7 leg 5 (*"ilk kademe aktive edildi"*), §14.

Fetched from the SIMD repository on 2026-08-29:

```
0437-incremental-rent-reduction.md   status: Idea
                                     feature: (fill in with feature key ... once accepted)
```

Confirmed independently two ways: the live Rent sysvar still reads `lamports_per_byte_year = 6960`,
and `getMinimumBalanceForRentExemption(80)` still returns 1,447,680 lamports on both mainnet and
devnet. `10-RESEARCH-solana.md` SOL-9 noticed the number had not moved and wrote it off as "not
observable in the RPC's answer yet"; the correct inference was that the SIMD is not accepted.

**Replace with (revised 2026-09-11):** *"Nonce hesabı kirası 11 Eylül 2026 itibarıyla mainnet'te 0,001317264
SOL. SIMD-0437'nin beş kademeli planının ilk kademesi zincirde yürürlükte — devnet ikinci kademede —
ancak öneri dokümanı hâlâ Idea aşamasında görünüyor. Plan tamamlanınca kira ~%90 düşecek. SDK kirayı her
seferinde zincirden okuyor; hiçbir rakam sabit değil."*

Agave 4.2 shipping the code is not mainnet activation — press coverage conflates the two.

---

## E2 · SIMD-0296 / SIMD-0385 have not activated either — CREDIBILITY

**Where:** §6.1 (*"Agave 4.2 ile gelen SIMD-0296 / SIMD-0385 işlem boyutu tavanını 1.232 bayttan
4.096 bayta **çıkardı**"* — past tense), and §6.3's dependent argument that #415's blocker is cleared.

`0296-larger-transactions.md` is `status: Review`, no feature key, not live on any cluster.

**Replace with:** *"SIMD-0296/0385 yeni v1 formatta tavanı 4.096 bayta çıkarmayı öneriyor; Review
aşamasında, henüz hiçbir kümede aktif değil."* The §6.1 rebuttal ("bağlayıcı kısıt QR yoğunluğu,
işlem boyutu değil") is unaffected and still correct.

---

## E3 · The blockhash window is ~45–48 seconds, not 52.5 — ACCURACY, and it is in the demo caption

**Where:** §2.4 table and prose, §15 glossary, and — most visibly — the caption track in
`51-DEMO-SCRIPT.md`.

Live mainnet feature-gate state for SIMD-0525:

| Tier | Mainnet |
|---|---|
| 350 ms | ACTIVATED slot 440,208,000 — 2026-08-19 |
| **300 ms** | **ACTIVATED slot 441,936,000 — 2026-08-26** |
| 250 / 200 ms | not activated |

Measured slot time is now ~314–317 ms, so 150 slots is **~45–48 seconds**.

Two notes. The document says "dört kademenin ilki canlı"; **two of four are live**, which makes the
"problem is growing" argument *stronger*, not weaker. And 52.5 s was arithmetic on 150 × 350 ms while
the real figure at that time was 151 × 350 ms ≈ 52.9 s — the document's own basis says 150 slots, so
it was right by a rounding coincidence for exactly one week.

Cite the feature-gate activation, not the docs: Solana's own documentation contradicts itself here
(`/docs/core/transactions` says 150 slots; `/developers/guides/advanced/confirmation` says 151
blockhashes and "60 to 90 seconds" while still asserting 400 ms slots).

---

## E4 · "Alıcı hiç SOL tutmuyor" is narrower than stated — SCOPE

**Where:** §3.4.

True for **paying**: every transaction fee is paid by the merchant, which is a genuine Solana-native
property and the whole of §7 leg 2. Not true for **setup**: D26 removes the sponsor from v1, because
a sponsored nonce pool is a free faucet — `WithdrawNonceAccount` needs only the nonce authority, and
that must be the payer for offline advancing to work at all.

**Replace with:** *"Alıcı ödeme yapmak için SOL'e ihtiyaç duymuyor — bütün işlem ücretlerini satıcı
ödüyor. Havuzu kurarken bir kereliğine, tamamen geri alınabilir küçük bir kira depozitosu (Eylül 2026'da mainnet'te ~0,0066 SOL) yatırıyor ve havuzu
kapattığında geri alıyor."*

Still a strong onboarding story, and one the SDK can actually keep.

---

## E5 · The USDG / PYUSD compatibility claim — ACCURACY

**Where:** §3.4 (*"aynı kod USDG ve PYUSD ile de değişmeden çalışıyor"*).

Already documented in `11-RESEARCH-tokens.md` and restated here because it is the item most likely to
be quoted. USDC is legacy SPL Token with zero extensions; USDG and PYUSD are **Token-2022** with
eight extensions each. Not the same program, so "unchanged code" is false on its face.

**Replace with the stronger, accurate claim:** Vadum works with any SPL Token or Token-2022 mint whose
transfer hook is unset and whose transfer fee is zero. USDC qualifies unconditionally. USDG and PYUSD
qualify **today**, but every relevant authority on both is live and Paxos-controlled
(`2apBGMsS…`), so the SDK re-validates on every online session and refuses a mint whose hook or fee
has since been switched on.

---

## E6 · §5.9's nonce-desync section needs the merchant-side half — ACCURACY

**Where:** §5.9.

The section is right that the local "spent" ledger is the hardest operational part. Two additions:

- The recovery QR (§5.9 item 2) is now **signed** (D20). Unsigned, it let anyone re-arm a payer's
  slot and thereby make that payer defraud a *different* merchant — the harm landed on a third party,
  which the "güvenli başarısız oluyor" reasoning did not consider. The signature must also bind the
  payer and the slot's prior value (D28): a signature over the payload alone replayed to every other
  customer of the same merchant who had spent the same slot index.
- The document does not mention that the payer can void every queued payment for free by advancing
  or closing their own nonce accounts (`30-THREAT-MODEL.md` T7). §11 files this as a v2 *feature*;
  it is a capability that exists today.

---

## E7 · §5.2's implied bound does not exist — CREDIBILITY

**Where:** §5.2 (*"N nonce, N eşzamanlı geçerli ödeme demektir"*), and the derived claim in
`30-THREAT-MODEL.md` and `31-PARAMETERS.md` that this is a bound "enforced by Solana".

§5.2's own sentence is defensible as written — it is about the *payer's* capacity. What was built on
top of it is not: N does not bound merchant loss, the attacker picks their own N, and the nonce
account need not exist at all (`01-DECISIONS.md` D21, `30-THREAT-MODEL.md` T6). The retraction is
recorded in those two files; §5.2 needs one sentence added so the document does not read as the
source of the stronger claim.

---

## E8 · §6.3 predates SIMD-0571 — CREDIBILITY

**Where:** §6.3, which assesses deprecation risk from Discussion #415 and concludes *"gittiği yön
bizim yönümüz… bu bir bakım riski, inşa riski değil"*.

**SIMD-0571 "Soft Deprecation of Durable Nonces"** (PR #571, open, updated 2026-08-24) zero-rates the
compute-unit price of nonce transactions and states its purpose is migration *"ahead of full nonce
removal"*. Both Anza and Firedancer approved it on 2026-08-20; Firedancer then requested changes on
2026-08-24 to discuss the goal internally.

Full analysis is `01-DECISIONS.md` D17. The conclusion does not flip — the proposal's own Impact
section says legitimate users are "mostly unaffected", ~94% of blocks are not full, and a
fee-payer covering only the base fee stays valid, which is our merchant exactly. But §6.3 must name
0571, because it sits in the grantor's own repository and a reviewer will find it.

**Add:** the nonce-provider abstraction promised in §9 deliverable #1 is back in v1 scope for exactly
this reason. §6.3's *"yine de arayüz arkasına aldık"* becomes a commitment rather than a hedge.

---

## E9 · §8's Zypp assessment is too generous to itself — ACCURACY

**Where:** §8.1.

`14-RESEARCH-prior-art.md` already supersedes this with the Zypp Labs entity and the whitepaper
keyword audit (`nonce` 0, `durable` 0, `double-spend` 0, `replay` 0). Independently re-counted during
review: it reproduces exactly. §8 should point at the research file rather than carry the older,
softer assessment.

---

## E10 · §9 deliverable #3's measurement is a design task, not a coding task — SCOPE

**Where:** §9 deliverable #3, and the team note calling the round-trip time distribution "the
strongest empirical output".

Agreed, and that is the problem: the methodology did not exist and was assigned to a coding session.
It now belongs to `32-MEASUREMENT-METHOD.md` and must be written **before** the data is collected. A
methodology written afterwards is not a methodology, and this is the deliverable most likely to be
scrutinised.

Also: the headline threshold changes with E3. The chart is "what fraction of rounds exceed **45 s**
(today) and **30 s** (the SIMD-0525 target)", not 52.5 s.

---

## E11 · base45 is not "significantly denser" — ACCURACY

**Where:** §6.2 (*"byte moduna göre belirgin şekilde daha yoğun"*).

Measured with `qrcode@1.5.4` on every v1 payload: raw bytes in QR byte mode produce **the same** QR
version as base45 in alphanumeric mode at EC-M and EC-Q, and one version *smaller* for the fresh-path
`INTENT` at EC-Q. base45 in alphanumeric mode costs 8.25 bits per byte; byte mode costs 8.

The decision to use base45 is unaffected, and its real justification is stronger: browser scanner APIs
return text — `BarcodeDetector` exposes only `rawValue`, a string — and arbitrary binary does not
survive that conversion reliably. `12-RESEARCH-wire-qr.md` has the table.

**Replace with:** *"base45, QR'ın alphanumeric moduna birebir oturan bir kodlama. Byte moduna göre yoğunluk
kazandırmıyor; ama tarayıcıdaki QR okuma API'leri yalnızca metin döndürdüğü için ikili veriyi o yoldan
bozulmadan geçiriyor."*

---

## Corrections that are NOT needed — verified correct, do not re-litigate

Both reviews checked these independently and they hold. Listed so nobody spends time on them twice.

| Claim | Status |
|---|---|
| §3.2 nonce account is 80 bytes | ✅ Exact. The rent figure (~0.00145 SOL) was exact on 2026-08-27 and has since fallen — see E1 |
| §3.3's instruction order, and `AdvanceNonce` having to be first | ✅ Enforced by kit, not by our discipline |
| §3.5's honesty about the fresh-blockhash path not needing a nonce | ✅ Correct, and the qualifier it adds is one `30-THREAT-MODEL.md` had dropped |
| §5.1's *"protokolün garantisi en fazla biri düşer"* | ✅ Correct, and the fee semantics behind it are confirmed by Agave source |
| §6.1's *"imzacılar lookup table'a giremez"* and the nonce/ALT rule | ✅ Now protocol law — but cite **SIMD-0571**, not SIMD-0242, whose definition 0571's reviewer calls wrong |
| §6.4 no on-chain program, no audit needed | ✅ Correct and load-bearing for the grant scale |
| §7 legs 1–3 (head-of-line blocking, native fee-payer separation, sub-cent fees) | ✅ The strongest part of the document |
| §7 leg 4's volume figure | ⚠️ Not wrong, but `14-RESEARCH` ART-4 recommends **dropping it** — sources diverge badly and the argument does not need it |
| §8.2's literature survey and the "intermittently offline" framing | ✅ Correct, and independently confirmed by Crunchfish's own architecture |
| §10 grant parameters, USDG payment | ✅ Confirmed |
