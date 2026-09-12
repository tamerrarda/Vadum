# Architecture

Package boundaries exist to make parallel sessions possible. **Each stream owns disjoint
directories.** No two streams write the same file.

---

## Dependency graph

```
                      apps/payer          apps/merchant        ← Stream C
                           │                     │
                           └──────────┬──────────┘
                                      │
                          packages/client ──▶ packages/wire     ← Stream B
                          (RPC, pool,         (codec, base45,
                           queue, submit)      QR encode/scan)
                                      │        │ types only
                                      └────┬───┘
                                           │
                                    packages/core               ← Stream A
                              (canonical builder, validator,
                               signing, verification, errors)
                                           │
                        @solana/kit · @solana-program/{system,token,token-2022}


                                  packages/fixtures             ← Stream 0
                        (independent generator + committed vectors;
                         imported only by tests; imports no @vadum/*)
```

Direction is strict: `apps → client → core`, `client → wire`, and `wire → core` for types only.
`core` imports nothing from the project. `wire` never imports `client`. `packages/fixtures` imports
nothing from the project and is imported only by test code. There are no cycles and no back-edges.

---

## Packages

### `packages/core` — Stream A

Pure TypeScript. **No network access, no I/O, no clock, no browser APIs.** Everything here is a
function of its arguments. This is what makes the whole system auditable and testable, and it is the
package a reviewer will actually read.

| Module | Responsibility |
|---|---|
| `canonical.ts` | `buildMessage()` — the single builder both sides call. The heart of the system |
| `nonce-provider.ts` | The lifetime mechanism behind an interface — the deprecation hedge (D17) |
| `derive.ts` | Nonce account address, ATAs, token program resolution |
| `validate.ts` | Strict instruction whitelist; `evaluateMint` and `assertMintCompatible` as pure functions over mint data |
| `sign.ts` | Payer signing, offline verification (receive rules 7 and 9), fee-payer signing |
| `nonce-return.ts` | The signed recovery statement — sign and verify (D20, D28) |
| `errors.ts` | The shared error taxonomy (`23-SPEC-errors.md`) |
| `types.ts` | `Intent`, `Auth`, `NonceRef`, `MintRecord`, `PaymentTier`; re-exports kit's `Address`, `Nonce`, `Blockhash` as types |

Dependencies: `@solana/kit`, `@solana-program/system`, `@solana-program/token`,
`@solana-program/token-2022`, and `@solana/sysvars` pinned explicitly — `token-2022` peer-depends on
it, and a default install otherwise resolves a second `@solana/*` version beside kit's own (D1).
**Nothing else.** A pull request adding a dependency to `core` needs a reason in `01-DECISIONS.md`.

### `packages/wire` — Stream B

| Module | Responsibility |
|---|---|
| `base45.ts` | RFC 9285, **vendored** (D12) |
| `codec.ts` | Encode/decode the four payload types of `21-SPEC-wire-format.md`; receive rules 1–6, 8, 10 and 11 in the normative check order (D30). Structural only — never verifies a signature |
| `qr-encode.ts` | Render, and **report the chosen version, EC level and segment mode** for the measurement deliverable |
| `qr-scan.ts` | `BarcodeDetector` with `zxing-wasm` fallback (D10), same-origin `.wasm`, engine reported per read |
| `measure.ts` | The measurement harness: read-success rate and time-to-read distribution, per engine |

Imports **types only** from `core`. The codec must not depend on the builder. Runtime dependencies:
`@solana/kit` for address codecs, and `qrcode@1.5.4` and `zxing-wasm@3.1.3`, both pinned exactly —
the QR versions recorded in the fixtures are the pinned encoder's output.

### `packages/client` — Stream B

| Module | Responsibility |
|---|---|
| `rpc.ts` | Kit RPC wiring, endpoints, rent lookup (D7), and the one `Address` → `Nonce` conversion (D34) |
| `nonce-check.ts` | `precheckNonce` — the fabricated-nonce mitigation (D21) |
| `pool.ts` | Nonce pool lifecycle — payer-funded creation (D26), refresh, reconcile, close — and **sole owner of slot state**: `reserveSlot`, `applyNonceReturn` (D32) |
| `mint.ts` | Fetch mint + extensions as `jsonParsed`, produce a `MintRecord`, staleness by mutability (D22) |
| `queue.ts` | Merchant queue: persist, dedupe (D31), T1 pre-check enforcement (D30), batch-submit, retry, exposure and failed-send counters |
| `submit.ts` | Fee-payer signing and submission with the durable-nonce confirmer (SOL-15) |
| `store.ts` | The `KeyValueStore` seam, plus an in-memory implementation for tests |

### `packages/fixtures` — Stream 0

The golden vectors of `24-SPEC-fixtures.md` and the deterministic script that produces them. An
**independent reference implementation** (D33): it depends on `@solana/kit`, the program packages and
`qrcode` directly, and on no `@vadum/*` package. Committed, never hand-edited.

### `packages/integration` — added at integration

Private, test-only, and the home of the eleven integration tests of `50-INTEGRATION.md`, which cross
every package and therefore belong to none of them. Gate **G3** lives here — reserve, sign, encode,
render a QR, read it back through the real scanner, decode, verify, settle, recover the slot, all in one
process with no network and no camera — together with the device-free scenarios: the race, the execution
failure, the fabricated nonce, the duplicate `AUTH`, eviction, reconciliation, the mint block and every
cap. Its `fake-chain.ts` spends a nonce value exactly once, which is what makes the race a race. Output
in `plan/references/integration-tests.md`; the same paths run against devnet from `tools/devnet-b`.

### `apps/payer`, `apps/merchant` — Stream C

PWAs (D2). Camera, service worker, the IndexedDB `KeyValueStore` with its `localStorage` mirror and
pool epoch marker, RECOVERY detection, the standalone-mode gate (`13-RESEARCH-pwa.md`), all UI and copy.

`apps/shared` is the runtime both apps import, so they cannot drift on the things that matter: the
store and the epoch marker, the non-extractable Ed25519 identity (D9), the standalone gate, the failure
copy for every user-facing error code (C7), amount formatting, and the UI primitives. **It holds no
test doubles.** C0.5 planned fixture-backed fakes of `core`, `wire` and `client` there for the days
before those packages landed; all three landed first, so the fakes were never written — recorded as C-1
in `plan/questions/stream-c.md`.

---

## File ownership — the rule that prevents merge conflicts

| Path | Owner |
|---|---|
| root configs, `pnpm-workspace.yaml`, `tsconfig.base.json`, CI, `LICENSE`, `NOTICE`, `SECURITY.md` | **Stream 0.** Frozen after bootstrap; later changes are requested through `plan/questions/` |
| `packages/fixtures/**` | **Stream 0.** Generated and committed, never hand-edited |
| `tools/**` | **Stream 0.** `tools/phase0`, the Phase 0 script, which builds payments with the generator's reference modules (`@vadum/fixtures/reference`) that no stream may import — `pnpm check:reference-imports`. Joined at integration by `tools/devnet-b`, which runs Stream B's B6–B10 clauses against devnet through the real packages instead |
| `packages/integration/**` | Nobody while the streams run; added at integration. Test-only, and the one place allowed to import from every package at once |
| `packages/core/**` | Stream A only |
| `packages/wire/**`, `packages/client/**` | Stream B only |
| `apps/**` | Stream C only |
| `plan/questions/stream-{0,a,b,c}.md` | That stream only — questions and cross-package change requests are appended here |
| everything else under `plan/` | Nobody while the streams run. The specs are frozen; `02-OPEN-QUESTIONS.md` is reconciled from `plan/questions/` at integration |

If a stream needs a change in another stream's package, it does not make the change. It appends the
request to its own `plan/questions/stream-*.md` and codes against the frozen interface in the
meantime.

---

## How the streams stay unblocked

Stream C depends on both A and B, and Stream B depends on A. Sequentially that is three weeks of
waiting. It is avoided by three things, all in place **before** A, B and C start writing behaviour:

1. **`22`, `25` and `26` — the exact TypeScript signatures of all three packages.** B and C write
   against interfaces, not implementations. Stream A lands throwing stubs on `main` within its first
   hour, and B and C branch from that commit.
2. **`24-SPEC-fixtures.md` — golden vectors from an independent generator.** For fixed inputs: the
   exact canonical message bytes, the exact wire payloads, valid signatures, and thirty-three negative
   cases. **B can build and test the entire codec against fixtures alone, before `core` works.**
3. **Stream C's fixture-backed fakes** (C0.5), so C's second day is not every button throwing
   `INTERNAL_NOT_IMPLEMENTED`. *In the event this was never needed: A and B landed before C started, so
   `apps/shared` holds the real runtime and no fake was written (C-1).*

The fixtures are the contract, and CI failing on them is CI telling you a stream broke the contract.

---

## Tooling

| | |
|---|---|
| Package manager | pnpm workspaces |
| Language | TypeScript, `strict: true`, ES modules only |
| Test runner | Vitest |
| App build | Vite (both PWAs) |
| Node | **≥ 24.** `@solana-program/token` and `token-2022` declare `engines.node >=24.0.0` (D1); kit alone would allow 20.18 |

CI on every push: typecheck, unit tests, **golden fixture comparison**, fixture regeneration diff, the
single-version check for `@solana/*`, the no-`@vadum/*` check on `packages/fixtures`, a bundle-size check
on `core` (it must stay small enough to read), the gate-G1 check that no stub body survives in
`packages/core/src`, and **a build of both PWAs** — because the build is what proves the scanner's
`.wasm` reaches `precache-manifest.json`, and D10's offline guarantee rests on that file. `pnpm verify`
runs the same list locally.
