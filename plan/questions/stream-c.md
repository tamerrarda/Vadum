# Stream C — questions and change requests

Append-only. Reconciled into `02-OPEN-QUESTIONS.md` at integration. Requests for changes outside
`apps/**` go here; keep coding against the frozen interfaces meanwhile.

---

## 2026-09-12 · What Stream C cannot finish without the owner

These tasks are not blocked by code. They need hardware, a human, or a decision:

| Task | What it needs |
|---|---|
| C1 "Done when" | Both apps run `apps/AIRPLANE-MODE-CHECKLIST.md` on a real device, radio off. The checklist ships; the runs do not exist yet |
| C0 "Done when" | A fresh payer funds, creates a pool of five and closes it **on a device**. The same path is already proven on devnet from Node by `tools/devnet-b` (steps 4, 5, 13) |
| C3 "Done when" | Wiping storage on a real device, and opening the payer app in a real browser tab. The logic is unit-tested (`apps/shared/test/gate.test.ts`); the device runs are not |
| C9 | iOS: Share-menu install, `navigator.standalone`, camera and `zxing-wasm` in standalone airplane mode |
| C10 | Filming, on two Android devices (D13), per `51-DEMO-SCRIPT.md` |
| PROD-7 | The failure copy now exists in `apps/shared/src/errors.ts` and is asserted complete. It still wants a read-through by whoever owns the product voice |

## 2026-09-12 · Decisions taken inside Stream C

| # | Gap | What the apps do | Needs a spec change? |
|---|---|---|---|
| C-1 | C0.5 asks for fixture-backed **fakes** of core, wire and client so the apps are clickable while those packages still throw `INTERNAL_NOT_IMPLEMENTED` | Skipped, like A0's stub commit: all three packages are implemented and green, so `apps/shared` holds the real browser runtime instead of doubles. "Do not ship a fake" is easiest to honour by never writing one | No — the task was scaffolding for a parallelism that did not happen |
| C-2 | `20-ARCHITECTURE.md` gives no PWA tooling, and the catalog has no service-worker plugin. Adding one would need a decision record | The service worker is hand-written, and `scripts/build-precache.mjs` turns Vite's build manifest into `precache-manifest.json` after each build — no new dependency, and the `.wasm` is in the list by construction (D10) | No — record the choice |
| C-3 | `vitest.config.ts` lists `packages/*` only, so nothing under `apps/` would run | Extended to `['packages/*', 'apps/*']`. This is a file outside `apps/**`, hence this note | No |
| C-4 | The 11 integration tests of `50-INTEGRATION.md` have no home: they cross every package, so they belong to none | Added `packages/integration`, a private test-only package. It is where G3 (loopback) lives, along with the device-free scenarios — race, duplicate, reconciliation, nonce return, caps | Maybe — `20-ARCHITECTURE.md` should list it |
| C-5 | `26-SPEC`'s `KeyValueStore` says nothing about what the browser implementation stores keys as | The same store holds the identity `CryptoKeyPair` under `identity:keypair`, because IndexedDB stores a non-extractable `CryptoKey` as an object and nothing else can (APP-2) | No — confirm |
| C-6 | C3 asks for a `localStorage` epoch mirror so partial loss is detectable, but not what a ledger **without** a marker means | Both mismatches are RECOVERY: a marker with no ledger, and a ledger with no marker. Only "both present" signs, and "neither" is onboarding | No — confirm |
| C-7 | C4 requires a **device biometric** above the payer confirmation threshold (10, `31-PARAMETERS.md`). A PWA has no offline local-authentication API: WebAuthn needs a credential created while online, and iOS exposes no local-auth prompt to web apps at all | Above the threshold the payer must **type the amount again** before signing. It is a deliberate second look, not an identity check, and the app does not call it biometric | **Yes, requested:** either narrow the parameter to "a second confirmation step", or accept that the biometric applies only where WebAuthn is already enrolled |
| C-8 | Both manifests need icons, and icon art is not a coding task | A placeholder SVG ships as `icon.svg` with `purpose: "any maskable"`. Chrome installs from it; the real asset is an owner deliverable before filming | No — owner asset |
| C-9 | The standalone gate is specified for the payer. The merchant app also holds state that matters — the queue of payments waiting to settle | The merchant is **not** blocked in a browser tab, because it never signs a payment offline; it says plainly that a tab can lose the queue and lets the user continue | No — confirm |
