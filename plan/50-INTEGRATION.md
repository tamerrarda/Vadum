# Integration

How Stream 0 and three parallel streams become one working system.

---

## Branch order — the one real dependency

1. **Stream 0** bootstraps the repository, commits `packages/fixtures`, runs Phase 0, and tags the
   spec-freeze commit on `main` (D33, gate G0).
2. **Stream A** branches from it and lands the A0 stubs on `main` within its first hour.
3. **Streams B and C branch from the A0 commit.** That is the only ordering constraint between the
   three streams: stubs give compilation, fixtures give real bytes, and Stream C's fixture-backed fakes
   (C0.5) give working screens. After it, no stream waits on another.

One branch per stream: `stream/core`, `stream/wire-client`, `stream/apps`. Each rebases on `main`
daily. Because file ownership is disjoint (`20-ARCHITECTURE.md`), rebases should be trivial; a genuine
conflict means someone wrote outside their package, which is a process failure to fix immediately
rather than merge through. Questions and cross-package requests go to `plan/questions/stream-*.md`,
never into `02-OPEN-QUESTIONS.md` directly.

Merge order into `main`: **A → B → C.** Each merge must leave `main` green.

---

## Integration gates

| Gate | Requires | Proves |
|---|---|---|
| **G0 · Spec freeze** | Stream 0 done: bootstrap green on Node 24; fixtures committed and reproducible; Phase 0 passed with D35's assertions and its log committed; no blocking `OPEN` in `02-OPEN-QUESTIONS.md` | The primitive works on a live chain and the contracts are real |
| **G1 · Core green** | Stream A: every core fixture passes, positive and negative; property tests pass; no `INTERNAL_NOT_IMPLEMENTED` left in `packages/core/src` | `buildMessage` is correct and deterministic |
| **G2 · Wire green** | Stream B: codec round-trips every fixture; all twenty-one codec negatives throw their exact codes in check order; the client negatives pass | Bytes on the air gap are correct |
| **G3 · Loopback** | `Pool.reserveSlot` → `signAsPayer` → encode → QR → scan → decode → `verifyAuth`, in one process, no network | The full air-gap path works without devices |
| **G4 · Two-device offline** | Two real phones, radios off, payment signed and verified; the iOS scanner passes its airplane-mode cold-start check | The product exists |
| **G5 · Settlement** | Merchant reconnects, submits, transaction lands on devnet | End to end |
| **G6 · Recovery** | All three submission failure classes produced deliberately; storage wiped and RECOVERY entered; a `NONCE_RETURN` re-arms a slot offline; `reconcile` re-arms a settled slot online | The hard parts work |

**G3 is the one to reach fastest.** It removes devices from the loop and turns the rest of the project
into ordinary debugging.

---

## Integration tests that must exist

1. **Loopback** — full path in one process, no network, no camera.
2. **Cross-stream determinism** — Stream C's app and Stream A's tests produce identical `messageBytes`
   for the same intent.
3. **Race** — the payer signs two *different* payments against one nonce value, and two merchants
   submit. Exactly one lands; the loser gets `SUBMIT_NONCE_STALE` and is charged **nothing** (D35).
4. **Execution failure** — underfunded payer. The merchant gets `SUBMIT_EXECUTION_FAILED`, is charged,
   the nonce is consumed, and the failed-send counter increments.
5. **Fabricated nonce** — a throwaway payer with no accounts and an invented nonce value. `verifyAuth`
   passes offline; `precheckNonce` returns `absent`; a T1 `accept` without a verdict throws
   `LIMIT_PRECHECK_REQUIRED`; submission yields `SUBMIT_NONCE_ABSENT` with no fee, and the counter
   increments (D21, D30).
6. **Duplicate `AUTH`** — the same `AUTH` presented while queued and again after settlement; both are
   rejected with `WIRE_DUPLICATE_AUTH` (D31).
7. **Eviction** — wipe storage, relaunch, assert RECOVERY and that offline signing is refused; open the
   payer app in a browser tab and assert it never signs.
8. **Nonce return** — the payer never reconnects, scans the 100-byte return, and pays again on the
   re-armed slot; a return issued to a different payer changes nothing (D28).
9. **Reconciliation** — a settled slot is re-armed online; an abandoned slot is released only after the
   send window (D32).
10. **Mint hard block** — a locally created mint with an active transfer hook is refused.
11. **Cap enforcement** — every limit in `31-PARAMETERS.md` blocks at its boundary.

Tests 3, 4 and 5 are the three a reviewer would ask about. They belong in the README with their
output.

---

## Definition of done for v1

- [ ] All seven gates passed
- [ ] All eleven integration tests green in CI
- [ ] Measurement report published per `32-MEASUREMENT-METHOD.md`: QR version, read-success rate
      **per engine**, and the human-in-the-loop round-trip time distribution
- [ ] `21-SPEC-wire-format.md` published as a standalone spec someone else could implement
- [ ] Demo video
- [ ] README states the honest limits: devnet and base fee only, no secure element, no light client,
      caps are product-level, T2 carries an unmitigated fabricated-nonce path, and a payer can void
      queued payments at will (T7)
- [ ] `03-VADUMINFO-ERRATA.md` approved and applied to `VadumInfo.md`
