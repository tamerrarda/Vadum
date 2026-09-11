# Stream C — `apps/payer` and `apps/merchant`

**You own `apps/**`.** Requests for changes elsewhere go to `plan/questions/stream-c.md`.

Read first: `01-DECISIONS.md`; `22-SPEC-core-api.md`, `25-SPEC-wire-api.md` and
`26-SPEC-client-api.md` — the three APIs you call; then `13-RESEARCH-pwa.md` (the storage section is a
correctness requirement), `23-SPEC-errors.md`, `30-THREAT-MODEL.md`, `31-PARAMETERS.md`,
`51-DEMO-SCRIPT.md`.

Vite + TypeScript PWAs (D2). **Branch from the commit where Stream A's A0 stubs landed**
(`50-INTEGRATION.md`). From then on you are not blocked by A or B — C0.5 is how.

---

## C0 · Payer onboarding — pool setup (ONB-1)

One online screen: show `Pool.estimateSetupCost(5)` as a refundable deposit, create the pool with the
payer's own key, show the result. **There is no sponsor** (D26), and the copy says exactly what D26
says: the payer needs no SOL *to pay*; creating the pool takes a one-time, fully refundable deposit of
the nonce rent — about 0.0066 SOL on mainnet in September 2026, read live and never hardcoded (D39) —
returned when the pool is closed. The amount the screen asks for is the full `estimateSetupCost` total,
setup fee and wallet floor included, not the rent alone (D38). A close-pool action that refunds the rent lives in
settings.

**Done when:** on devnet a fresh payer funds, creates a pool of five, and closes it with the rent back.

## C0.5 · Fixture-backed fakes

Under `apps/shared/`, fakes of the `core`, `wire` and `client` surfaces the apps call, backed by
`packages/fixtures` — so both apps are clickable end to end while the real packages still throw
`INTERNAL_NOT_IMPLEMENTED`. They are test doubles: excluded from production builds by configuration,
not by discipline.

**Done when:** both apps run the full sign-and-verify flow against fakes, and a production build
contains none of them.

## C1 · Shell, service worker, install

Both apps installable, precached, and launching **cold in airplane mode**.

The service worker must serve `index.html` from cache for *navigation* requests, not just
subresources — the single most common cause of a white screen in airplane mode. The `zxing-wasm`
`.wasm` file is bundled, served same-origin, and **in the precache manifest** (D10); the library's CDN
default leaves the iOS scanner dead with the radio off.

Ship `apps/AIRPLANE-MODE-CHECKLIST.md` and run it on every target device before C9 and before filming.
At minimum: cold start with the radio off; **cold start with the radio off, then scan a QR** (D10);
install through the Share menu on iOS; relaunch after a force-quit.

**Done when:** both apps pass the checklist on a real device. Not devtools offline mode — the actual
radio.

## C2 · Key management

Ed25519 as a **non-extractable** `CryptoKey` in IndexedDB. Load
`@solana/webcrypto-ed25519-polyfill@8.0.0` only where native WebCrypto Ed25519 is missing (D9). Native
support shipped in Chrome 137 in May 2025; the polyfill exists for the long tail of un-updated low-end
Android builds and vendor WebViews, not for the mainstream.

**Done when:** a key is generated, persisted, reloaded after a hard restart, and signs; the app knows
which path it is on; and the README states that the key is not in a secure element and that, on the
polyfill path, it lives in the JavaScript heap.

## C3 · Durability, RECOVERY and the standalone gate — your hardest task

Not QR. This. **Slot state belongs to `client/pool.ts`** (D32); you make it durable and you detect
when it is gone. You never keep a second record of spent slots.

- Implement the browser `KeyValueStore` on IndexedDB.
- Mirror a pool epoch marker into `localStorage`, so partial loss is *detectable* rather than invisible.
- **Standalone-mode gate.** Detect `display-mode: standalone` / `navigator.standalone`. In a browser tab
  the payer app is read-only — it shows history and guides installation — and it **must not sign
  offline**. Only installed home-screen apps get WebKit's exemption from ITP storage deletion, so this
  is the real storage control (`13-RESEARCH-pwa.md`, `30-THREAT-MODEL.md` T4).
- Call `navigator.storage.persist()` on first run. It needs no prompt and is granted automatically to
  an installed app.
- **No notification permission, and no prompt other than the camera** (`31-PARAMETERS.md`). An earlier
  revision of this task mandated a notification prompt on the premise that iOS clears an installed
  PWA's storage after seven days of disuse. That premise is wrong and retracted.
- On launch, if the epoch marker says a pool exists but the store holds no pool state, enter
  **RECOVERY** and refuse to sign offline until one online session restores it (`Pool.refresh`, then
  `Pool.reconcile`).

What still causes loss: use in a browser tab, reinstall or cleared site data, a new device, Android
storage pressure, a crash mid-write. Fail safe, never silent: "Cannot pay offline — reconnect once to
restore" is acceptable; signing a dead transaction is not.

**Done when:** wiping storage on a real device puts the app into RECOVERY on next launch and blocks
offline signing, and the payer app opened in a browser tab never offers to sign.

## C4 · Payer app — sign flow

Scan, routed by `peekPayloadType` → decode the intent against the mint cache (**unknown mints are
refused**, `MINT_UNKNOWN`; a stale *mutable* mint warns and caps per D22, never hard-blocks) →
confirmation screen showing merchant, amount, mint and any staleness → device biometric above the
threshold in `31-PARAMETERS.md` → `Pool.reserveSlot` → `core.signAsPayer` → render the `AUTH` QR.

The order of the last three steps is the fail-safe (D32): the slot is persisted as spent before the
signature exists.

**Done when:** the flow completes end to end offline — first against fakes, then against the real
packages.

## C5 · Merchant app — accept flow

Show intent QR → scan `AUTH` → `core.verifyAuth` **offline** → tier decision → accept or queue →
submit when online.

- **T0** is the default: online, submit, hand over only after `settled`.
- **T1** is an explicit opt-in: `precheckNonce` **before** handover, and `Queue.accept` refuses without
  an `ok` verdict (D30). A merchant app that cannot reach RPC does not have T1; it has T2.
- **T2** is an explicit opt-in with the lowest caps, and its setting states the unmitigated
  fabricated-nonce path in plain words (`31-PARAMETERS.md` caveat 3).

**Done when:** all three tiers are reachable, the caps are enforced in the UI as well as in `client`,
and no screen presents offline verification as proof that an account exists behind the payment.

## C6 · Static merchant QR mode (D6)

The merchant generates a printable `STATIC_INTENT`. The payer scans it, enters the amount, signs. The
merchant still scans the `AUTH` — and **enters the expected amount, the price of the sale, before
scanning**; the app passes it to `verifyAuth` as `expectedAmount`, which static mode requires (D30).
Without it, a payer who signs 0.01 for a 5.00 item gets a green "verified".

Encoder and decoder both enforce: static implies the nonce path, and `AMOUNT_IN_AUTH` is set. The docs
say plainly that a printed sticker is exactly what gets covered over (T5).

**Done when:** a payment completes from a QR printed on paper, and an `AUTH` for the wrong amount is
rejected with `CANON_AMOUNT_MISMATCH`.

## C7 · Failure UX

Every user-facing code in `23-SPEC-errors.md` has copy, and none of it says "an error occurred".
`INTERNAL_*` codes are not user-facing. The ones that decide whether the copy is honest:

| Code | Side | Copy must convey |
|---|---|---|
| `SUBMIT_NONCE_STALE` | merchant | *"Not charged — another merchant settled this payment first."* A genuine race |
| `SUBMIT_NONCE_ABSENT` | merchant | *"This payment was not backed by a valid account. Nothing was charged, but the goods are gone. Consider requiring confirmation before handover."* **Never reassuring** (D21) |
| `SUBMIT_EXECUTION_FAILED` | merchant | The payer could not cover the payment, and the merchant paid a network fee |
| `LIMIT_PRECHECK_REQUIRED` | merchant | T1 needs a connection to check the payment before handover |
| `WIRE_UNEXPECTED_TYPE` | both | This is the wrong kind of QR code for this screen |
| RECOVERY / `NONCE_LEDGER_MISSING` | payer | Cannot pay offline — reconnect once to restore |
| `NONCE_POOL_EXHAUSTED` | payer | Offline payments used up — reconnect to refresh |
| `NONCE_DESYNC` | payer | A payment was never submitted and its slot was released; the send window is a heuristic, not a guarantee |
| `MINT_RECORD_STALE` | payer | This token's rules have not been re-checked recently, so offline payments are capped |

**Done when:** a test asserts that every non-`INTERNAL_` member of `VadumErrorCode` maps to copy.

## C8 · Nonce recovery over QR

After settlement the merchant builds the `NONCE_RETURN` statement from the settled payment and
`SubmitOutcome.newNonceValue`, signs it with `core.signNonceReturn`, and renders the **100-byte**
payload (D20, D28). The payer scans it and calls `Pool.applyNonceReturn`, which verifies against the
merchant in its own ledger and its own prior value, then re-arms the slot — without touching the
network. A return that fails is discarded silently.

**Done when:** a payer that never reconnects makes a second payment on the re-armed slot after
scanning the return, and scanning a return issued to a different payer changes nothing.

## C9 · iOS support (D6)

Verify `zxing-wasm` scanning in airplane mode, installation through the Share menu, storage
persistence, the standalone gate, and the camera in standalone mode.

## C10 · Demo

Follow `51-DEMO-SCRIPT.md`. Film on two Android devices (D13).

---

## Do not

Do not construct Solana instructions or wire payloads — `core` and `wire` do that. Do not keep your
own record of spent slots — `client/pool.ts` owns it. Do not treat storage loss as a UX problem. Do not
add a permission prompt beyond the camera. Do not ship a fake.
