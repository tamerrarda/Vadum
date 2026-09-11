# Stream B — `@vadum/wire` and `@vadum/client`

**You own `packages/wire/**` and `packages/client/**`.** Requests for changes elsewhere go to
`plan/questions/stream-b.md`.

Read first: `01-DECISIONS.md`, `21-SPEC-wire-format.md` (memorise the receive rules and the check
order), `25-SPEC-wire-api.md`, `26-SPEC-client-api.md`, `23-SPEC-errors.md`, `24-SPEC-fixtures.md`,
`31-PARAMETERS.md`, `12-RESEARCH-wire-qr.md`.

**Branch from the commit where Stream A's A0 stubs landed** (`50-INTEGRATION.md`). From then on you
are not blocked by Stream A: every byte you need is in `packages/fixtures`. `wire` imports only
*types* from `core`; `client` calls `core` functions, and until they land you test `client` against
fixture values.

---

## B1 · `wire/base45.ts`

RFC 9285, **vendored** (D12 — locked; do not re-decide it).

**Done when:** output matches `^[0-9A-Z $%*+\-.\/:]+$`; random input round-trips; every fixture's
base45 string matches; the **negative** suite passes — out-of-alphabet, lowercase, `len % 3 == 1`, the
overflowing group `:::`, the overflowing tail `000::` (D37) — each raising `WIRE_BASE45_INVALID`; and both D29 properties hold (no output
ends with a space; every payload starts `W50`, `X50`, `Y50` or `Z50`). A suite that tests only valid
input would have passed with `base45@2.0.1`'s defects intact.

## B2 · `wire/codec.ts`

`peekPayloadType`, the four encode/decode pairs, `expectedLength`. Implement receive rules 1–6, 8, 10
and 11 **in the normative check order** (D30). Decoders are structural: `decodeNonceReturn` never
verifies a signature, and no decoder checks rule 7, 9, 12 or 13.

**Done when:** every positive fixture round-trips byte-exactly, intents and `AUTH`s alike, and all
twenty-one codec negative fixtures throw exactly their codes — `bad-static-fee-payer-separate` included,
which exists to test the order.

## B3 · `wire/qr-encode.ts`

Render with `qrcode@1.5.4` as one explicit alphanumeric segment (D36), and return version, EC level, matrix size and segment mode alongside the
image. The measurement deliverable needs those, so they are API, not debug output. Default EC-Q (D11).

**Done when:** measured versions match the table in `21-SPEC-wire-format.md` and every fixture's
`qrVersions`, and `segmentMode` is `alphanumeric` for every payload.

## B4 · `wire/qr-scan.ts`

`BarcodeDetector` where available, `zxing-wasm@3.1.3` otherwise (D10). `wasmUrl` is required and
same-origin — the library's default jsDelivr URL leaves the iOS scanner dead in airplane mode. **Report
which engine produced each read**, and return `rawText` untouched.

**Done when:** both engines decode a rendered `AUTH` payload with no network access, and the engine is
reported.

## B5 · `wire/measure.ts` — a grant deliverable, blocked on WIRE-6

**Do not start until `plan/32-MEASUREMENT-METHOD.md` exists.** A methodology written by the session
collecting the data is not a methodology, and designing it is not your task. If it is missing when
you reach B5, raise it in `plan/questions/stream-b.md` and move on.

**Done when:** it emits a reproducible report per the method, and the histogram of human-in-the-loop
round-trip times can be generated from it — per engine, never blended.

## B6 · `client/rpc.ts` and `client/mint.ts`

Kit RPC wiring, rent lookup (D7), and the **single** `Address` → `Nonce` conversion, in
`getNonceAccount` (D34). Mint fetch with `encoding: 'jsonParsed'`, `core.evaluateMint(raw, fetchedAt)`,
staleness by mutability (D22) — never a flat TTL block.

**Done when:** live devnet and mainnet USDC evaluate compatible and immutable; live USDG and PYUSD
evaluate compatible with warnings and `mutable: true`; a locally created mint with an active hook
returns `MINT_INCOMPATIBLE`.

## B7 · `client/nonce-check.ts`

`precheckNonce` — the entire technical answer to D21. Four checks in order; `INTERNAL_NOT_APPLICABLE`
for a fresh-path payment.

**Done when:** on devnet, a live pool slot returns `ok`, an advanced slot returns `stale`, and an
invented nonce under a throwaway payer returns `absent`.

## B8 · `client/pool.ts` and `client/store.ts`

Payer-funded creation with one signer (D26 — **no sponsor**) that refuses an underfunded wallet before
sending (D38), `refresh`, `close` with rent refunded to
the payer, and slot state as its single owner (D32): `reserveSlot` persists **before** resolving;
`applyNonceReturn` looks up the slot record and calls `core.verifyNonceReturn`; `reconcile` re-arms
settled slots, releases abandoned ones past the send window, and keeps pending ones spent. **Never
hardcode rent** — `getMinimumBalanceForRentExemption(getNonceSize())`. Ship the in-memory
`KeyValueStore`.

**Done when:** on devnet a pool of N is created, a slot is reserved, its nonce is advanced on chain,
`reconcile` re-arms it, and `close` refunds all rent; and offline, a `NONCE_RETURN` issued to another
payer leaves the pool unchanged.

## B9 · `client/queue.ts` — the hardest thing you own

Persist; dedupe on the D31 key against **every** accepted payment; enforce the T1 pre-check (D30);
batch-submit; retry; enforce the exposure and failed-send counters.

**`SUBMIT_NONCE_STALE`, `SUBMIT_NONCE_ABSENT` and `SUBMIT_EXECUTION_FAILED` must never be collapsed**
(D21). The failed-send counter increments on `SUBMIT_EXECUTION_FAILED` and `SUBMIT_NONCE_ABSENT` —
never on `SUBMIT_NONCE_STALE` or a transport failure. The merchant queue never touches payer slot
state, which lives on the payer's device (`23-SPEC`, "Where the payer's ledger is marked spent").

**Done when:** the three client negative fixtures throw their codes; all three submission failure
classes are produced deliberately on devnet and handled distinctly; and every limit in
`31-PARAMETERS.md` is enforced at its boundary with a test.

## B10 · `client/submit.ts`

Fee-payer signing and submission. **`sendAndConfirmDurableNonceTransactionFactory` on the nonce path,
`sendAndConfirmTransactionFactory` on the fresh path, never the reverse** (SOL-15). Classify failures
through `precheckNonce`. Return `newNonceValue` on success, for the merchant's `NONCE_RETURN` (D28).

**Done when:** a durable-nonce payment settles on devnet through `submit`, and its `newNonceValue`
equals the value read back from the nonce account.

---

## Do not

Do not construct Solana instructions — `core` does that. Do not verify signatures in `wire`. Do not
import from `apps`. Do not blend scanner engines in a reported number. Do not design the measurement
methodology. Do not depend on the devnet faucet (D15). Do not import `@vadum/fixtures/reference` — use
`@vadum/fixtures` for data only (D33).
