# Parameters

The actual numbers. `VadumInfo.md` §5.4 names four risk tools but publishes no values; open
questions 4 and 5 stayed open for that reason.

**All values below are signed off (D23, 2026-08-29).** They ship as configuration, not constants.

Two things changed alongside the sign-off, and both change what the numbers *mean*:

- **Caps are denominated in the mint's base units, never in dollars.** An offline device has no price
  feed, and the protocol is deliberately mint-agnostic. v1 assumes a 1:1 USD-pegged mint with 6
  decimals, so a cap written as `20` is `20_000_000` base units. Behaviour for a non-pegged mint is
  undefined, and is stated as undefined rather than guessed.
- **The exposure arithmetic has been rewritten.** It previously multiplied the pool size by the
  per-receipt cap to produce a bound on merchant loss. That bound does not exist (D21).

---

## The card-network mapping, made exact

EMV has managed this identical risk for forty years and its vocabulary maps cleanly onto ours:

| EMV mechanism | Vadum equivalent | Enforced by |
|---|---|---|
| **Floor limit** — above this the terminal must go online | Per-receipt acceptance cap | Merchant app |
| **Cumulative offline amount** counter | Merchant queue exposure cap; on the payer's side, the **24-hour spend limit** | Merchant app; **payer app**, in `client/pool.ts`. EMV's counter resets when the issuer authorises online. Vadum has no issuer, and a reset the device itself can trigger bounds no one holding the device, so the payer's resets with time instead (REV-17) |
| **Consecutive offline transactions** counter | Nonce pool size N | **Payer app only** |
| **Online authorisation** above the floor limit | The T0/T1 nonce pre-check (D21) | RPC, before handover |
| CVM limit | Payer-side amount re-entry above a threshold, **plus a per-payment cap** | Payer app. The mapping is weaker than EMV's: a card's CVM proves who is holding it, and nothing a PWA can do offline proves that (T12) |

### The third row used to claim more than it could deliver

An earlier revision said the pool size was *"enforced by Solana — N nonce accounts means at most N
concurrently valid offline payments, no matter what software the payer runs"*, and called it a
genuine improvement on EMV's bypassable in-card counter. **It was going into the grant application
and it is false** (D21, `30-THREAT-MODEL.md` T1 and T6): seeds are free, rent is refundable, one
nonce signs unlimited payments to unlimited merchants, and the account need not exist at all.

The row that *is* defensible is the fourth, and it maps onto EMV more precisely anyway. EMV's real
answer to floor-limit risk was never the counter — it was **going online above the limit**. Vadum's
equivalent is the T0/T1 pre-check: one `getAccountInfo` before handover, verifying the nonce account
exists, is initialised, has the payer as authority, and holds the claimed value.

The honest sentence for the application:

> The protocol bounds how many of a payer's offline payments can ever *settle*. It does not bound
> how many merchants can be shown one. Like EMV, we close that by going online above a floor limit —
> and unlike EMV, going online costs us one RPC call rather than an acquirer relationship.

---

## Risk tiers — the cap is about *acceptance*, not about mode

`VadumInfo.md` frames caps per scenario. That is the wrong axis. The merchant's real question is
whether they hand over goods **before on-chain confirmation**:

| Tier | Merchant state | Handover | Pre-check | Risk | Cap |
|---|---|---|---|---|---|
| **T0** | Online, waits for confirmation (~1 s) | after confirmation | implied by confirmation | **zero** | none needed |
| **T1** | Online, accepts immediately for speed | before confirmation | **MANDATORY** — enforced by `client/queue.ts` (D30) | seconds of exposure, fabricated nonce closed | floor limit |
| **T2** | Offline, queues | before confirmation, possibly for hours | **impossible** | multi-merchant exposure **and** fabricated nonce, unmitigated | lower floor limit + cumulative cap |

**The pre-check column is the difference between T1 and T2, and it is not optional in T1.** Without
it, T1 carries the same fabricated-nonce exposure as T2 while feeling safer — the worst possible
combination. A merchant app that cannot reach RPC has not got T1; it has got T2.

**T0 is the primary scenario and it carries no double-spend risk at all** — the merchant simply
waits one second. This is a stronger statement than `VadumInfo.md` §5.5 makes, and it should replace
the current framing: the risk discussion is entirely about T1 and T2, which are opt-in.

---

## Signed-off values (D23)

| Parameter | Default | Base units (6 dp) | Rationale |
|---|---|---|---|
| **T1 per-receipt cap** | **20** | `20_000_000` | Below EMV contactless floor limits (US $100, UK £100) because there is no chargeback and no issuer absorbing loss (`VadumInfo.md` §5.3). Exposure lasts seconds, and the pre-check closes fabricated nonces |
| **T2 per-receipt cap** | **5** | `5_000_000` | Street-vendor ticket size. Exposure may last hours, and no pre-check is possible |
| **T2 merchant queue exposure cap** | **50** | `50_000_000` | Merchant stops accepting offline above this until the queue drains |
| **T2 failed-send counter** | **3** consecutive → stop accepting | — | Fires on `SUBMIT_EXECUTION_FAILED` **and** `SUBMIT_NONCE_ABSENT` (D21). Never on `SUBMIT_NONCE_STALE`, which is an honest race |
| **Nonce pool size N** | **5** | — | Five payments is a plausible offline stretch, and the rent is 5 × one nonce account's rent, refundable — **about 0.0066 SOL on mainnet in September 2026** and falling (D39), plus the wallet floor at setup (D38). **Not a security parameter** — see below |
| **Send window (product TTL)** | **24 h** | — | Merchant must submit or void within this; it also gates the payer's `NONCE_DESYNC` reconciliation. Honest caveat below |
| **Mint compatibility cache TTL** | **24 h**, mutable mints only | — | D22: an immutable mint such as USDC never goes stale. For USDG/PYUSD the TTL **warns and caps**, it does not hard-block |
| **Payer amount re-entry threshold** | **10** | `10_000_000` | Above this the payer app requires the amount to be **typed again** before signing. Revised 2026-09-12: the row said "device biometric", which a PWA cannot provide offline — WebAuthn needs a credential enrolled online and iOS exposes no local-auth prompt to web apps. Re-entry defends against payer error, which is real; it defends against a thief holding an unlocked phone not at all, and the row previously implied otherwise |
| **Payer per-payment cap** | **20** | `20_000_000` | The largest single payment this device will sign offline, added 2026-09-12. Set equal to the T1 receipt cap so it never refuses a sale a merchant could have accepted. It bounds one payment and not how many: this row used to call it the theft bound, "the cap once per unspent slot, so 100 base units at N=5", which was false — reconnecting re-arms slots, so that bound refilled on every refresh (REV-17). The spend limit below is the bound |
| **Payer 24-hour spend limit** | **100** | `100_000_000` | The most this device signs offline in any rolling 24 hours by its own clock, added 2026-09-13 (**T12**, REV-17). Refilled only by time — never by reconnecting, a nonce return, or closing and re-creating the pool, since whoever holds the phone can do each of those. 100 is the number T12 already quoted, so no published figure moved; it is five cap-sized payments, or many small ones. Defeated by setting the clock forward and by running code in the app's origin, both stated in T12. **Not yet signed off** — proposed with the fix, for the owner to confirm or change |
| **Pool low-water mark** | **2** remaining | — | Prompt the payer to reconnect and refresh |

### Four honest caveats that belong in the application

1. **The send window is product-level only.** A durable nonce has no protocol TTL — that is exactly
   what SIMD discussion #415 calls a spam vector, and what SIMD-0571 sets out to price
   (`01-DECISIONS.md` D17). We enforce the window in the merchant app, and a modified merchant app
   can ignore it. It bounds honest failure, not attack.
2. **N is not a security parameter.** An earlier revision described N as two-sided — more usability,
   more simultaneous double-spends — which reads as though N bounded the attack. It does not bound
   anything an attacker does: a hostile payer creates as many nonce accounts as they like, for
   refundable rent, under seeds of their choosing. **N is a usability and cost parameter for honest
   users, and nothing else.** What bounds an attacker is the per-receipt cap, the queue cap, the
   pre-check in T0/T1, and the merchant's choice of tier.
3. **T2 has an unmitigated fraud path.** A fully offline merchant cannot verify that a nonce account
   exists at all (`30-THREAT-MODEL.md` T6). The T2 caps exist because of this, not merely because of
   the multi-merchant race. A merchant enabling T2 is accepting that, and the UI must say so in those
   words.
4. **A payer can void the whole queue for free** by advancing or closing their own nonce accounts
   (T7). No parameter here binds that.

---

## Timeouts and limits that are not risk parameters

| Parameter | Default | Note |
|---|---|---|
| QR error-correction level | **EC-Q** (locked, D11) | Costs two QR versions; buys scratched-screen and sunlight tolerance. Largest QR the product renders is v10 |
| Scanner engine preference | `BarcodeDetector` → `zxing-wasm` | D10. The `.wasm` MUST be same-origin and precached — the CDN default breaks iOS in airplane mode |
| Ledger recovery | Hard stop, no timeout | Missing ledger blocks offline signing entirely |
| **Standalone-mode requirement** | Offline signing **disabled** in a browser tab | Only installed PWAs get WebKit's ITP exemption (`30-THREAT-MODEL.md` T4). This replaces the notification-permission prompt an earlier revision required |
| Permission prompts | **Zero** | The app asks for the camera when the camera is opened, and nothing else. The notification prompt is removed — it was requested to make `persist()` effective on iOS, which was based on a false premise |

---

## Open

| ID | Question | Status |
|---|---|---|
| PROD-2/3/4 | Sign-off on every value above | ✅ Closed — D23 |
| PROD-9 | Demo reference mint | ✅ Closed — D24: an own devnet mint for fixtures and the demo, live USDC/USDG/PYUSD for the compatibility suite |
| PROD-7 | Failure-UX copy for merchant send failure and payer RECOVERY state | 🟡 Still open — needs **writing**, not deciding. Now larger than before: `SUBMIT_NONCE_ABSENT` needs copy that does not reassure a defrauded merchant, and T2 needs copy that states its unmitigated fraud path plainly |
