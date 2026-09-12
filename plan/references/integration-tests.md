# Integration tests — output

The device-free half of `plan/50-INTEGRATION.md`'s eleven integration tests, with the run that produced
this file. `50-INTEGRATION.md` says tests **3, 4 and 5** are the three a reviewer would ask about and
that they belong in the README with their output; this is that output, and the README links here.

Reproduce with:

```bash
pnpm exec vitest run packages/integration --reporter=verbose
```

Environment for the run below: **node v24.18.0**, **vitest 5.0.0**, darwin-arm64, commit `57aefbf`,
2026-09-12T09:24:16Z.

```
 ✓ test/scenarios.test.ts > 3 · race — one nonce value, two different payments, two merchants > lets exactly one land and charges the loser nothing (D35) 46ms
 ✓ test/scenarios.test.ts > 4 · execution failure — the payer cannot cover it > charges the merchant, consumes the nonce, and counts against the failed-send limit 8ms
 ✓ test/scenarios.test.ts > 5 · fabricated nonce — the cheapest attack in the system (T6, D21) > verifies offline, is refused at T1, and settles as SUBMIT_NONCE_ABSENT 9ms
 ✓ test/scenarios.test.ts > 6 · duplicate AUTH — while queued and after settlement (D31) > refuses the same payment in both states 7ms
 ✓ test/scenarios.test.ts > 7 · eviction — the ledger is gone > refuses to hand out a slot rather than signing against an unknown one (C3, T4) 3ms
 ✓ test/scenarios.test.ts > 8 · nonce return — offline recovery (D28) > re-arms the slot for this payer only 9ms
 ✓ test/scenarios.test.ts > 9 · reconciliation (D32) > releases an abandoned slot only after the send window, and re-arms a settled one 2ms
 ✓ test/scenarios.test.ts > 10 · mint hard block > refuses a mint with an active transfer hook, and an intent for a mint the payer has never checked 1ms
 ✓ test/scenarios.test.ts > 11 · cap enforcement at every boundary (D23) > blocks the receipt cap, the exposure cap, the failed-send counter and the send window 25ms
 ✓ test/loopback.test.ts > G3 · loopback > carries a payment from the merchant’s screen to a verified payment, through a real QR 136ms
 ✓ test/loopback.test.ts > G3 · loopback > settles what it verified, and re-arms the slot from the 100-byte return (D28) 26ms
 ✓ test/loopback.test.ts > G3 · loopback > produces the committed fixture bytes for the fixture’s own input (cross-stream determinism) 1ms

 Test Files  2 passed (2)
      Tests  12 passed (12)
```

## What the three assert, exactly

These run against `packages/integration/test/fake-chain.ts` — an in-process chain that holds nonce
accounts and spends a nonce value exactly once. That is what makes them run in CI on every push. The
same three paths were produced against **devnet** by `tools/devnet-b`; its log is
`plan/references/stream-b-devnet-log.md`, steps 9, 10 and 11.

### 3 · Race — the failure the demo shows

One payer, one nonce value, **two different payments**, two merchants. The test asserts:

- the two compiled messages differ, and both carry the same `nonceRef.value`;
- the first submission settles;
- the second returns `SUBMIT_NONCE_STALE` with `feeCharged: false` — the loser pays nothing;
- the loser's queue leaves `consecutiveFailedSends()` at **0**, because an honest race is not a reason to
  stop trading (D21).

### 4 · Execution failure — the failure that costs the merchant

A payment that reaches execution and fails there. The test asserts:

- the outcome is `SUBMIT_EXECUTION_FAILED` with `feeCharged: true` (SOL-7);
- the failed-send counter increments to 1;
- after the slot's on-chain value moves, `reconcile` reports it **settled** and the slot returns to the
  payer as `unspent` — a failed payment does not cost the payer offline capacity permanently (D32).

### 5 · Fabricated nonce — the cheapest attack in the system

A throwaway payer with no accounts and an invented nonce value. The test asserts:

- the `AUTH` **verifies offline**: `verifyAuth` accepts it, which is the whole point of T6;
- `precheckNonce` returns `{ ok: false, reason: 'absent' }`;
- `Queue.accept` at T1 throws `LIMIT_PRECHECK_REQUIRED` both with no verdict and with a failing one, so
  a T1 merchant cannot hand over (D30);
- T2, which cannot pre-check at all, accepts it and finds out at submission:
  `SUBMIT_NONCE_ABSENT`, `feeCharged: false`, and the failed-send counter increments.

The last line is the honest one: in T2 the goods are already gone. The copy the merchant app shows for
that code says so, and a test asserts it keeps saying so (`apps/shared/test/errors.test.ts`).

## What these do not prove

They run in one process. They say nothing about two phones, a camera in sunlight, airplane-mode cold
start, or iOS — those are `apps/AIRPLANE-MODE-CHECKLIST.md` and gates G4–G6, and they are not done.
