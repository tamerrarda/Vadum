# Stream 0 — bootstrap, fixtures, Phase 0

**One session, sequential, before Streams A, B and C branch** (D33). You own the repository root,
`packages/fixtures/**`, and the new Phase 0 script. Nothing in `packages/core`, `packages/wire`,
`packages/client` or `apps/` is yours.

Read first: `01-DECISIONS.md` (all of it), `20-ARCHITECTURE.md`, `21-SPEC-wire-format.md`,
`22-SPEC-core-api.md`, `24-SPEC-fixtures.md`, `60-PHASE0-derisk.md`, `10-RESEARCH-solana.md`.

Questions and change requests go to `plan/questions/stream-0.md`, never into the specs.

---

## Prerequisites — owner actions, not yours (`OPS-6`)

- **Node ≥ 24** on the build machine (D1). If `node -v` is lower, stop; do not add engine overrides.
- **The repository exists** at `github.com/tamerrarda/Vadum` (D25), and the current workspace —
  `plan/` included — is committed before anything changes, so "spec freeze" has a commit to point at.
- **A devnet keypair holding at least 0.5 SOL**, passed to Phase 0 with `--merchant-key` (D15).
  Needed only by task 0.5.

Tasks 0.1–0.4 need no chain and can start without the key.

---

## 0.1 · Repository bootstrap

- `pnpm-workspace.yaml` covering `packages/{core,wire,client,fixtures}` and `apps/{payer,merchant}`.
  Each package gets its name (`@vadum/core`, `@vadum/wire`, `@vadum/client`, `@vadum/fixtures`),
  `"type": "module"`, an `exports` map, and `engines.node >=24`.
- Pinned exactly, together: `@solana/kit@8.0.0`, `@solana-program/system@0.14.0`,
  `@solana-program/token@0.16.0`, `@solana-program/token-2022@0.16.0`, and `@solana/sysvars` at the
  version kit 8.0.0 itself resolves (D1). `qrcode@1.5.4` and `zxing-wasm@3.1.3` in `wire`.
- `tsconfig.base.json` with `strict: true`; Vitest at the root; Vite in both apps.
- `LICENSE` (Apache-2.0), `NOTICE`, `SECURITY.md` with a disclosure address (D25), and a README whose
  first screen states the honest limits: devnet and base fee only (D16), no secure element (D9).
- `vadum`, `@vadum/core`, `@vadum/wire` and `@vadum/client` published as `0.0.0` placeholders pointing
  at the repository; the release job written and wired but not triggered (D27).
- Empty `plan/questions/stream-{0,a,b,c}.md`.

**Done when:** `pnpm install` on Node 24 prints no `EBADENGINE`, and `pnpm -r typecheck` passes on the
empty packages.

## 0.2 · CI

Every push runs: typecheck; unit tests; the fixture CI rule from `24-SPEC` (checks for packages that
do not exist yet are skipped per package, not deleted); the regeneration diff; the check that no two
`@solana/*` versions coexist in the lockfile (D1); the check that `packages/fixtures` depends on no
`@vadum/*` package (D33); the grep for the test-key warning in `seeds.ts`; and a bundle-size budget for
`core`. Gate G1 additionally fails on the string `INTERNAL_NOT_IMPLEMENTED` in `packages/core/src`
(D34).

**Done when:** a deliberately corrupted fixture file fails CI, and so does adding `@vadum/core` as a
dependency of `packages/fixtures`.

## 0.3 · The fixture generator — the critical path for every stream

`packages/fixtures/src/generate.ts` and `seeds.ts`, exactly per `24-SPEC`. This is an **independent
reference implementation** of the canonical builder, the four payload encoders, base45, the QR sizing
and the `NONCE_RETURN` statement — written from the specs, importing no `@vadum/*` package.

Watch in particular:

- `createTransactionMessage({ version: 0 })`; `createNoopSigner(payer)` as the transfer authority;
  `createNoopSigner(intent.feePayer)` as fee payer and ATA funder (D14, D18, D19).
- The 118-byte `NONCE_RETURN` statement with its domain tag (D28).
- `base45-double-space`: increment `amount` from 2,500,000 until the `AUTH`'s base45 contains two
  adjacent spaces, and record that amount (D29).
- Negative cases are built against the check order in `21-SPEC` (D30): set exactly the bits the table
  names, so exactly one step fails.

**Done when:** all eight positive and thirty-three negative cases are committed, a second run reproduces
the file byte-for-byte, and every QR version matches the table in `21-SPEC`.

## 0.4 · Retire the stale experiments

`plan/experiments/phase0-derisk.mjs` and `canonical-rebuild.mjs` predate D14, D19, D26, D35 and SOL-15
(`plan/experiments/README.md`). Keep them as history. Do not extend them and do not copy their flow;
Phase 0 gets a new script.

## 0.5 · Phase 0 on devnet

Write `tools/phase0/src/phase0.ts` and run it, exactly per `60-PHASE0-derisk.md`: a payer-funded pool (D26);
`sendAndConfirmDurableNonceTransactionFactory` for successes on the nonce path (SOL-15); ASSERT B
against a **different** message signed on the same nonce value (D35); failures observed with
`skipPreflight: true`; and the execution-failure and fabricated-nonce observations.

**Done when:** the script prints its pass line, and `plan/references/phase0-log.md` records every
transaction signature, fee and error string the chain returned.

## 0.6 · Hand-off

Commit, tag the spec-freeze commit, and report G0's state against `50-INTEGRATION.md`. Stream A
branches first and lands the A0 stubs; B and C branch from that commit.

---

## Do not

Do not import `@vadum/*` into the generator. Do not hand-edit a fixture. Do not change a spec to make
the generator easier — raise it in `plan/questions/stream-0.md`. Do not depend on the devnet faucet
(D15). Do not start Stream A, B or C work.
