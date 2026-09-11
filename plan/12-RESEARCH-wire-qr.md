# Research — Wire encoding & QR transport

Answers to the `WIRE-*` questions. The numbers below are **measured**, not estimated —
`experiments/qr-sizing.mjs` encodes real payloads with `base45@2.0.1` and asks `qrcode` which
version it actually chose.

---

## Headline: the QR density problem in `VadumInfo.md` §6.1 does not exist

The document budgets ~575–600 bytes for the signed transaction, estimates QR version 18–20 after
base45, and makes "can a cheap Android camera read this in sunlight" a headline risk and half of
deliverable #3.

That budget assumes the whole signed transaction crosses the air gap. It does not have to. Because
canonical rebuild is byte-identical (see `10-RESEARCH-solana.md` SOL-4), only the fields the
receiving side **cannot derive** need to be transmitted.

Measured, at EC level M:

| Payload | Raw | base45 | QR version | Matrix |
|---|---|---|---|---|
| QR#1 intent, nonce path | 76 B | 114 ch | **v5** | 37×37 |
| QR#1 intent, fresh path (carries blockhash) | 108 B | 162 ch | **v7** | 45×45 |
| QR#2 auth, fresh path | 99 B | 149 ch | **v6** | 41×41 |
| QR#2 auth, nonce path | 132 B | 198 ch | **v8** | 49×49 |
| `NONCE_RETURN`, signed (D20) | 100 B | 150 ch | **v6** | 41×41 |
| *baseline:* full signed transaction, without createATA | 483 B | 725 ch | *v17* | *85×85* |
| *baseline:* full signed transaction, with createATA | 525 B | 788 ch | *v18* | *89×89* |

> **These figures were each one byte low in an earlier draft** (75 / 107 / 98 / 131), from a 2-byte
> header before `flags` was added. `21-SPEC-wire-format.md` is normative at 76 / 108 / 99 / 132. No
> QR version changes, but the numbers appear in prose across several documents — including the demo
> caption — so they are corrected everywhere. The two baseline rows were also conflated into a single
> "483–525 B → v17" row; they are different transactions.

**v8 versus v17.** The measured full transaction is 483 bytes, not the document's estimated
575–600 — but it does not matter, because we never transmit it.

Every payload encodes in QR **alphanumeric** mode, confirmed by inspecting the chosen segment mode.
That was measured on random bytes. A real nonce-path `INTENT` contains a digit run that automatic
segmentation encodes as numeric, which is why `renderQr` encodes one explicit alphanumeric segment
(D36).

---

## WIRE-1 · base45 — RESOLVED

`base45@2.0.1` (npm, "base45 encoder/decoder in javascript"). Verified locally:

- output matches `^[0-9A-Z $%*+\-.\/:]+$`, i.e. it is genuinely QR-alphanumeric safe
- round-trips correctly
- `floor(n/2)*3 + (n%2 ? 2 : 0)` characters. The shorthand "3 characters per 2 bytes" is what an
  earlier draft said and it is **wrong for odd-length payloads** — a lone trailing byte produces
  **2** characters, not 3. The measured tables here are right (`AUTH` fresh: 99 B → 149 ch), but
  Stream B implements from the stated rule, so the rule has to be the exact one

**Does base45 buy density? No — corrected 2026-09-11.** An earlier revision measured, at 131 bytes /
EC-M, `byte mode → v10` against `base45 → v8`, and called it two versions saved. Re-measured with
`qrcode@1.5.4` over 300 random payloads of each type, passing the **raw bytes** as a byte-mode segment:

| Payload | EC-M: base45 / raw bytes | EC-Q: base45 / raw bytes |
|---|---|---|
| `STATIC_INTENT` 68 B | v5 / v5 | v6 / v6 |
| `INTENT` nonce 76 B | v5 / v5 | v7 / v7 |
| `AUTH` fresh 99 B | v6 / v6 | v8 / v8 |
| `NONCE_RETURN` 100 B | v6 / v6 | v8 / v8 |
| `INTENT` fresh 108 B | v7 / v7 | **v9 / v8** |
| `AUTH` nonce 132 B | v8 / v8 | v10 / v10 |
| `AUTH` static 140 B | v8 / v8 | v10 / v10 |

Raw bytes are never larger, and once smaller. That is expected: base45 in alphanumeric mode costs
8.25 bits per byte, byte mode 8. Handing the encoder the same bytes as a JavaScript *string* instead
gives v9–v11 at EC-M, because it UTF-8-encodes the string — the likely source of the old v10 figure.

**base45 stays, for a different and better reason: transport safety.** `BarcodeDetector` returns only
`rawValue`, a string, and arbitrary binary does not survive that conversion reliably; base45 is
text-safe by construction and lands in alphanumeric mode. `VadumInfo.md` §6.2's "significantly denser"
is wrong (`03-VADUMINFO-ERRATA.md` E11). Do not build a density argument on base45 anywhere.

**Decision: vendor it (D12), and not for supply-chain reasons.** This section originally framed the
choice as taste. Probing the installed package showed it is **functionally wrong on decode**:

```
decode("!!!")  -> f7e9      out-of-alphabet -> indexOf() returns -1, used arithmetically
decode("abc")  -> f7e9      lowercase silently accepted
decode("A")    -> 00        1-char tail, invalid per RFC 9285, accepted
decode("ABCD") -> 60e500    length 3n+1, invalid per RFC 9285, accepted (NaN -> 0x00)
```

It throws only on numeric overflow, so invalid input silently produces wrong bytes that surface much
later as `SIG_INVALID`. It is also CommonJS-only and uses Node's `Buffer` in both directions, which
Vite does not polyfill — so it cannot ship into either PWA regardless.

**The "round-trips correctly" note above was true and insufficient**: it tested only valid input.
That is exactly the gap `24-SPEC-fixtures.md`'s negative suite now exists to close.

### One property the plan under-sells

The base45 alphabet is **exactly** the 45 characters of QR alphanumeric mode — 45 of 45, not a
subset. That is why the mode is guaranteed rather than merely likely. It also means the alphabet
contains `SPACE`, `$`, `%`, `+`, `/` and `:`, with two consequences that are now normative in
`21-SPEC-wire-format.md`: **never trim or normalise a scanned string** — 94% of real `AUTH` payloads
contain an interior space and about 3% contain two adjacent ones (D29; an earlier "2.2% start with a
space" figure came from random bytes, and no Vadum payload can start or end with one) — and **never put
a payload in a URL** (RFC 9285 §6 — percent encoding introduces lowercase hex and forces the encoder out
of alphanumeric mode, growing the QR by several versions).

---

## WIRE-2 / WIRE-3 · Capacity and measurement tooling — RESOLVED

`qrcode` (npm) exposes `QRCode.create(text, { errorCorrectionLevel })` which returns `.version`,
`.modules.size` and `.segments[].mode`. That is enough to report the chosen version and EC level in
the measurement deliverable without maintaining a capacity table by hand.

**EC level is a product decision, not a default.** Measured cost of going up:

| Payload | EC-L | EC-M | EC-Q |
|---|---|---|---|
| QR#2 nonce (132 B) | v7 (45px) | v8 (49px) | v10 (57px) |

EC-Q survives a scratched or partly obscured screen far better for two extra versions. Given the
target environment — cheap phones, cracked screens, sunlight, market stalls — **EC-Q is the default
and it is still smaller than the document's estimate at EC-M.**

**Locked as D11, not deferred to the measurement run.** This section originally said "confirm
empirically, then lock", but the cost is already measured and the benefit follows from the
deployment environment, not from our code. The measurement run reports read-success rate per engine;
it does not get to choose the default. Deferring a decision nobody was actually going to measure is
the failure mode `00-INDEX.md` warns about.

---

## WIRE-4 · Scanning — RESOLVED, and it constrains the demo

`BarcodeDetector` support in 2026:

| Platform | Support |
|---|---|
| Chrome / Chromium on **Android** | Yes |
| **Every browser on iOS** (all WebKit) | **No** |
| Firefox | No |
| Chromium desktop | Partial |

A PWA relying on `BarcodeDetector` silently fails on every iPhone.

**Two consequences:**

1. A WASM fallback (`zxing-wasm`, or `jsQR` for a pure-JS path) is mandatory for any iOS support.
2. **The demo should be filmed on two Android phones** (D13). Native `BarcodeDetector`, fastest scan
   path, no WASM warm-up, one less thing that can fail on camera day. iOS is **in v1 scope** (D6) and is
   proven separately in the measurement report — an earlier revision called it a v1.1 item.

**Measurement caveat that must appear in the report:** two different decoders produce two different
read-success rates. The measurement deliverable must report *per engine*, and must not blend an
Android `BarcodeDetector` number with an iOS WASM number into one headline figure.

---

## Still open

| ID | Question | Note |
|---|---|---|
| WIRE-6 | Exact measurement methodology — device matrix, lighting conditions, distance, what "read success" means, sample size | Deliverable #3's actual scientific content. **Now owned by `32-MEASUREMENT-METHOD.md` and must be written before Stream B starts** — a methodology written after the data is not a methodology |

| WIRE-7 | Overflow fallback — split QR or animated QR | ✅ Closed as **not needed at measured sizes**. The largest payload in the protocol is 140 B → v10 at EC-Q. Do not build it |

> **WIRE-5 was listed here and is closed.** `02-OPEN-QUESTIONS.md` recorded it as RESOLVED — raw
> payload, no Solana Pay compatibility — while this table still leaned the other way. Two records,
> two answers. It is settled in `21-SPEC-wire-format.md` as a transport MUST: payloads are never
> URL-embedded, because percent-encoding the base45 alphabet breaks alphanumeric mode.
