# Stream A — questions and change requests

Append-only. Reconciled into `02-OPEN-QUESTIONS.md` at integration. Requests for changes outside
`packages/core/**` go here; keep coding against the frozen interface meanwhile.

---

## 2026-09-11 · Spec gaps met while implementing core, and how core fills them

None of these changes a frozen signature. Each is a choice inside the spec, recorded so integration can
confirm or overturn it.

| # | Gap | What core does | Needs a spec change? |
|---|---|---|---|
| A-1 | `evaluateMint`'s blocker list has no entry for a **non-transferable** mint (`nonTransferable` extension). Every transfer from such a mint fails at execution, charging the merchant and burning the slot | It falls under `unknown-extension`: a warning, as the spec requires for anything it does not recognise | **Yes, requested:** add `non-transferable` to `MintBlocker`. Also worth deciding: `pausableConfig` with `paused: true` is only a warning today |
| A-2 | 22-SPEC says `mutable` follows "the defaultAccountState authority", but the extension has no authority field. The mint's **freeze authority** changes the default state | `defaultAccountState` present and `freezeAuthority` non-null → mutable | No — confirm the reading |
| A-3 | Live USDG and PYUSD carry `confidentialTransferFeeConfig`, which TOK-3 does not list. TOK-3 also marks `confidentialTransferMint` ALLOW, while `MintWarning` has `confidential-transfer` | Both extensions raise the `confidential-transfer` warning and neither blocks. They are not reported as `unknown-extension` | No — confirm |
| A-4 | `transferFeeConfig` holds an older and a newer fee, and an offline device cannot know which epoch applies | Blocks when **either** fee has a non-zero basis-point rate. An unreadable rate blocks too | No — confirm |
| A-5 | `evaluateMint` "will reject" a non-jsonParsed shape, but no code is named | Throws `MINT_INCOMPATIBLE` with `blockers: []` and a `reason` | Maybe — a dedicated code would read better than an empty blocker list |
| A-6 | No codes for programmatic misuse: a key that is not the payer (`signAsPayer`), an intent whose `isStatic` disagrees with whether it carries an amount, an amount outside u64, decimals outside u8, a lifetime that disagrees with `nonceRef` | `CANON_ACCOUNT_MISMATCH`, `CANON_AMOUNT_MISMATCH` or `MINT_DECIMALS_MISMATCH`, each with a `reason`. A lifetime/`nonceRef` disagreement throws `INTERNAL_NOT_APPLICABLE` from the lifetime provider | No |
| A-7 | In dynamic mode, 22-SPEC calls `expectedAmount` "redundant but harmless" without saying what a disagreeing value does. It also says nothing about an `Auth` that carries an amount on a dynamic intent, which the wire forbids | `CANON_AMOUNT_MISMATCH` in both cases. A disagreeing expectation and a second amount are refused, never ignored | No — confirm |
| A-8 | `buildWireTransaction` is called with a key that is not the fee payer | `SIG_FEE_PAYER_MISSING`, before signing | No |
| A-9 | Invariant 3 says every throw is a `VadumError`. Kit errors on malformed input are mapped wherever hostile input can reach them: `verifyAuth` turns a payer address that is not a public key into `SIG_INVALID`, and `verifyNonceReturn` turns every failure into `NONCE_RETURN_UNTRUSTED`. Paths reached only by the caller's own programming error still pass kit's error through: an address string that is not 32 bytes of base58 (a typed `Address` cannot be one), a key that is not Ed25519, or a `VerifiedPayment` whose `messageBytes` do not decode | Left as is | Maybe — a generic `INTERNAL_` code would let core wrap them |
| A-10 | TOK-3 hard-blocks `defaultAccountState: frozen` **for the create-ATA branch only**. `MintBlocker` has a single mint-level `default-account-state-frozen`, and `evaluateMint` cannot see which branch a payment takes | Blocks the mint whenever the default state is anything but `initialized`, on both branches | Maybe — a branch-scoped verdict would let a merchant whose ATA already exists and is thawed keep accepting that mint |

A0's separate stub commit was skipped because Streams B and C were not running. The stub protocol
exists to unblock them; they branch from the finished core instead.
