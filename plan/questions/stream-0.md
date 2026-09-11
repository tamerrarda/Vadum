# Stream 0 — questions and change requests

Append-only. Reconciled into `02-OPEN-QUESTIONS.md` at integration.

---

## 2026-09-11 · Choices made during bootstrap (tasks 0.1–0.2), recorded rather than decided silently

| Choice | Why |
|---|---|
| Every version pinned through a pnpm `catalog:` in `pnpm-workspace.yaml` | D1's "pin together, bump together" becomes one file, and `check:solana-versions` enforces the result |
| Tooling: TypeScript 7.0.2, Vitest 5.0.0, Vite 8.3.0, pnpm 11.1.2 | Latest published on 2026-09-11; pnpm matches the owner's installed version |
| Workspace packages export their TypeScript sources (`exports` → `./src/index.ts`) and type-check with `noEmit` | Vite, Vitest and Node 24's type stripping all consume sources directly. The publish build belongs to the v1 release (D27); `release.yml` says so |
| `tsconfig.base.json` adds `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and `erasableSyntaxOnly` to `strict` | Checked indexing suits byte-level code; `verbatimModuleSyntax` makes `wire`'s types-only imports from `core` explicit; erasable-only syntax lets Node run the fixture generator with no build step |
| `core` source-size budget: 64 KiB, excluding tests | `20-ARCHITECTURE.md` asks for a size check "small enough to read" without a number; source bytes are the readable quantity |
| The G1 stub check matches `new VadumError('INTERNAL_NOT_IMPLEMENTED'`, not the bare string | The code is a legitimate member of the `VadumErrorCode` union in `errors.ts`, so the bare string can never be absent |
| `SECURITY.md` points at GitHub private vulnerability reporting instead of an email address | No disclosure address was decided. **Owner action:** enable private vulnerability reporting when the repository goes public — GitHub offers it only on public repositories (OPS-7) |
| The local Zypp whitepaper copy in `plan/references/` is git-ignored | Third-party material, in a repository that is public from its first commit (D25) |
| Copyright line in `NOTICE`: "The Vadum Authors" | Avoids naming an individual; change it if the owner prefers a personal or organisational name |

---

## 2026-09-11 · Choices made while writing the fixture generator (task 0.3)

Spec findings from this task are S0-1 to S0-4 in `02-OPEN-QUESTIONS.md` (D36, D37). The rest were
choices within the spec, recorded here:

| Choice | Why |
|---|---|
| Pinned values are `base58(sha256(label))` for `vadum-fixtures:nonce-value`, `…:nonce-value-next`, `…:nonce-value-prev` and `vadum-fixtures:blockhash`, written out literally in `seeds.ts` | Opaque and reproducible, with no hand-typed blob to trust |
| Token-2022 instructions come from `@solana-program/token` with `programAddress` overridden | Byte-identical to the token-2022 package's own builders (S0-4), so either is conforming |
| `base45-double-space` searches amounts upward from 2,500,000; the first hit is 2,500,029 | 24-SPEC says "increment until one appears". Recorded so a regeneration that lands elsewhere is visibly a change |
| `bad-base45-whitespace-collapsed` records `WIRE_BASE45_INVALID` | What the reference decoder raises: a shifted group overflows before any wire check runs |
| Client-negative `limits` record T0's cap as u64 max | 31-PARAMETERS gives T0 no cap, and `QueueLimits.receiptCapByTier` needs a value for every tier |
| `bad-fee-payer-is-payer` stays one case, with `target: ["core.verifyAuth", "core.signAsPayer"]` and input keyed by entry point | Keeps the 24-SPEC case list intact while testing both enforcement points D30 names |
| Every generated value is self-checked before it is written: message and transaction lengths, the v0 marker, `isStatic` independence, signature validity, base45 round trip and prefix, QR versions against the 21-SPEC table, and the reference decoder raising exactly each negative's code | A generator bug fails in the generator, not in a stream's test suite |
