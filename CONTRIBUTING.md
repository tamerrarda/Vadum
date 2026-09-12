# Contributing

Vadum is an offline stablecoin payment system on Solana. The design is frozen in [`plan/`](plan/) and
the code implements it — so the first thing to know is that **`plan/` is normative**. If a change
contradicts a decision record in [`plan/01-DECISIONS.md`](plan/01-DECISIONS.md), the record has to
change in the same pull request, with a reason. Silently diverging from it is the one thing that makes
this codebase hard to trust.

## Getting a green tree

```sh
nvm use                  # Node from .nvmrc; 24.x is required (type stripping, and pnpm's catalog)
corepack enable
pnpm install --frozen-lockfile
pnpm verify              # typecheck, tests, fixture reproduction, and every repository invariant
```

`pnpm verify` is what CI runs. It must exit 0 before you open a pull request. Note that `pnpm -s`
hides `tsc` output — check the exit code, not the absence of text.

CI runs one thing more: `pnpm test:browser`, the Playwright suite in `apps/e2e` that drives both built
PWAs in a real browser (D40). It sits outside `pnpm verify` because it downloads a browser. Run it
whenever you touch either app:

```sh
pnpm -C apps/e2e exec playwright install --with-deps chromium   # once
pnpm build && pnpm test:browser
```

## What the checks are actually for

Each one exists because something could rot silently:

| Check | What breaks without it |
|---|---|
| `pnpm fixtures:check` | The golden fixtures stop reproducing from their committed seeds, so they pin nothing |
| `pnpm check:solana-versions` | Two versions of a `@solana/*` package, which breaks branded types at runtime (D1) |
| `pnpm check:fixtures-deps` | The fixture generator starts depending on the code it is supposed to check independently (D33) |
| `pnpm check:reference-imports` | A stream imports the generator's reference implementation instead of rebuilding the message (D33) |
| `pnpm check:no-stubs` | A stub body ships as if it were an implementation (gate G1, D34) |
| `pnpm build` | The scanner `.wasm` stops landing in `precache-manifest.json`, which is what makes offline scanning work on iOS (D10) |
| `pnpm audit` | A known advisory sits in the locked tree unnoticed |

## Dependencies

**A new runtime or development dependency needs a decision record** in `plan/01-DECISIONS.md` before
it lands. This is not ceremony: the whole product has to work with the radio off, every byte in the
QR is accounted for, and `packages/fixtures` is deliberately kept independent of `@vadum/*`. A
dependency chosen casually can undo any of those. Say what it is for, what it replaces, and what it
pulls in.

## Chain safety

- **Devnet only** (D16). Nothing in this repository targets mainnet, and no test or tool may.
- **Never commit a key.** `.devnet/` is git-ignored and stays that way. The fixture seeds carry a
  test-key warning that `pnpm check:test-keys` enforces.
- Anything on the durable-nonce path goes through
  `sendAndConfirmDurableNonceTransactionFactory`, never the blockhash confirmer (SOL-15).

## Pull requests

- One branch per logical change, named for it (`fix/scanner-empty-frame`, `feat/export-csv`).
- Commit messages describe the change: a short subject in the imperative, and a body when the *why*
  is not obvious from the diff. Tests that are expected to fail before the change and pass after it
  are worth more than a paragraph.
- Keep unrelated changes in separate pull requests, even small ones.
- Say what evidence you have. "Verified on devnet, log in `plan/references/`" and "covered by a new
  test in `packages/wire/test/`" are claims a reviewer can check; "should work" is not.

## Reporting a vulnerability

Do not open an issue. Follow [`SECURITY.md`](SECURITY.md) — GitHub's private vulnerability reporting
is enabled on this repository.
