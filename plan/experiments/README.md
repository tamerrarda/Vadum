# Experiments

Runnable evidence behind the research files. These are probes, not project code.

> **Status 2026-09-11: these scripts are history, not reference implementations.** Several predate
> decisions that changed what they should build. Do not copy code from them into a package and do not
> extend them. Stream 0 writes the fixture generator and the new Phase 0 script from the specs (D33).

```bash
npm init -y
npm i @solana/kit@8.0.0 @solana-program/system@0.14.0 @solana-program/token@0.16.0 base45 qrcode
```

| Script | Answered | Needs chain? | Known to be out of date |
|---|---|---|---|
| `canonical-rebuild.mjs` | SOL-4, SOL-6 | no | Passes `authority` as a bare address (forbidden by D14) and hard-codes the merchant as fee payer (D19). Its byte-identity result is close to tautological (D3). Prints the superseded 131-byte figure |
| `signer-check.mjs` | **SOL-14** | no | Current for what it checks |
| `qr-sizing.mjs` | WIRE-1, WIRE-2, WIRE-3 | no | Uses `base45@2.0.1`, which D12 rejects. Its byte-mode baseline (v10 for 131 B at EC-M) does not reproduce with raw bytes, which give v8 — the same as base45 (`12-RESEARCH-wire-qr.md`) |
| `qr-sizing-payloads.mjs` | the `21-SPEC` size table | no | Versions reproduce with `qrcode@1.5.4` (re-measured 2026-09-11) |
| `phase0-derisk.mjs --dry` | SOL-14, codec, guard | no | The offline half still passes |
| `phase0-derisk.mjs` | — | yes | **Superseded by `60-PHASE0-derisk.md`.** Uses a sponsored setup (removed by D26); uses the blockhash confirmer on the nonce path, so ASSERT A cannot pass (SOL-15); asserts at-most-once with an identical replay that cannot fail (D35); and emits fixtures in a shape `24-SPEC` does not use |

**The public devnet faucet returns HTTP 429 and is not usable** (`10-RESEARCH-solana.md` SOL-11).
