# Phase 0 — De-risk

**Stream 0, task 0.5** (D33). **Passed on devnet on 2026-09-11 — `plan/references/phase0-log.md`.** Runs
before spec freeze and before Streams A, B and C. It does not
produce the fixtures — `packages/fixtures` does, with no chain (`24-SPEC-fixtures.md`) — and it does not
gate writing them.

The canonical rebuild and offline verification are already shown offline. Phase 0 proves what only a
live chain can: that an offline-signed, offline-verified payment lands; that **a different** payment
signed against the same nonce value cannot; and what the chain actually charges for each failure class
the error taxonomy depends on.

If Phase 0's assertions do not pass, nothing downstream is worth building. Do not skip it, and do not
start Streams A, B or C before it passes.

---

## Setup

- **Node ≥ 24** (D1).
- A devnet keypair with at least 0.5 SOL, passed with `--merchant-key` (D15). **Never depend on the
  public faucet** — it returns HTTP 429 under normal use (SOL-11).
- Pinned: `@solana/kit@8.0.0`, `@solana-program/system@0.14.0`, `@solana-program/token@0.16.0`.
- A **new** script: `tools/phase0/src/phase0.ts`, run as `pnpm phase0`. `plan/experiments/phase0-derisk.mjs`
  predates D14, D19, D26, D35 and SOL-15, and its ASSERT A could never have succeeded
  (`plan/experiments/README.md`); only its network guard and its `--dry`, `--merchant-key` and `--keep`
  options carried over. `--init-key .devnet/merchant.json` writes a throwaway key to a git-ignored path
  and prints the address to fund. **Nothing is sent without `--yes`**; without it the script checks the
  cluster's genesis hash and the balance, prints the plan, and stops.
- `--dry` runs the offline half — builder, byte-identical rebuild, offline verification, `AUTH`
  encoding, network guard — with no SOL. **Run it before every full pass.**

Actors: `merchant` (the funded key: fee payer and mint authority), `merchant2` (funded by `merchant`,
for the create-ATA branch), `payer` (fresh keypair), `ghost` (fresh keypair, never funded). The mint is
an own devnet test mint — 6 decimals, legacy SPL Token, no extensions (D24).

---

## Observation method — how a failure is actually observed

With preflight on, the RPC simulates a transaction and rejects a failing one before any validator sees
it. That rejection says nothing about fees or nonce advancement, so it cannot stand in for the chain's
behaviour.

| Observation | Method | Evidence |
|---|---|---|
| Success — steps 8, 16 | `sendAndConfirmDurableNonceTransactionFactory` (SOL-15) | Confirmed signature; balances |
| Validation failure — steps 11, 12, 15 | `simulateTransaction` to record the error string; then `sendTransaction` with `skipPreflight: true`, polling `getSignatureStatuses` for 60 s | The signature never appears; the fee payer's SOL balance and the nonce value are unchanged |
| Execution failure — step 14 | `sendTransaction` with `skipPreflight: true`; poll until confirmed | The status carries an `err`; the fee payer's balance dropped by the fee; the nonce value advanced |

Do not use the durable-nonce confirmer for steps 11, 12 or 15: it watches the nonce account and can
throw on the moved nonce before the chain's own behaviour has been observed.

---

## Steps

| # | Step | Watch for |
|---|---|---|
| 1 | Merchant creates the mint, creates the payer's and its own token ATAs, and mints tokens to the payer | — |
| 2 | Merchant sends the payer enough SOL for two nonce accounts, the fee, and the wallet's own rent-exempt minimum — without the last, simulation rejects the setup (D38). **Payer** creates slots 0 and 1: `createAccountWithSeed` (from = base = payer, seed `vadum-<i>`, space `getNonceSize()`, lamports `getMinimumBalanceForRentExemption(getNonceSize())`) + `initializeNonceAccount(authority = payer)` | **D26:** one signer, one signature. Record it |
| 3 | Payer sweeps any remaining SOL back to the merchant | **ASSERT:** the payer's wallet holds 0 SOL |
| 4 | Read slot 0 with `fetchNonce()` | The 80-byte layout; the value typed `Address`, converted once to `Nonce` (D34) |
| 5 | **Cut the network** — the guard throws on any RPC call. Build two canonical messages against slot 0's value: payment 1 for amount A, payment 2 for amount B ≠ A. `version: 0`, `createNoopSigner` for authority and fee payer (D14, D18, D19). The payer signs both | Two different messages, both signed offline |
| 6 | Encode both `AUTH` payloads per `21-SPEC` | 132 B each |
| 7 | Merchant rebuilds each from `(intent, auth)` **only** and verifies both offline | Both verify — the double-spend precondition |
| 8 | Restore the network. Merchant attaches the fee-payer signature to payment 1 and submits it as a success observation | Never the blockhash confirmer on this path |
| 9 | **ASSERT A:** payment 1 lands; the merchant's token balance rises by A; the payer's wallet still holds 0 SOL | SOL-12, observed on chain |
| 10 | Record the merchant's SOL balance and slot 0's value | — |
| 11 | **ASSERT B (D35):** submit payment 2 as a validation-failure observation. It never lands; the merchant's SOL balance is unchanged; slot 0's value is unchanged by it; `getAccountInfo` classifies the slot `stale` | **The at-most-once guarantee, observed.** Record the exact error |
| 12 | *Control, not evidence:* resubmit payment 1 unchanged, the same way, and record the result | Rejected — but it would be even without nonces (D35) |
| 13 | Read slot 0 again | **SOL-8:** the new value differs from the old one and from the current blockhash. This is what a `NONCE_RETURN` would carry |
| 14 | **Execution failure:** offline, sign a payment on slot 1 for more than the payer's token balance; submit it as an execution-failure observation | **SOL-7:** it lands with an error, the merchant **is charged** the fee, slot 1's value **advances**. Record the fee — `SUBMIT_EXECUTION_FAILED` and the failed-send counter depend on it |
| 15 | **Fabricated nonce (T6):** `ghost` signs a payment against an invented nonce value; the merchant verifies it offline, then submits it as a validation-failure observation | Verifies offline; never lands; **no fee**; `getAccountInfo` on the derived address is absent — `SUBMIT_NONCE_ABSENT` (D21). Record the exact error |
| 16 | **Create-ATA branch (D5):** a payment to `merchant2`, which has no ATA for the mint, signed against slot 0's new value from step 13, with `includeCreateAta = true` and `merchant2` as fee payer | Lands; `merchant2`'s ATA exists afterwards, funded by `merchant2`; the payer still holds 0 SOL |
| 17 | Payer closes both slots with `withdrawNonceAccount` to the payer, with the merchant as fee payer | Rent refunded **to the payer** in full (D26) |

---

## ASSERT B is the whole point — as redefined

Everything else is plumbing. **ASSERT B is the protocol-level at-most-once guarantee `VadumInfo.md`
§5.1 is built on**, and until it is observed on a live chain it is a claim from documentation.

An earlier revision asserted it by resubmitting the *identical* transaction. That cannot fail: an
identical transaction is rejected by duplicate detection whether or not a nonce is involved. Step 11
submits a **different** message signed against the same value — the shape of the multi-merchant
double-spend in T1 — and that is the only version of the assertion that can go red (D35).

---

## Outputs

1. **`plan/references/phase0-log.md`** — every transaction signature, every fee, and the exact error
   string the chain returned in steps 11, 12, 14 and 15.
2. **Live observations recorded** against `02-OPEN-QUESTIONS.md` and `10-RESEARCH-solana.md`: D26's
   single-signer setup, both halves of SOL-7, SOL-8, SOL-12, SOL-15, and D21's fabricated-nonce
   behaviour. Most are already resolved from documentation or source; Phase 0 turns them into
   observations.
3. **Nothing else.** No fixtures, no reusable code.

---

## What Phase 0 is not

Not a prototype, not a demo, not UI, not an SDK, not reusable code. It is a throwaway script whose only
job is to make the load-bearing claims fail loudly if they are false. Resist making it nice.
