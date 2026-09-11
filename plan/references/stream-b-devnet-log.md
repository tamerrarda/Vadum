# Stream B — devnet verification log

**PASSED** · 2026-09-11T23:56:14.390Z · written by `tools/devnet-b/src/devnet-b.ts` for the B6–B10 "Done when" clauses of `plan/41-STREAM-B-wire-client.md`

| | |
|---|---|
| Cluster | devnet — https://api.devnet.solana.com (mainnet reads: https://api.mainnet-beta.solana.com, read-only) |
| Merchant | `69w4qyb5LMvAJwBgfvKQRTwYXd5THby6ReayrDnz6LP6` |
| Payer | `6uNCtEFnpndsYBLtw5DtUzQYhdrVtkA1JSDm5KZnA36t` — fresh keypair, funded its own pool (D26) |
| SPL test mint | `HKrj4LMpDy1eYL5UpKaNr7GkjgaDD5RuYsDY3sTZCuem` — 6 decimals, no extensions (D24) |
| Token-2022 hook mint | `J8qSxf3iYr487ykR2tDcKtYJzU8HdAUxnNf9xG7HnZW1` — an ACTIVE transferHook, expected to be blocked |
| Under test | `@vadum/core`, `@vadum/wire`, `@vadum/client` — not the fixture generator’s reference builder |

| Step | Outcome | Detail |
|---|---|---|
| 1 | ok | live USDC on both clusters evaluates compatible and immutable; USDG and PYUSD compatible with warnings and mutable, so D22 staleness applies to them alone |
| 2 | ok | SPL test mint HKrj4LMpDy1eYL5UpKaNr7GkjgaDD5RuYsDY3sTZCuem created and evaluated compatible; the payer holds 100000000 base units |
| 3 | ok | a live Token-2022 mint with an active transfer hook is blocked: ["transfer-hook-active"], warnings [], mutable true |
| 4 | ok | pool creation for a 0-lamport wallet raised NONCE_POOL_UNDERFUNDED and sent nothing (D38) |
| 5 | ok | the payer created its own pool of 3: 3169920 lamports of refundable rent, wallet left at the rent-exempt floor |
| 6 | ok | a T1 payment settled through queue.drain (4VWEiMfrqQMu…); newNonceValue equals the slot's new value, and the merchant received 2500000 base units |
| 7 | ok | the 100-byte signed NONCE_RETURN re-armed the slot; the same return issued to another payer was refused (D28) |
| 8 | ok | the pre-check separates a consumed slot (stale) from a nonce account that never existed (absent): the T1 mitigation, live |
| 9 | observed | an overdraft was classified SUBMIT_EXECUTION_FAILED with feeCharged false; 0 lamports left the merchant (preflight rejects it before it lands, which is why nothing is charged here — Phase 0 step 14 measured the landed case), counter at 1 |
| 10 | observed | a payment against the value the slot was already spent against was classified SUBMIT_NONCE_STALE, cost nothing, and left the failed-send counter at 0 |
| 11 | observed | a fabricated nonce verified offline, was classified SUBMIT_NONCE_ABSENT on submission, and raised the failed-send counter (T6, D21) |
| 12 | ok | reconcile: settled [1] (re-armed with the on-chain value, no NONCE_RETURN needed), released [0,2], still pending [] |
| 13 | ok | pool closed: 3169920 lamports of rent refunded to the payer, then swept back to the merchant (D26) |
