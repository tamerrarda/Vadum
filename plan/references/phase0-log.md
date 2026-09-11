# Phase 0 — run log

**PASSED** · 2026-09-11T15:17:59.008Z · written by `tools/phase0/src/phase0.ts` per `plan/60-PHASE0-derisk.md`

| | |
|---|---|
| Cluster | devnet — https://api.devnet.solana.com, genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| Merchant | `69w4qyb5LMvAJwBgfvKQRTwYXd5THby6ReayrDnz6LP6` |
| Payer | `Hforckd96F44YWRj7R8Ar9AnRTMczKw1mM9f247oRa7L` (fresh keypair) |
| Merchant 2 | `HKphWZ1zqKmgtdbU1Yt2BMgaBLVtYRS44RQY7myNUtZK` (fresh keypair) |
| Ghost | `zjSrrLyasYGD6Kk4MaZWCEVgG7WY2nPhPV6P1ANawRM` (fresh keypair, never funded) |
| Test mint | `GEBVVvwBuHCk1y1B6hR9ecSDwo1q4DL68QrsjewMJVwi` — legacy SPL Token, 6 decimals, no extensions (D24) |

| Step | Outcome | Detail | Transaction |
|---|---|---|---|
| 1 | ok | test mint created; the payer holds 100000000 base units | [k1D2YQJB…](https://explorer.solana.com/tx/k1D2YQJBzyzAKAFRn3TEjv2QjPscFswbgTevjr4tiv2R73W2ySzib62RwmKpGbzYjuAanPoWYmmvegyKmh939qs?cluster=devnet) |
| 2 | ok | the payer created slots 0 and 1 with one signature, funding 2113280 lamports of rent itself (D26) | [4fSmuDTA…](https://explorer.solana.com/tx/4fSmuDTAmVu2mrzEkx26sxP97GVUBJHm2s2NFeME1M68AuYbd21RRJi8iL2gM6dTs7kJTFsG2xt4bDpWX8NCgmKS?cluster=devnet) |
| 3 | ok | the payer wallet holds 0 SOL; its rent deposit sits in the nonce accounts |  |
| 4 | ok | slot 0 holds BXFNJPc1yLvvGetUyDjHy1Je1Xdda42mj6n9FUvkiD7y; slot 1 holds BXFNJPc1yLvvGetUyDjHy1Je1Xdda42mj6n9FUvkiD7y |  |
| 5–7 | ok | with the network guard armed: payments for 2500000 and 1000000 signed against one nonce value, both verified offline |  |
| 8–9 | ok | ASSERT A — the offline-signed, offline-verified payment landed through the durable-nonce confirmer (SOL-15) | [4E2RH8Dq…](https://explorer.solana.com/tx/4E2RH8DqXMQXuaMASoYLhpbUbRUbDvGSjtLg1GYNE8Lp7H1FoPYWQWbjwenhAmEvV2Gd1nMXSYe2Rb4aJoxXAJzG?cluster=devnet) |
| 11 | ok | ASSERT B — a different payment against the consumed nonce never landed, cost nothing, and classifies as stale. Simulation: "BlockhashNotFound". Send: accepted for broadcast as 2nxmsF2pVG4emiXvN9MxJv9PNeuAvt3urxGLEqrbc5tWsZBVERfuw7nmVoWce1cx7Kfi3Bkh7CswgMcJJzgB1h8S |  |
| 12 | control | identical replay of payment 1 — rejected, as it would be without any nonce (D35). Simulation: "BlockhashNotFound". Send: accepted for broadcast as 4E2RH8DqXMQXuaMASoYLhpbUbRUbDvGSjtLg1GYNE8Lp7H1FoPYWQWbjwenhAmEvV2Gd1nMXSYe2Rb4aJoxXAJzG |  |
| 13 | ok | slot 0 now holds B9kqxeGD8ZAYwzZsehqvvby2NkakFdWqEMU9PrcTPoh — the value a NONCE_RETURN would carry |  |
| 14 | observed | execution failure — error {"InstructionError":["1",{"Custom":"1"}]}; fee 10000 lamports charged to the merchant; slot 1 advanced. SUBMIT_EXECUTION_FAILED semantics confirmed | [2wU8KyQi…](https://explorer.solana.com/tx/2wU8KyQi9Pb1v9EoApjEN9EDmHj5i9jY58bSTxtYeSq7JZxKZ9RZD2hXLAC43HRo8SnBdv9DyHj3ZuUTUmSVq2C1?cluster=devnet) |
| 15 | observed | fabricated nonce — verified offline, never landed, cost nothing, account absent: SUBMIT_NONCE_ABSENT (D21). Simulation: "BlockhashNotFound". Send: accepted for broadcast as 2SNqBjrQocHuBRckeDgm6adiwNbg7XhJMcjufzbj2eRt7GKzJpuro3yWWeGpApCg5GeC5zppQfrNaGybwkCYzrp9 |  |
| 16 | ok | a payment with createAssociatedTokenAccountIdempotent landed; merchant 2 funded its own ATA (D5, D19) | [gcLZg9uU…](https://explorer.solana.com/tx/gcLZg9uUndH7FRj8rFDGVxMdZpFntmzcZQiCRvLAqxKr8MLAWPqxbU5stLNJniaTKp1EbMyHGtSyPbodcfDHqM7?cluster=devnet) |
| 17 | ok | both slots closed; 2113280 lamports of rent returned to the payer (D26) | [2mKqZCgc…](https://explorer.solana.com/tx/2mKqZCgc9jawUes8JPySiY7MgtoY28iVFS5UjyK96hXqhb6XA6AVrUQANkLotKhwKjgTeFd1SSTXiriscpKaoCSH?cluster=devnet) |
