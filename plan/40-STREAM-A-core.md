# Stream A — `@vadum/core`

**You own `packages/core/**` and nothing else.** If you need a change elsewhere, append it to
`plan/questions/stream-a.md` and keep going against the frozen interface.

Read first: `01-DECISIONS.md`, `20-ARCHITECTURE.md`, `21-SPEC-wire-format.md`, `22-SPEC-core-api.md`,
`23-SPEC-errors.md`, `24-SPEC-fixtures.md`.

**You start after spec freeze (G0).** Stream 0 has bootstrapped the repository and committed the
fixtures in `packages/fixtures`; you read them and never regenerate them.

Your package is pure TypeScript with **no I/O and no clock**. No `fetch`, no RPC, no storage, no
`Date.now()` anywhere in the package. Dependencies are fixed by `20-ARCHITECTURE.md`; adding one needs
an entry in `01-DECISIONS.md`.

---

## A0 · Stub the whole API — do this first, within the hour

Commit every function and constant in `22-SPEC-core-api.md` with the correct signature and a
`throw new VadumError('INTERNAL_NOT_IMPLEMENTED')` body (D34), and land it on `main`. **Streams B and C
branch from that commit** — the one real ordering constraint between the streams
(`50-INTEGRATION.md`).

**Done when:** `pnpm -r typecheck` passes across all packages and both apps.

## A1 · `errors.ts`

`VadumError`, and every code in `23-SPEC-errors.md` as an explicit literal union — including
`WIRE_UNEXPECTED_TYPE`, `MINT_TOKEN_PROGRAM_MISMATCH`, `LIMIT_PRECHECK_REQUIRED` and both `INTERNAL_*`
codes.

**Done when:** every code is exported and covered by a type test that the union is exhaustive.

## A2 · `derive.ts`

`nonceSeed`, `deriveNonceAddress`, `deriveAta`, `tokenProgramAddress`.

The nonce address uses `createAddressWithSeed({ baseAddress: payer, programAddress: SystemProgram,
seed: nonceSeed(index) })`, which is async. ATA seeds include the token program — legacy and
Token-2022 give different addresses for the same owner and mint.

**Done when:** derived addresses match the `derived` block of every positive fixture.

## A3 · `nonce-provider.ts` and `canonical.ts` — the heart

`durableNonceProvider` and `freshBlockhashProvider` (D17), then `buildMessage` on top of them. The
provider method is async and non-generic (D34). Kit prepends `AdvanceNonceAccount` itself; never
construct it by hand, and never name it outside `nonce-provider.ts`.

The three MUSTs in `22-SPEC`: `version: 0` (D18), `createNoopSigner(payer)` as authority (D14),
`createNoopSigner(intent.feePayer)` as fee payer and ATA funder (D19).

**Done when:** `messageBytes` byte-equals `expected.messageBytes` for every fixture that compiles a
message — the six lifetime/program/ATA cases and `base45-double-space` — and 1000 randomised inputs
each compile identically twice in a row.

## A4 · `validate.ts`

`evaluateMint(raw, checkedAt)` (D34), `assertMintCompatible`, `assertCanonical`.

The blocker/warning table is `11-RESEARCH-tokens.md` TOK-3, including the freeze-authority and
mint-close-authority warnings; `mutable` follows D22. `assertCanonical` decodes the compiled message
and asserts exactly the expected instructions, accounts, mint, amount and destination — rejecting
anything else.

**Done when:** `bad-mint-hook-active` throws `MINT_INCOMPATIBLE` with the right blocker list, and
`assertCanonical` rejects a message with one extra instruction spliced in.

## A5 · `sign.ts`

`signAsPayer`, `verifyAuth`, `buildWireTransaction`.

`signAsPayer` refuses `feePayer == payer` (rule 9, D30) and calls `assertCanonical` on its own output
before signing; it never touches slot state, because the app reserves the slot first (D32).
`verifyAuth` **rebuilds** and verifies against the rebuilt bytes, enforces rule 9, and in static mode
requires `expectedAmount` (D30).

**Done when:** `verifyAuth` accepts every positive fixture; `bad-signature-tampered`,
`bad-fee-payer-is-payer`, `bad-static-amount-mismatch` and `bad-static-no-expected-amount` throw their
codes; and a mutated `intent` produces `SIG_INVALID` rather than a silent pass.

## A6 · `nonce-return.ts`

`NONCE_RETURN_DOMAIN`, `nonceReturnSigningBytes`, `signNonceReturn`, `verifyNonceReturn` (D20, D28).
The signature covers the 118-byte statement — domain tag, payer, index, prior value, new value — never
the payload bytes.

**Done when:** `nonceReturnSigningBytes` equals `expected.signingBytes`; `nonce-return-signed`
verifies; and all four `bad-nonce-return-*` fixtures throw `NONCE_RETURN_UNTRUSTED` — above all
`bad-nonce-return-other-payer`.

## A7 · Fixture harness

Load `packages/fixtures`, run the core half of the CI rule in `24-SPEC-fixtures.md`, wire it into CI.

**Done when:** CI fails loudly if a dependency bump changes a single message byte, and fails on any
surviving `INTERNAL_NOT_IMPLEMENTED`.

## A8 · Property tests

- Determinism: same input → same bytes over 1000 random inputs — including the same input with
  `intent.isStatic` flipped (`22-SPEC`, `CanonicalInput`)
- Round trip: `signAsPayer` → `verifyAuth` always succeeds
- Tamper resistance: flipping any single bit of `messageBytes` makes verification fail
- Whitelist: no instruction outside `{AdvanceNonce?, CreateAtaIdempotent?, TransferChecked}` survives
- Recovery binding: a `NONCE_RETURN` signed for one `(payer, prior value)` never verifies for any other
  (D28)

---

## Do not

Do not add network calls "just for a test". Do not import from `wire` or `client`. Do not change a
frozen spec — raise it. Do not regenerate or edit a fixture to make a test pass. Do not type a nonce
value as `Address` (D34). Do not import `@vadum/fixtures/reference` — use `@vadum/fixtures` for data only;
code tested against a copy of its own reference proves nothing (D33).
