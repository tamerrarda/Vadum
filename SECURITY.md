# Security policy

Vadum is a reference implementation of offline stablecoin payments on Solana. **v1 targets devnet
only** and is not intended to carry real value.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting:

**https://github.com/tamerrarda/Vadum/security/advisories/new**

Do not open a public issue for a suspected vulnerability. Include the affected package or document,
the version or commit, and a minimal reproduction.

## Scope

In scope: `@vadum/core`, `@vadum/wire`, `@vadum/client`, the reference apps under `apps/`, and the
wire format specified in `plan/21-SPEC-wire-format.md`.

Documented limits are **not** vulnerabilities. They are stated in `plan/30-THREAT-MODEL.md`, in
particular:

- a fully offline merchant (tier T2) cannot verify that a nonce account exists behind a payment (T6)
- a payer can void queued payments by advancing or closing their own nonce accounts (T7)
- keys are not held in a secure element, and on the WebCrypto polyfill path they live in the
  JavaScript heap (`plan/01-DECISIONS.md` D9)
- fully offline balance verification is impossible without a light client
