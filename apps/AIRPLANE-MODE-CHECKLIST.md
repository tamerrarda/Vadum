# Airplane-mode checklist

Run this on **every target device** before C9 and before filming (`plan/42-STREAM-C-apps.md` C1,
`plan/13-RESEARCH-pwa.md` APP-1). Not devtools offline mode — the actual radio. Devtools offline mode
does not reproduce a cold start, and a cold start is where PWAs fail.

Record the device, OS version, browser version and date next to each run. A pass on one device says
nothing about another.

| # | Step | Passes when | Why it is here |
|---|---|---|---|
| 1 | Install the app: Android via the install prompt, iOS via Share → Add to Home Screen | The app launches from the home screen with no browser chrome | Only installed apps get WebKit's ITP exemption, and the payer app refuses to sign in a tab (T4) |
| 2 | Open it **online once** and leave it open for a few seconds | Settings shows the service worker as active | A PWA installed but never opened online may not have activated its worker, and then airplane mode shows a white screen |
| 3 | Force-quit the app. Turn on airplane mode. Launch it from the home screen | The app renders its own shell — not a browser error page | This is the navigation-request case: the worker must serve `index.html` from cache, not just subresources |
| 4 | Still offline, open the scan screen and scan any QR code | The camera opens and a code is read | The `zxing-wasm` binary must be same-origin and precached; the library's CDN default leaves the iOS scanner dead here (D10) |
| 5 | Still offline, complete a payment: merchant shows an intent, payer scans, confirms, shows the `AUTH`, merchant scans and verifies | The merchant reaches "Verified offline" with the tier notice visible | The product |
| 6 | Still offline, scan a `NONCE_RETURN` on the payer | The slot is re-armed and the payer can pay again | Shot 8 of the demo, and the part nobody else has built |
| 7 | Force-quit and relaunch, still offline | State survives: identity, pool slots, queue | IndexedDB durability, and the epoch marker mirror |
| 8 | Turn the radio back on | The merchant queue drains and settles | C5 |
| 9 | Open the payer app in a **browser tab** (not installed) | It shows history and an install prompt, and offers no way to sign | The standalone gate is the real storage control, not a permission prompt |
| 10 | Clear site data, relaunch the installed app | It enters RECOVERY, says "Cannot pay offline — reconnect once to restore", and refuses to sign | Fail safe, never silent (C3) |

## Notes for the run

- Step 4 is the one that fails silently on iOS. If it fails, check that the `.wasm` is listed in
  `precache-manifest.json` and served from the app's own origin.
- Step 9 is a check on the app, not on the platform: if it offers to sign in a tab, that is a bug to
  fix before filming, not a device quirk to note.
- Steps 5, 6 and 10 are gates G4 and G6 in `plan/50-INTEGRATION.md`. Note the outcome there too.
- If a step fails, write down what the screen said. "It did not work" is not a result.
