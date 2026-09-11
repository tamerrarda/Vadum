# Vadum

Offline stablecoin payments on Solana. A payer whose phone has no network signs a payment; the
merchant verifies it offline and settles when it reconnects. Built on durable nonces, with no
on-chain program of its own.

> **Status: pre-alpha.** The design is complete and spec freeze is pending the live-chain Phase 0
> run. Nothing here is usable yet.

## Honest limits — read these first

- **Devnet only, base fee only.** v1 cannot express a priority fee and is not meant for congested
  mainnet (`plan/01-DECISIONS.md` D16).
- **No secure element.** Keys are non-extractable WebCrypto keys; on the polyfill path used by older
  browsers they live in the JavaScript heap (D9).
- **No light client.** A fully offline merchant cannot verify the payer's balance, or that a nonce
  account exists behind a payment at all. The risk is bounded by per-receipt caps, queue caps and
  risk tiers — not eliminated (`plan/30-THREAT-MODEL.md`).
- **A payer can void queued payments** by advancing their own nonce accounts (T7).
- **The payer needs no SOL to pay**, but creating a nonce pool takes a one-time, fully refundable
  deposit of about 0.0072 SOL (D26).

## Repository layout

| Path | What |
|---|---|
| `packages/core` | Canonical message builder, validation, offline verification |
| `packages/wire` | QR payload codec, base45, QR render and scan |
| `packages/client` | RPC, nonce pool, mint cache, merchant queue, submission |
| `packages/fixtures` | Golden test vectors from an independent reference generator |
| `apps/payer`, `apps/merchant` | Reference PWAs |
| `plan/` | The design: decisions, specs, threat model, task lists. Start at `plan/00-INDEX.md` |

## Development

Requires **Node ≥ 24** (see `.nvmrc`) and pnpm.

```bash
nvm use
pnpm install
pnpm verify    # typecheck, tests, fixture reproduction, repository checks
```

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
