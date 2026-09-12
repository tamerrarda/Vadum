# Stream B — devnet verification log

**PASSED** · 2026-09-12T10:52:59.430Z · written by `tools/devnet-b/src/devnet-b.ts` for the B6–B10 "Done when" clauses of `plan/41-STREAM-B-wire-client.md`

| | |
|---|---|
| Cluster | devnet — https://api.devnet.solana.com (mainnet reads: https://api.mainnet-beta.solana.com, read-only) |
| Merchant | `69w4qyb5LMvAJwBgfvKQRTwYXd5THby6ReayrDnz6LP6` |
| Payer | `DNFg2cPmKmQoQPg7DreXZ5ugMSHBUNzYawUFArVzwjiF` — fresh keypair, funded its own pool (D26) |
| SPL test mint | `4fcCc2eWyzzZq6LxQm6UpeayTfLn4Rv1XER83MgtcNaA` — 6 decimals, no extensions (D24) |
| Token-2022 hook mint | `4iwjJ6CyprzzrQyLB475JekEv3hWWNg5UbfDbgeNMFAU` — an ACTIVE transferHook, expected to be blocked |
| Under test | `@vadum/core`, `@vadum/wire`, `@vadum/client` — not the fixture generator’s reference builder |

| Step | Outcome | Detail |
|---|---|---|
| 1 | ok | live USDC on both clusters evaluates compatible and immutable; USDG and PYUSD compatible with warnings and mutable, so D22 staleness applies to them alone |
| 2 | ok | SPL test mint 4fcCc2eWyzzZq6LxQm6UpeayTfLn4Rv1XER83MgtcNaA created and evaluated compatible; the payer holds 100000000 base units |
| 3 | ok | a live Token-2022 mint with an active transfer hook is blocked: ["transfer-hook-active"], warnings [], mutable true |
| 4 | ok | pool creation for a 0-lamport wallet raised NONCE_POOL_UNDERFUNDED and sent nothing (D38) |
| 5 | ok | the payer created its own pool of 3: 3169920 lamports of refundable rent, wallet left at the rent-exempt floor |
| 6 | ok | a T1 payment settled through queue.drain (2qDLdExjQG3t…); newNonceValue equals the slot's new value, and the merchant received 2500000 base units |
| 7 | ok | the 100-byte signed NONCE_RETURN re-armed the slot; the same return issued to another payer was refused (D28) |
| 8 | ok | the pre-check separates a consumed slot (stale) from a nonce account that never existed (absent): the T1 mitigation, live |
| 9 | observed | an overdraft sent with preflight skipped landed, failed, and was classified SUBMIT_EXECUTION_FAILED with feeCharged true; 10000 lamports left the merchant |
| 10 | observed | a different payment against the consumed value was classified SUBMIT_NONCE_STALE, cost nothing, and left the counter at 0; re-submitting the identical transaction reported settled, because it is the transaction that already landed |
| 11 | observed | a fabricated nonce verified offline, was classified SUBMIT_NONCE_ABSENT on submission, and raised the failed-send counter (T6, D21) |
| 12 | ok | reconcile: settled [0,1] (re-armed with the on-chain value, no NONCE_RETURN needed), released [2], still pending [] |
| 13 | ok | pool closed: 3169920 lamports of rent refunded to the payer, then swept back to the merchant (D26) |
