# SPEC — Wire format

**NORMATIVE.** Frozen at spec freeze. Changing anything here after that requires every stream to
agree, because it invalidates the golden fixtures in `24-SPEC-fixtures.md`.

All multi-byte integers are **little-endian**. All public keys and hashes are **32 raw bytes**, never
base58 strings. Payloads are encoded for transport with **base45** (RFC 9285) so they land in QR
alphanumeric mode.

**Transaction message version is `0`** (D18). Not `'legacy'` — the two differ by two bytes and an
entirely different account-header encoding, and every fixture is generated against v0.

### Transport MUSTs — base45 is not a neutral pipe

1. **Exact length formula.** base45 emits 3 characters per 2 bytes, and **2 characters for an odd
   trailing byte**: `len(b45) = floor(n/2)*3 + (n%2 ? 2 : 0)`. The common shorthand "3 characters per
   2 bytes" is wrong for odd-length payloads (`AUTH` on the fresh path is 99 B → 149 ch, not 150).
2. **The alphabet contains SPACE** (D29). RFC 9285's alphabet is `0-9 A-Z SPACE $ % * + - . / :` —
   exactly the 45 characters of QR alphanumeric mode. A decoder **MUST NOT** trim, strip or normalise
   whitespace in a scanned string, and an encoder **MUST** emit spaces verbatim. What this protects,
   measured on the actual format rather than on random bytes:
   - **Interior spaces are near-universal.** 94% of 132-byte `AUTH` payloads contain one, and about 3%
     contain two adjacent spaces. Collapsing whitespace runs, substituting a non-breaking space, or
     line-wrapping in a log or copy path corrupts them.
   - **No base45 string ends with a space**, for any input: the last character of a 2-byte group is at
     most index 32 and of a 1-byte tail at most index 5, while space is index 36. **No Vadum payload
     begins with one**: the `version, type` group always encodes to `W50` (`INTENT`), `X50`
     (`STATIC_INTENT`), `Y50` (`AUTH`) or `Z50` (`NONCE_RETURN`).

   A `.trim()` is therefore harmless to every v1 payload. It stays forbidden because forbidding it
   costs nothing and a future version byte could change the prefix. An earlier revision claimed that
   2.2% of payloads begin with a space and that trimming corrupts one payment in fifty; both figures
   came from random byte arrays, not from this format.
3. **Payloads MUST NOT be embedded in a URL.** RFC 9285 §6 warns that percent-encoding the alphabet's
   ` $ % + / :` characters introduces **lowercase hex**, which forces the QR encoder out of
   alphanumeric mode and grows the QR by several versions. `%` is additionally a live
   percent-decoding hazard. This closes WIRE-5 normatively: QR#1 is a raw Vadum payload, never a
   `solana:` URL. (`12-RESEARCH-wire-qr.md` carried a stale paragraph leaning the other way; it has
   been removed.)
4. **base45 is vendored, not depended on** (D12). `base45@2.0.1` silently accepts out-of-alphabet
   characters and invalid lengths, producing wrong bytes instead of `WIRE_BASE45_INVALID`.
5. **base45 is for transport safety, not density.** Measured with `qrcode@1.5.4`, raw bytes in QR byte
   mode give the same QR version as base45 for every payload in the size table below, and one version
   smaller for the fresh-path `INTENT` at EC-Q. base45 is used because scanner APIs hand back text:
   `BarcodeDetector` exposes only `rawValue`, a string, and arbitrary binary does not survive that
   conversion reliably (`12-RESEARCH-wire-qr.md`).

---

## Principle

**A transaction is never transmitted.** Both sides compile the identical message from identical
canonical inputs (`01-DECISIONS.md` D3, proven in `experiments/canonical-rebuild.mjs`). The wire
carries only fields the receiver cannot derive.

Derived, never transmitted: source ATA, destination ATA, nonce account address, all program IDs,
instruction ordering, the `AdvanceNonceAccount` instruction, the `createAssociatedTokenAccountIdempotent`
instruction.

---

## Common header — 3 bytes on every payload

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | `version` — `0x01` |
| 1 | 1 | `type` — see below |
| 2 | 1 | `flags` — see below |

### `type`

| Value | Name | Direction |
|---|---|---|
| `0x01` | `INTENT` | merchant → payer, dynamic |
| `0x02` | `STATIC_INTENT` | merchant → payer, printed |
| `0x03` | `AUTH` | payer → merchant |
| `0x04` | `NONCE_RETURN` | merchant → payer, recovery |

### `flags` bitfield

| Bit | Meaning when set |
|---|---|
| 0 | `LIFETIME_FRESH` — fresh blockhash path. Clear = durable nonce (**the default**, D4) |
| 1 | `INCLUDE_CREATE_ATA` — canonical message includes `createAssociatedTokenAccountIdempotent` (D5) |
| 2 | `TOKEN_2022` — mint is owned by Token-2022. Clear = legacy SPL Token |
| 3 | `FEE_PAYER_SEPARATE` — a distinct fee-payer key follows. **Reserved in v1: encoders MUST NOT set it, decoders MUST reject it** with `WIRE_FEE_PAYER_SEPARATE_UNSUPPORTED` (D19). The layout is specified so a v1.1 relayer does not have to change the format |
| 4 | `AMOUNT_IN_AUTH` — amount is carried in `AUTH`, not in the intent (static mode) |
| 5–7 | Reserved. **MUST** be zero. A decoder **MUST** reject a payload with any reserved bit set |

Bit 2 exists because the token program cannot be derived from the mint without chain access, and the
ATA derivation seeds include the token program (`11-RESEARCH-tokens.md` TOK-4).

**Security rule that makes bit 2 safe — both halves are required.** A payer **MUST** refuse to sign
for any mint that is not in its local compatibility cache (`01-DECISIONS.md` D8), **and** a decoder
**MUST** reject an intent whose `TOKEN_2022` flag disagrees with the cached record's `tokenProgram`
(rule 5, `MINT_TOKEN_PROGRAM_MISMATCH`). An earlier revision stated only the first half, which covers
unknown mints and nothing else: for a known mint with a false flag, the payer derives the wrong ATAs,
the merchant's offline rebuild uses the same false flag and verifies, and the payment dies at
execution — charging the merchant a fee and burning the payer's slot (D30).

---

## `INTENT` — type `0x01`, merchant → payer

| Offset | Size | Field | Present |
|---|---|---|---|
| 0 | 3 | header | always |
| 3 | 32 | `merchant` | always |
| 35 | 32 | `mint` | always |
| 67 | 8 | `amount` — u64, base units | always |
| 75 | 1 | `decimals` | always |
| 76 | 32 | `blockhash` | only if `LIFETIME_FRESH` |
| … | 32 | `feePayer` | only if `FEE_PAYER_SEPARATE` |

**76 bytes** on the nonce path, **108 bytes** on the fresh path.

`decimals` is redundant with the payer's mint cache and is included anyway so the payload is
self-describing. A decoder **MUST** reject the payload if `decimals` disagrees with its cached value
for that mint.

---

## `STATIC_INTENT` — type `0x02`, printed sticker

| Offset | Size | Field |
|---|---|---|
| 0 | 3 | header |
| 3 | 32 | `merchant` |
| 35 | 32 | `mint` |
| 67 | 1 | `decimals` |

**68 bytes.**

Constraints, both **MUST** be enforced by the encoder and re-checked by the decoder:

- `LIFETIME_FRESH` **MUST** be clear. A printed sticker cannot carry a live blockhash, so **static
  mode implies the durable nonce path.** This is an independent reason D4 is correct.
- `AMOUNT_IN_AUTH` **MUST** be set. The merchant does not know the amount; the payer enters it.

---

## `AUTH` — type `0x03`, payer → merchant

| Offset | Size | Field | Present |
|---|---|---|---|
| 0 | 3 | header — `flags` **MUST** echo the intent's flags | always |
| 3 | 32 | `payer` | always |
| 35 | 1 | `nonceIndex` — u8, pool slot | unless `LIFETIME_FRESH` |
| 36 | 32 | `nonceValue` | unless `LIFETIME_FRESH` |
| … | 8 | `amount` — u64 | only if `AMOUNT_IN_AUTH` |
| … | 64 | `signature` — ed25519 over the compiled message | always |

**132 bytes** nonce + dynamic · **140 bytes** nonce + static · **99 bytes** fresh path.

The nonce account address is **derived**, not transmitted:
`createAddressWithSeed({ baseAddress: payer, programAddress: SystemProgram, seed: "vadum-" + nonceIndex })`
(`10-RESEARCH-solana.md` SOL-5). That is 32 bytes saved for one.

---

## `NONCE_RETURN` — type `0x04`, merchant → payer, recovery — **SIGNED** (D20, D28)

| Offset | Size | Field |
|---|---|---|
| 0 | 3 | header — `flags` **MUST** be `0x00` |
| 3 | 1 | `nonceIndex` |
| 4 | 32 | `newNonceValue` |
| 36 | 64 | `signature` — ed25519 by the merchant's fee-payer key over the **reconstructed statement** below, never over the payload bytes |

**100 bytes.** base45 → 150 characters → **QR v6 at EC-M, v8 at EC-Q** (measured). Still the
second-smallest payload in the protocol.

Sent after settlement so an offline payer can resynchronise without touching the network
(`VadumInfo.md` §5.9).

### The signed statement — reconstructed, never transmitted (D28)

| Field | Size | Merchant takes it from | Payer takes it from |
|---|---|---|---|
| domain tag — ASCII `vadum:nonce-return:v1` | 21 | constant | constant |
| `payer` | 32 | the settled `VerifiedPayment` | its own address |
| `nonceIndex` | 1 | `auth.nonceRef.index` | the payload |
| `spentAgainstValue` | 32 | `auth.nonceRef.value` | its own ledger |
| `newNonceValue` | 32 | `SubmitOutcome.newNonceValue` | the payload |

**118 bytes signed; nothing crosses the air gap beyond the 100-byte layout.** This is the
canonical-rebuild idea applied to the recovery payload: fields the payer already knows bind the
signature without being transmitted.

An earlier revision signed `bytes[0..36)` — header, index, new value. That covered neither the payer
nor the prior value, so a return issued to payer P1 for slot 3 verified for **any** payer whose ledger
had slot 3 spent at the same merchant, and an old return for the same slot replayed in a later cycle.
With N = 5 and every pool starting at slot 0 the cross-payer case needs no attacker — the next
customer scanning the wrong screen is enough. The harm is the one described next: a dead payment that
a *different* merchant absorbs.

### Why it is signed — the earlier reasoning was one-sided

An earlier revision left this payload unsigned, on the grounds that *"a wrong value makes the payer's
next transaction fail validation, which costs nothing and risks no funds"*. That is true **for the
payer**, and it is the wrong party to reason about.

Trace the harm. Anyone who can show a 36-byte QR — the merchant who took the payment, or a bystander
with a phone — re-arms slot *i* in an honest payer's ledger with a value of their choosing. The payer
later pays a **different** merchant M2. M2 rebuilds the message, the signature verifies (it is over a
message containing the bogus value), M2 hands over goods, M2 submits, and the chain rejects it.
**M2 loses the goods. The payer is unharmed. The attacker needs no keys and no funds.**

A sharper variant needs no third party at all: merchant M1 takes a payment on slot 3, withholds
submission, hands the payer a `NONCE_RETURN` freeing slot 3, waits for the payer to re-sign that slot
to M2, then submits. M1 is paid; M2 is not.

### The verification rule

**The merchant's public key is not transmitted.** The payer knows from its own ledger which merchant
slot *i* was spent on, and verifies the signature against **that** key, over a statement built from
**its own** address and **its own** record of the prior value. A return signed by any other key, or
issued to any other payer, or for any other prior value, is rejected with `NONCE_RETURN_UNTRUSTED`.

This is deliberate and it is better than carrying the pubkey: transmitting it would let an attacker
supply both the key and a matching signature. Binding to the ledger is what makes the payload
unforgeable — and it saves 32 bytes.

**Receive MUSTs**, by layer (D30):

- `wire.decodeNonceReturn`: reject unless `version == 0x01`, `type == 0x04`, `flags == 0x00` and the
  length is exactly 100.
- `client` `Pool.applyNonceReturn`: reject unless the payer's ledger records `nonceIndex` as spent and
  that record names a merchant — without it there is no statement to verify.
- `core.verifyNonceReturn`: reject unless the signature verifies against that merchant's fee-payer key
  over the statement built from the payer's own address and the recorded `spentAgainstValue`.
- `core.verifyNonceReturn`: reject if `newNonceValue` equals `spentAgainstValue` — a settled nonce
  always advances (`10-RESEARCH-solana.md` SOL-8), so an unchanged value is either a replayed return
  or a merchant that has not actually submitted.

A `NONCE_RETURN` that fails any of these is discarded silently; the slot stays spent, and the payer's
worst case is having to reconnect. That is the genuine fail-safe, and it is the one the unsigned
design only appeared to have.

---

## Legal `(type, flags)` combinations — normative

Receive rule 3 says a payload's length must match "the length implied by `type` and `flags`". That
rule was unimplementable across roughly a third of the input space, because several combinations had
no defined length and none were forbidden. They are now closed.

**Forbidden combinations — a decoder MUST reject each.** When a payload breaks more than one row, the
check order below decides which error is raised.

| Combination | Error | Why |
|---|---|---|
| `INTENT` (0x01) with `AMOUNT_IN_AUTH` | `WIRE_FLAG_NOT_ALLOWED_FOR_TYPE` | The dynamic intent carries `amount` unconditionally at offset 67 and its length does not vary with the flag. Left legal, it creates an **amount-resolution ambiguity in a payments protocol**: `22-SPEC`'s `intent.amount ?? auth.amount` takes the intent's, while the equally natural `auth.amount ?? intent.amount` takes the payer's, and the two sides would sign different amounts |
| `STATIC_INTENT` (0x02) with `FEE_PAYER_SEPARATE` | `WIRE_FLAG_NOT_ALLOWED_FOR_TYPE` | The 0x02 layout has no `feePayer` field and no length variant. **Unreachable in v1:** check-order step 6 raises `WIRE_FEE_PAYER_SEPARATE_UNSUPPORTED` first (D30) |
| `STATIC_INTENT` (0x02) with `LIFETIME_FRESH` | `WIRE_STATIC_CONSTRAINT` | A printed sticker cannot carry a live blockhash |
| `STATIC_INTENT` (0x02) without `AMOUNT_IN_AUTH` | `WIRE_STATIC_CONSTRAINT` | The merchant does not know the amount |
| `NONCE_RETURN` (0x04) with any non-zero `flags` | `WIRE_FLAG_NOT_ALLOWED_FOR_TYPE` | No flag has meaning for this type. Bits 5–7 and bit 3 are caught earlier by steps 5 and 6 |
| Any type with `FEE_PAYER_SEPARATE` | `WIRE_FEE_PAYER_SEPARATE_UNSUPPORTED` | Not implemented in v1 (D19). Takes precedence over every row above — check-order step 6 (D30) |
| Any type with bits 5–7 | `WIRE_RESERVED_FLAG_SET` | Reserved |

**Complete length table.** Every legal payload, keyed on `(type, flags)`. `n/a` marks a combination
forbidden above.

| Type | `LIFETIME_FRESH` | `AMOUNT_IN_AUTH` | Length | Notes |
|---|---|---|---|---|
| `INTENT` 0x01 | clear | clear | **76 B** | The default path |
| `INTENT` 0x01 | set | clear | **108 B** | `+32` blockhash |
| `INTENT` 0x01 | any | set | n/a | forbidden |
| `STATIC_INTENT` 0x02 | clear | set | **68 B** | The only legal shape for 0x02 |
| `STATIC_INTENT` 0x02 | any other | | n/a | forbidden |
| `AUTH` 0x03 | clear | clear | **132 B** | nonce, dynamic |
| `AUTH` 0x03 | clear | set | **140 B** | nonce, static — `+8` amount |
| `AUTH` 0x03 | set | clear | **99 B** | fresh — no `nonceIndex`, no `nonceValue` |
| `AUTH` 0x03 | set | set | **107 B** | fresh + static. Legal but not produced by v1; the merchant supplies a blockhash only in dynamic mode |
| `NONCE_RETURN` 0x04 | — | — | **100 B** | `flags` must be `0x00` |

`INCLUDE_CREATE_ATA` (bit 1) and `TOKEN_2022` (bit 2) never change any payload's length — they change
what the canonical builder produces, not what crosses the air gap. They still **MUST** be echoed
byte-for-byte from the intent into the `AUTH` (rule 6), because they change the message being signed.

**Optional-field order is normative, not implied by row order:** when both are present in an `INTENT`,
`blockhash` precedes `feePayer`. In an `AUTH`, `amount` precedes `signature`.

---

## Measured QR sizes

Every payload, base45-encoded as one explicit alphanumeric segment (D36).
**EC-Q is the shipped default (D11);** EC-M is retained as the comparison baseline for the
measurement report.

| Payload | Raw | base45 | EC-M | **EC-Q (default)** |
|---|---|---|---|---|
| `STATIC_INTENT` | 68 B | 102 ch | v5 · 37px | **v6 · 41px** |
| `INTENT` nonce | 76 B | 114 ch | v5 · 37px | **v7 · 45px** |
| `AUTH` fresh | 99 B | 149 ch | v6 · 41px | **v8 · 49px** |
| `NONCE_RETURN` signed | 100 B | 150 ch | v6 · 41px | **v8 · 49px** |
| `INTENT` fresh | 108 B | 162 ch | v7 · 45px | **v9 · 53px** |
| `AUTH` nonce dynamic | 132 B | 198 ch | v8 · 49px | **v10 · 57px** |
| `AUTH` nonce static | 140 B | 210 ch | v8 · 49px | **v10 · 57px** |
| *baseline: full signed transaction, never transmitted* | *525 B* | *788 ch* | *v18* | *v22* |

**The largest payload in the entire protocol is 140 bytes**, and the largest QR the product ever
renders is **v10 at EC-Q**. `VadumInfo.md` §6.1 budgeted 575–600 bytes and QR version 18–20; the
baseline row shows that estimate was roughly right *for the approach it assumed*. Canonical rebuild
is what removes it.

> Two figures in earlier drafts are superseded. **`AUTH` nonce/dynamic is 132 bytes, not 131** — the
> header is 3 bytes (`3+32+1+32+64`). The 131 figure appears in `D3`, `12-RESEARCH-wire-qr.md`,
> `experiments/README.md` and, most visibly, the demo caption track in `51-DEMO-SCRIPT.md`. Likewise
> `INTENT` on the nonce path is **76 bytes, not 75**. QR versions are unchanged; only the numbers in
> prose were wrong. The baseline row is 525 B (with `createAssociatedTokenAccountIdempotent`); the
> 483 B figure quoted elsewhere is the same transaction **without** it.

Re-measured on 2026-09-11 with `qrcode@1.5.4`: every version in the table reproduces. **The table assumes
one explicit alphanumeric segment, and `renderQr` MUST encode exactly that** (D36). Left to segment the
string itself, the encoder turns the digit run in every nonce-path `INTENT` — the zero high bytes of a
u64 amount — into a numeric segment. That changed no version in 4,000 encodings per payload type, but
nothing guarantees it.

---

## Receive rules — all MUST

Rules 1–7 were the original set; 8–13 close the gaps two reviews found. Together they are the
security model, not validation garnish. They were titled "decoder rules", but four need state or code
the codec does not have, so each rule now names the layer that enforces it (D30). A rule enforced in
the wrong layer is not enforced.

| # | Rule | Enforced by |
|---|---|---|
| 1 | Reject `version != 0x01` | `wire` |
| 2 | Reject any reserved `flags` bit (5–7) set | `wire` |
| 3 | Reject a payload whose length does not exactly match the length table above for its `(type, flags)`. No trailing bytes, no short reads | `wire` |
| 4 | Reject a mint absent from the local compatibility cache | `wire` — `decodeIntent`, `decodeStaticIntent` |
| 5 | Reject `decimals`, or a `TOKEN_2022` flag, that disagrees with the cached mint record | `wire` — `decodeIntent`, `decodeStaticIntent` |
| 6 | On `AUTH`, reject if `flags` does not byte-equal the flags of the intent being answered | `wire` — `decodeAuth`, from `DecodeContext.intentFlags` |
| 7 | Verify the signature against a **locally rebuilt** message. Never against anything received | `core.verifyAuth` |
| 8 | Reject any forbidden `(type, flags)` combination in the table above, with the error the check order yields | `wire` |
| 9 | **Reject `feePayer == payer`.** Nothing else prevents a merchant from pushing the transaction fee and the ATA rent onto a payer the product promises does not need SOL to pay. The codec never holds both addresses, so this lives where both are known. Moot while `FEE_PAYER_SEPARATE` is unsupported; load-bearing the moment it is not | `core.verifyAuth` (merchant) and `core.signAsPayer` (payer refuses an intent that names itself) |
| 10 | **Never trim or normalise the scanned string** before base45-decoding it (transport MUST 2) | `wire` — `qr-scan`, and every app path that touches the string |
| 11 | **Reject a base45 string containing any character outside the RFC 9285 alphabet, any length where `len % 3 == 1`, and any 3-character group above `0xFFFF`, and any 2-character tail above `0xFF`** (D37), with `WIRE_BASE45_INVALID`. Do not let an out-of-alphabet character map to −1 and propagate arithmetically | `wire` — `base45` |
| 12 | **On `NONCE_RETURN`, verify the signature against the merchant recorded in the payer's own ledger for that slot, over the statement reconstructed from the payer's own address and recorded prior value** — never against a key or value supplied by the payload (D28) | `client` `Pool.applyNonceReturn` looks up the record; `core.verifyNonceReturn` verifies |
| 13 | **The merchant MUST deduplicate incoming `AUTH` payloads against every payment it has ever accepted, in any state**, on the key in D31: `(payer, nonceIndex, nonceValue)` on the nonce path, `(payer, sha256(messageBytes))` on the fresh path. `buildMessage` is a pure function of its inputs, so two identical purchases produce a **byte-identical** message and `AUTH`. Without this rule a payer shows the same QR twice — or re-shows a settled one to an offline merchant — and receives goods twice while only one transaction ever settles. Rule 6 does not help: the `AUTH` carries no reference to which intent it answers | `client/queue.ts` |

Rules 3, 7, 9 and 13 are what make the format safe against a hostile counterparty. **Rule 7 is why
`VadumInfo.md` §5.7's instruction-injection attack cannot exist in this design:** no side ever
accepts a transaction it did not build itself.

### Check order — normative (D30)

Every codec entry point applies these steps in order, starting from the first step that applies to
its input, and raises the first failure. A payload breaking two rules therefore has exactly one
correct error, and the negative fixtures in `24-SPEC` are written against this order.

| Step | Check | Error |
|---|---|---|
| 1 | base45 alphabet, `len % 3 != 1`, every group ≤ `0xFFFF`, a 2-character tail ≤ `0xFF` | `WIRE_BASE45_INVALID` |
| 2 | at least 3 bytes | `WIRE_LENGTH_MISMATCH` |
| 3 | `version == 0x01` | `WIRE_VERSION_UNSUPPORTED` |
| 4 | `type` known; for a typed decoder, equal to its own type | `WIRE_UNKNOWN_TYPE`, then `WIRE_UNEXPECTED_TYPE` |
| 5 | bits 5–7 clear | `WIRE_RESERVED_FLAG_SET` |
| 6 | bit 3 clear | `WIRE_FEE_PAYER_SEPARATE_UNSUPPORTED` |
| 7 | no flag forbidden for this type | `WIRE_FLAG_NOT_ALLOWED_FOR_TYPE` |
| 8 | static constraints | `WIRE_STATIC_CONSTRAINT` |
| 9 | exact length for `(type, flags)` | `WIRE_LENGTH_MISMATCH` |
| 10 | `AUTH` flags equal `DecodeContext.intentFlags` | `WIRE_FLAGS_MISMATCH` |
| 11 | mint cached, then decimals, then token program | `MINT_UNKNOWN`, `MINT_DECIMALS_MISMATCH`, `MINT_TOKEN_PROGRAM_MISMATCH` |

### What the decoder cannot check, and must not pretend to

An offline decoder **cannot** verify that the nonce account named by `(payer, nonceIndex)` exists, is
initialised, has the payer as its authority, or currently holds `nonceValue`. A valid-looking `AUTH`
can therefore be produced by an attacker with no on-chain presence at all (`30-THREAT-MODEL.md` T6,
`01-DECISIONS.md` D21). The online pre-check in tiers T0 and T1 is what closes this, and it is an RPC
call, not a decoder rule — `client/queue.ts` refuses a T1 acceptance without a passing verdict (D30).
Do not add a rule here that implies otherwise.
