# Demo script

The single most valuable artefact this project produces. At a grant scale of ~$3,452 average, sixty
seconds of two phones in airplane mode outweighs a forty-page document.

**Film on two Android devices** (D13): native `BarcodeDetector`, no WASM warm-up, no iOS storage
surprises. iOS is proven separately in the measurement report.

---

## Setup, done before filming

- The payer, online, has created their own nonce pool (D26), so a refundable rent deposit sits in the
  nonce accounts; the amount is read live from devnet, never quoted from the plan (D39). Any SOL left in the payer's wallet afterwards is swept out, so the
  wallet shows **zero SOL** on camera. The payer holds some tokens of the test mint (D24).
- The merchant's ATA exists, or the intent sets `INCLUDE_CREATE_ATA`.
- The merchant app is set to **T2** — both radios are off, so the merchant can neither pre-check nor
  wait for confirmation — and the demo amount is within the T2 per-receipt cap of 5
  (`31-PARAMETERS.md`).
- Both PWAs installed and opened online once so the service workers are activated; both handsets pass
  `apps/AIRPLANE-MODE-CHECKLIST.md`.

---

## Shot list — target 60–75 seconds

| # | Shot | Point being made |
|---|---|---|
| 1 | Both phones, airplane-mode icons visible in both status bars, held together | No trick. Both radios are off |
| 2 | Merchant enters an amount; intent QR appears | Ordinary point of sale |
| 3 | Payer scans it. Confirmation screen: merchant, amount, mint | The payer sees what they sign |
| 4 | Payer confirms. `AUTH` QR appears | **A valid Solana payment was just signed with no network** |
| 5 | Merchant scans it. "Verified offline" state, with the T2 notice visible | **Verified offline.** Nothing contacted a server — and the app does not claim that proves more than it does |
| 6 | Merchant's airplane mode off. Transaction submits | Settlement |
| 7 | Explorer, on screen, showing the landed transaction | It was real |
| 8 | Payer's phone, still in airplane mode, scans the nonce return QR | The payer resynchronises without ever reconnecting |

Shot 8 is the one a Solana-literate reviewer will notice, because it is the part nobody else has
built.

---

## Rules

- **One take, no cuts between shots 1 and 6.** A cut is where a reviewer assumes the network came
  back. If a cut is unavoidable, keep both status bars in frame across it.
- Status bars visible in every frame.
- No voiceover during the take. Captions afterwards.
- Real devices. No emulator, no screen recording, no devtools offline mode.
- Show one failure too, in a separate short clip: a **genuine race**. The payer signs two different
  payments against one nonce, two merchants submit, and the loser sees *"Not charged — another
  merchant settled this payment first."* (`SUBMIT_NONCE_STALE`). Never stage it with a fabricated
  nonce — that is `SUBMIT_NONCE_ABSENT`, whose copy is deliberately not reassuring (D21). Honesty about
  the failure mode is more persuasive than a clean happy path.

---

## Caption track

```
Solana payments require both parties online.
Every transaction carries a blockhash that expires in about 45 seconds.

This payer's phone has no network. It will not touch one.

Durable nonce removes the expiry. The payment is signed offline,
travels as a 132-byte QR code, and is verified offline by the merchant.

The merchant pays the fee, so the payer needs no SOL to pay.

Settlement happens when the merchant reconnects.
```

The expiry figure follows `03-VADUMINFO-ERRATA.md` E3: 150 slots at the ~300 ms slot time live on
mainnet since 2026-08-26. Re-check it against the SIMD-0525 feature-gate state on the day of filming;
the next tier shortens it again. The SOL line is D26's narrowed claim — the payer made a refundable
deposit to create the pool, and the caption must not say "never needs SOL".

---

## Where it goes

README, grant application, the repo's social preview, and a standalone post. Publish it **before**
the remaining work is finished — visible progress during the grant review window is free leverage.
