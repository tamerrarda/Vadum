# Vadum

Offline stablecoin payments on Solana. A payer whose phone has no network signs a payment; the
merchant verifies it offline and settles when it reconnects. Built on durable nonces, with no on-chain
program of its own.

> **Status: alpha, devnet only.** The three library streams and both reference apps are implemented and
> green in CI. What is not done: the on-device checks (airplane mode, iOS, storage wipe), the
> measurement report, and the demo video. See *What is verified* below — it is deliberately precise
> about which claims are backed by a live chain and which are not.

## Honest limits — read these first

- **Devnet only, base fee only.** v1 cannot express a priority fee and is not meant for congested
  mainnet (`plan/01-DECISIONS.md` D16).
- **No secure element.** Keys are non-extractable WebCrypto keys; on the polyfill path used by older
  browsers they live in the JavaScript heap (D9).
- **No light client.** A fully offline merchant cannot verify the payer's balance, or that a nonce
  account exists behind a payment at all. An attacker with no on-chain presence can produce an `AUTH`
  that verifies offline. The online pre-check closes this in tiers T0 and T1; **in T2 it is
  unmitigated**, which is why T2's caps are the lowest and its screen says so in plain words
  (`plan/30-THREAT-MODEL.md` T6, D21).
- **Caps are product-level, not protocol-level.** A modified merchant app can ignore them.
- **A payer can void queued payments** by advancing or closing their own nonce accounts (T7).
- **The payer needs no SOL to pay**, but creating a nonce pool takes a one-time, fully refundable
  deposit — about 0.0066 SOL on mainnet in September 2026, and falling (D26, D39). A wallet parked
  exactly at the rent-exempt floor cannot pay a later fee, so the app funds the floor plus one fee.
- **A printed static code is exactly what gets covered over** by someone else's sticker (T5). Static
  mode requires the merchant to enter the price before scanning, or a payer could sign 0.01 for a 5.00
  item and the screen would still say verified (D30).

## What is verified

| Claim | How | Evidence |
|---|---|---|
| The primitive works on a live chain: a payment signed and verified entirely offline settles, and a second payment against the same nonce cannot | Phase 0, 17 steps on devnet | `plan/references/phase0-log.md` |
| The libraries settle real payments, and the three submission failure classes are three distinct observable events | `pnpm devnet:b`, 13 steps on devnet through `core`, `wire` and `client` | `plan/references/stream-b-devnet-log.md` |
| The whole air gap works without devices: reserve, sign, encode, render a QR, **read it back through the scanner**, decode, verify, settle, recover the slot | Gate G3, in one process with no network and no camera | `packages/integration/test/loopback.test.ts`, output in `plan/references/integration-tests.md` |
| The race, the execution failure, the fabricated nonce, the duplicate `AUTH`, eviction, reconciliation, the mint block and every cap behave as specified | The integration scenarios of `plan/50-INTEGRATION.md` | `packages/integration/test/scenarios.test.ts`, output and what the three key ones assert in `plan/references/integration-tests.md` |
| Every byte on the wire is reproduced by a second implementation of the spec | Golden fixtures, regenerated and compared in CI (D33). They import no `@vadum/*` package, but they share kit and the program packages with `core` — so they pin **determinism**, not correctness. The correctness evidence is Phase 0, where a validator executed those bytes | `packages/fixtures/fixtures.json`, `plan/references/phase0-log.md` |
| Every user-facing error code has copy, and the unreassuring ones stay unreassuring | A test that fails if a code has none | `apps/shared/test/errors.test.ts` |
| Both apps behave in a real browser: a tab offers no way to sign, a marker without a ledger enters RECOVERY, the shell and every precached file — the scanner's `.wasm` included — come back with the network cut, and the merchant's offline cap is refused before any code is shown | Playwright in headless Chromium, against the built apps (D40) | `apps/e2e/test/`, and `apps/AIRPLANE-MODE-CHECKLIST.md` for what it deliberately cannot say |

**Not yet verified:** airplane-mode cold start and scanning on real devices, iOS, storage wipe →
RECOVERY on a device, and the QR read-success measurement. Headless Chromium covers a *weaker* form of
the cold start and of RECOVERY (D40) — not a real radio, not an installed app launched cold, not iOS,
and not the camera, which cannot be driven headlessly at all. The device checklist is
`apps/AIRPLANE-MODE-CHECKLIST.md`; the measurement method itself is still an open owner decision
(WIRE-6), and `wire/measure.ts` is deliberately not implemented until it exists.

## Repository layout

| Path | What |
|---|---|
| `packages/core` | Canonical message builder, validation, offline verification. No I/O, no clock |
| `packages/wire` | QR payload codec, base45 (vendored), QR render and scan |
| `packages/client` | RPC, nonce pool, mint cache, merchant queue, submission |
| `packages/fixtures` | Golden test vectors from a second implementation of the spec: no `@vadum/*` dependency, same kit version |
| `packages/integration` | Gate G3 and the cross-package scenarios |
| `apps/payer`, `apps/merchant` | Reference PWAs |
| `apps/shared` | Browser runtime both apps share: storage, keys, the standalone gate, failure copy |
| `tools/phase0`, `tools/devnet-b` | The two devnet verification runs |
| `plan/` | The design: decisions, specs, threat model, task lists. Start at `plan/00-INDEX.md` |

## Development

Requires **Node ≥ 24** (see `.nvmrc`) and pnpm.

```bash
nvm use
pnpm install
pnpm verify                   # typecheck, tests, fixture reproduction, repository checks
pnpm -C apps/payer dev        # either app, in a browser
pnpm -C apps/payer build      # build, then write the service worker's precache manifest
```

`CONTRIBUTING.md` says what each of those checks is protecting, and the one rule worth knowing up
front: `plan/` is normative, and a new dependency needs a decision record before it lands.

The devnet runs send real transactions and ask before doing so:

```bash
pnpm phase0   --merchant-key .devnet/merchant.json   # plan only; add --yes to execute
pnpm devnet:b --merchant-key .devnet/merchant.json   # plan only; add --yes to execute
```

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
