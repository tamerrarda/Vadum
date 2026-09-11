# Vadum — Planning Workspace

> Offline stablecoin payments on Solana. Source of truth for the idea: `../VadumInfo.md` — read it
> together with `03-VADUMINFO-ERRATA.md`, which lists every claim in it known to be wrong.
> This folder turns that document into something parallel coding sessions can execute without
> talking to each other.

**Working language:** planning docs and all shipped artifacts are in English. Discussion happens in Turkish.

---

## Why this folder exists

The build runs as **one bootstrap session followed by three parallel Claude Code sessions**.
Parallelism only works if every interface between them is frozen *before* anyone writes a line. That
means:

- exact TypeScript signatures for all three packages (`22`, `25`, `26`)
- exact byte layouts, receive rules and the order checks run in (`21-SPEC-wire-format.md`)
- exact error codes (`23-SPEC-errors.md`)
- **golden test vectors** (`24-SPEC-fixtures.md`), generated independently by Stream 0, so streams B
  and C can build against known-good bytes before stream A has finished producing them

If a coding session has to make a design decision, this folder failed. Every such decision belongs in
`01-DECISIONS.md` with its rationale, and every unknown belongs in `02-OPEN-QUESTIONS.md` until it is
answered with evidence.

---

## Reading order

| # | File | Purpose |
|---|---|---|
| 00 | `00-INDEX.md` | This file |
| 01 | `01-DECISIONS.md` | Every locked decision, ADR-style. **Read before coding.** |
| 02 | `02-OPEN-QUESTIONS.md` | Question tracker. No blocking `OPEN` may remain at spec freeze. |
| 03 | `03-VADUMINFO-ERRATA.md` | Corrections to `VadumInfo.md`, pending owner approval |
| 10 | `10-RESEARCH-solana.md` | Kit API, nonce internals, message compilation, fee semantics |
| 11 | `11-RESEARCH-tokens.md` | SPL Token vs Token-2022, extensions, ATA derivation, mint compatibility |
| 12 | `12-RESEARCH-wire-qr.md` | base45, QR capacity, scanning APIs |
| 13 | `13-RESEARCH-pwa.md` | Offline runtime, service worker, storage, camera |
| 14 | `14-RESEARCH-prior-art.md` | Updated competitive scan (supersedes VadumInfo §8) |
| 20 | `20-ARCHITECTURE.md` | Packages, dependency graph, ownership boundaries |
| 21 | `21-SPEC-wire-format.md` | **Normative.** QR payload byte layouts, receive rules, check order |
| 22 | `22-SPEC-core-api.md` | **Normative.** `@vadum/core` TypeScript contract |
| 23 | `23-SPEC-errors.md` | **Normative.** Shared error taxonomy |
| 24 | `24-SPEC-fixtures.md` | **Normative.** Golden vectors |
| 25 | `25-SPEC-wire-api.md` | **Normative.** `@vadum/wire` TypeScript contract |
| 26 | `26-SPEC-client-api.md` | **Normative.** `@vadum/client` TypeScript contract |
| 30 | `30-THREAT-MODEL.md` | Consolidated threat model + mitigations |
| 31 | `31-PARAMETERS.md` | Concrete numbers: caps, pool size, windows, timeouts |
| 32 | `32-MEASUREMENT-METHOD.md` | **Not yet written** (WIRE-6). Required before Stream B's B5 and before any measurement data |
| 39 | `39-STREAM-0-bootstrap.md` | Session 0 task list: bootstrap, fixture generator, Phase 0 |
| 40 | `40-STREAM-A-core.md` | Session A task list |
| 41 | `41-STREAM-B-wire-client.md` | Session B task list |
| 42 | `42-STREAM-C-apps.md` | Session C task list |
| 50 | `50-INTEGRATION.md` | Branch order, gates, integration tests, definition of done |
| 51 | `51-DEMO-SCRIPT.md` | The two-phone airplane-mode video |
| 60 | `60-PHASE0-derisk.md` | The live-chain proof that must pass before spec freeze |

---

## Execution order

```
  OWNER PREREQUISITES  (OPS-6)
  Node ≥ 24 · repository initialised · devnet key funded
        │
        ▼
  STREAM 0  (one session, sequential — D33)
  bootstrap ──┬── fixture generator  (no chain)
              └── Phase 0 on devnet  (D35 assertions)
        │
        ▼
  SPEC FREEZE  (G0) — 21–26 frozen, fixtures committed, Phase 0 passed,
                      no blocking OPEN in 02; later changes need every stream to agree
        │
        ▼
  A0 STUBS on main  (Stream A, within the hour)
        │
        ├──────────────┬──────────────┐
        ▼              ▼              ▼
    STREAM A       STREAM B       STREAM C
    core           wire+client    apps
    (pure TS)      (QR+RPC)       (two PWAs)
        │              │              │
        └──────────────┴──────────────┘
                       ▼
                 INTEGRATION → DEMO
```

**Phase 0 is not optional.** If its assertions do not pass, no amount of planning downstream is worth
anything. It gates spec freeze and the three streams — not the fixture generator, which needs no chain
and runs alongside it.
