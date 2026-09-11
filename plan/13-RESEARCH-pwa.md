# Research — PWA runtime, offline behaviour, and local state

Answers to the `APP-*` questions. iOS support is in v1 scope (`01-DECISIONS.md` D6), which makes
several of these load-bearing rather than academic.

---

## Headline — CORRECTED: installed PWAs are exempt from the eviction this section was built on

`VadumInfo.md` §5.9 identifies the hardest operational part of the project:

> *"Alıcının uygulaması bir nonce'u kullanınca yerel olarak işaretlemeli. Uygulama silinir ya da
> çökerse bu bilgi kaybolur ve alıcı ölü işlemler imzalamaya başlar."*

That risk is real, and the RECOVERY design below is right. **The iOS premise this section previously
gave for it is wrong**, and both independent reviews of this plan found it separately.

### What the earlier revision claimed, and what is actually true

| Earlier claim | Reality |
|---|---|
| iOS caps script-writable storage at 7 days of disuse, and this hits our PWA | **Home-screen web apps are explicitly exempt from ITP's data deletion.** WebKit, *CNAME Cloaking and Bounce Tracking Defense* (2020-11-12): *"we have implemented an **explicit exception for the first-party domain of home screen web applications** to make sure ITP always skips that domain in its website data removal algorithm."* Still standing policy, and unconditional in current WebKit source |
| "7 days" means seven calendar days | It counts **operating dates** — days Safari actually ran — not elapsed time |
| `navigator.storage.persist()` requires notification permission to take effect | It is granted through **that same exemption set**: automatic for a home-screen app, never for a Safari tab. **No prompt, no notification permission, no UI** |
| PWA storage is cleared after a few weeks of disuse | Not for an installed app |

An offline-payment wallet is by construction not opened for weeks — and an **installed** one is
precisely the case Apple carved out.

### Three consequences, and the third is the important one

1. **A gratuitous permission prompt was about to ship.** Task C3 instructed Stream C to request
   notification permission "solely to make persist effective on iOS" and called it "the only
   permission prompt the app should ever show". On a payments wallet that is a conversion-destroying
   prompt buying nothing. **Removed.**
2. **Priorities were inverted.** Ledger loss was ranked "the most likely failure in practice" and C3
   "your hardest task", above a free-goods attack (`30-THREAT-MODEL.md` T6) that was not in the
   document at all.
3. **The real exposure is being used *uninstalled*.** A Safari tab gets no exemption and ITP applies
   in full. So the correct control is not a permission prompt — it is **requiring installation**.

### The rules, restated on the correct premise

1. **Detect standalone mode and require installation before enabling offline signing.**
   `window.matchMedia('(display-mode: standalone)')` / `navigator.standalone`. In a browser tab the
   app is read-only: it can show history and guide installation, and it must not sign. This replaces
   the notification prompt entirely.
2. Request `navigator.storage.persist()` on first run. It is free, it needs no prompt, and it is
   granted automatically to an installed app.
3. Write a **pool epoch marker** alongside the ledger. On launch, if nonce accounts are known to
   exist but the ledger or its marker is missing, enter **RECOVERY** and **refuse to sign offline**
   until one online session re-reads pool state. The ledger is `client/pool.ts`'s slot state,
   persisted through the app's `KeyValueStore` (D32): the app makes it durable and detects its loss,
   and keeps no second record of its own.
4. Fail safe, never silent. "Cannot pay offline — reconnect once to restore" is acceptable. Signing a
   dead transaction is not.
5. Mirror the ledger (IndexedDB + a `localStorage` marker) so that partial loss is *detectable*
   rather than invisible.

### What still makes RECOVERY necessary

Rules 3–5 are not weakened by the correction; only the ranking and the prompt were wrong. Live
causes of ledger loss:

| Cause | Live? |
|---|---|
| Used as a Safari tab rather than installed | **Yes** — and rule 1 is the control |
| Reinstall, or the user clearing site data | **Yes**, on every platform |
| New device — the ledger does not travel | **Yes** |
| Android eviction under storage pressure | **Yes** — Chrome has no equivalent exemption |
| Crash mid-write | **Yes** — the mirror exists for this |
| iOS 7-day eviction of an installed app | **No** — this one was the premise, and it is wrong |

---

## APP-1 · Does a PWA run in airplane mode? — RESOLVED in principle, proven on devices by Stream C (C1, C9)

A service-worker PWA with a precached shell launches and functions with no network on both
platforms. Two failure modes must be tested explicitly on real devices before filming:

- **Cold start in airplane mode** — the service worker must already be installed and activated. A
  PWA that was installed but never opened online again may not have completed activation.
- **Navigation requests** — the SW must serve `index.html` from cache for navigations, not just
  subresources. This is the single most common cause of "white screen in airplane mode".

Ship an explicit `AIRPLANE-MODE-CHECKLIST` in Stream C and run it on both devices before the demo.

---

## APP-2 · Key storage and signing — RESOLVED

Kit signs with WebCrypto `CryptoKey` (`10-RESEARCH-solana.md` SOL-1). Ed25519 keys can be generated
as **non-extractable**, so the private key never becomes readable bytes, and stored directly in
IndexedDB as a `CryptoKey` object. Combined with `@solana/webcrypto-ed25519-polyfill` for older
Chrome (D9).

Honest limits, to be stated in the README rather than glossed:

- Non-extractable is not a secure element. A rooted or jailbroken device defeats it.
- **On the polyfill path it is not even non-extractable.** `@solana/webcrypto-ed25519-polyfill` is
  `@noble/ed25519` holding key material in module-scoped `WeakMap`s: it honours `extractable: false`
  at the API surface, but the private key lives in the JS heap where XSS or a compromised dependency
  can read it. Native WebCrypto never puts key material in JS memory. Chrome has had native Ed25519
  since 137 (May 2025), so this is a long tail rather than the mainstream — but the README must not
  claim a guarantee that part of the fleet does not get.
- A backup/restore flow requires an extractable key or a seed phrase, which reopens the exposure.
- v1 is a **reference implementation**. Hardware-backed keys (Seed Vault, StrongBox, Secure Enclave)
  are deferred to v2 with `VadumInfo.md` §7 open question 7.

---

## APP-3 · Camera and scanning — PARTIAL

Dual path is locked (D10). Remaining unknowns are empirical and belong to the Stream B measurement:

- Minimum viable capture resolution for a v8 QR at typical hand-held distance
- Autofocus behaviour on low-end sensors at close range
- Whether torch helps or hurts under sunlight glare
- `zxing-wasm` warm-up cost on a low-end device, and whether it must be preloaded during the intent
  screen so it is ready when the camera opens

---

## APP-5 · iOS PWA limitations that could affect the demo — RESOLVED

| Limitation | Effect |
|---|---|
| Install only via Safari's Share menu, no install prompt | Documented setup step; irrelevant to the demo |
| Storage eviction | **Does not apply to an installed app** — see the corrected headline. It applies fully to Safari-tab use, which is why offline signing requires standalone mode |
| Gated web push | Not used |
| No App Store presence | Aligns with the open-source public-good positioning |

Camera, WebAuthn, Canvas and the Web Share API are all available in installed iOS PWAs.

**Demo recommendation stands (D13): film on two Android devices.** Native `BarcodeDetector`, no WASM
warm-up, no eviction surprises. iOS is proven separately in the measurement report, where its numbers
belong anyway.

---

## Still open

| ID | Question | Note |
|---|---|---|
| APP-1b | Real-device airplane-mode cold start on both platforms | Stream C, before filming |
| APP-3b | The empirical scanning parameters above | Stream B measurement run |
| APP-4b | Exact recovery UX copy for the RECOVERY state | Stream C, needs writing not deciding |
| APP-6 | Verify the standalone-mode detection on both platforms, including iOS's `navigator.standalone` quirk and Android's `display-mode: standalone` | Stream C, C3 — this is now the primary storage control |
