# SPEC — `@vadum/wire` public API

**NORMATIVE.** Frozen at spec freeze.

This file did not exist in the first revision of the plan, and its absence was a blocker. Both
independent reviews found it the same way: `22-SPEC-core-api.md` freezes `core`'s interface, and
`20-ARCHITECTURE.md` gives `wire` and `client` one-line prose responsibilities — so Stream C, which
imports from both, had **no frozen signatures at all** for two of the three packages it depends on.
Stream C would have invented an API, Stream B would have invented a different one, and the merge
would have been a rewrite. The plan freezes three interfaces or it does not deliver parallelism.

`wire` imports **types only** from `core`. It never constructs a Solana instruction, never touches
the network, never reads storage, and **never verifies a signature** (D30). Its runtime dependencies
are `@solana/kit` for address and base58 codecs and the pinned QR libraries listed in
`20-ARCHITECTURE.md`.

---

## `base45.ts` — RFC 9285, vendored (D12)

```ts
/** RFC 9285 alphabet, exported so tests and validators use one definition. */
export const BASE45_ALPHABET: string;   // '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'

/**
 * Encode. 3 characters per 2 bytes, 2 characters for an odd trailing byte:
 *   len = floor(n/2)*3 + (n%2 ? 2 : 0)
 * The output contains spaces — in 94% of real AUTH payloads, and two adjacent in about 3%. They are
 * data, not padding (21-SPEC transport MUST 2, D29). base45 never ends with a space and no v1
 * payload begins with one; the fixture suite asserts both as properties, and no code may rely on
 * either.
 */
export function toBase45(bytes: Uint8Array): string;

/**
 * Decode. Throws VadumError('WIRE_BASE45_INVALID') on:
 *   - any character outside BASE45_ALPHABET (including lowercase)
 *   - length % 3 === 1
 *   - a 3-character group decoding above 0xFFFF
 *   - a 2-character tail decoding above 0xFF (D37)
 * MUST NOT trim or normalise, and MUST NOT map an unknown character to -1 and continue.
 */
export function fromBase45(s: string): Uint8Array;
```

Do not accept a `string | Uint8Array` union, do not return a `Buffer`, and do not add a "lenient"
mode. The three defects measured in `base45@2.0.1` all came from exactly those conveniences.

---

## `codec.ts` — the four payload types

```ts
import type { Address, Nonce, Intent, Auth, MintRecord } from '@vadum/core';

export type PayloadType = 'INTENT' | 'STATIC_INTENT' | 'AUTH' | 'NONCE_RETURN';

export interface WireFlags {
  readonly lifetimeFresh: boolean;      // bit 0
  readonly includeCreateAta: boolean;   // bit 1
  readonly token2022: boolean;          // bit 2
  readonly feePayerSeparate: boolean;   // bit 3 — always false in v1 (D19)
  readonly amountInAuth: boolean;       // bit 4
}

/** What a decoder needs to apply receive rules 4, 5 and 6. Supplied by the caller, never fetched —
 *  `wire` performs no I/O. Rules 7, 9 and 12 live in `core` and rule 13 in `client` (D30), so
 *  nothing here describes the payer's ledger or the merchant's queue. */
export interface DecodeContext {
  /** The caller's local mint compatibility cache. Rules 4 and 5, on INTENT and STATIC_INTENT:
   *  mint present, decimals equal, TOKEN_2022 flag equal to the record's tokenProgram. */
  readonly mintCache: ReadonlyMap<Address, MintRecord>;
  /** Required when decoding an AUTH: the flags of the intent being answered (rule 6). */
  readonly intentFlags?: WireFlags;
}

/** Reads version and type only (check-order steps 2–4). Throws WIRE_LENGTH_MISMATCH,
 *  WIRE_VERSION_UNSUPPORTED or WIRE_UNKNOWN_TYPE. Routes a scanned QR to the right screen before a
 *  typed decoder is chosen. */
export function peekPayloadType(bytes: Uint8Array): PayloadType;

export function encodeIntent(intent: Intent): Uint8Array;
export function decodeIntent(bytes: Uint8Array, ctx: DecodeContext): Intent;

export function encodeStaticIntent(intent: Intent): Uint8Array;
export function decodeStaticIntent(bytes: Uint8Array, ctx: DecodeContext): Intent;

export function encodeAuth(auth: Auth, flags: WireFlags): Uint8Array;
export function decodeAuth(bytes: Uint8Array, ctx: DecodeContext): Auth;

export interface NonceReturnPayload {
  readonly nonceIndex: number;
  readonly newNonceValue: Nonce;
  readonly signature: Uint8Array;        // 64 bytes, from core.signNonceReturn — NOT verified here
}

export function encodeNonceReturn(payload: NonceReturnPayload): Uint8Array;

/** Structural only (D30): version, type 0x04, flags === 0x00, length 100. Never verifies the
 *  signature — `client` Pool.applyNonceReturn does that through core.verifyNonceReturn (D28). */
export function decodeNonceReturn(bytes: Uint8Array): NonceReturnPayload;

/** The (type, flags) -> length table from 21-SPEC, as a function. Exported because both the
 *  encoder and the decoder must agree, and because the negative fixtures test it directly. */
export function expectedLength(type: PayloadType, flags: WireFlags): number;
```

**The codec implements every receive rule `21-SPEC` assigns to `wire` — 1–6, 8, 10 and 11 — in the
normative check order** (D30). They are the security model, not validation garnish. Each typed
decoder throws `WIRE_UNEXPECTED_TYPE` for a known type other than its own, so a payload breaking two
rules has exactly one correct error. `expectedLength` exists so rule 3 has one implementation rather
than four.

**The codec neither deduplicates nor verifies.** Rule 13 needs queue state, so it lives in
`client/queue.ts` (`26-SPEC-client-api.md`). Rules 7, 9 and 12 need `buildMessage`, both addresses,
or a signature check against the payer's ledger, so they live in `core`. The codec's job ends at
"these bytes are well formed".

---

## `qr-encode.ts`

```ts
export type EcLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrRender {
  /** The base45 string actually encoded, verbatim — every space included. */
  readonly text: string;
  readonly version: number;        // 1..40
  readonly ecLevel: EcLevel;
  readonly matrixSize: number;     // modules per side
  /** Always 'alphanumeric' (D36). Anything else means the payload was not encoded as one explicit
   *  segment, and the version in the measurement report no longer follows from the length. */
  readonly segmentMode: 'alphanumeric' | 'byte' | 'numeric' | 'kanji';
  readonly dataUrl: string;        // image/png
}

/** Default ecLevel is 'Q' (D11). Encodes the base45 string as ONE explicit alphanumeric segment,
 *  never as a bare string the library may split (D36), so the version depends on payload length and
 *  EC level alone. version/ecLevel/matrixSize/segmentMode are API, not debug output — the
 *  measurement deliverable reports them. */
export function renderQr(payload: Uint8Array, opts?: { ecLevel?: EcLevel }): Promise<QrRender>;
```

---

## `qr-scan.ts`

```ts
export type ScanEngine = 'barcode-detector' | 'zxing-wasm';

export interface ScanResult {
  readonly bytes: Uint8Array;      // base45-decoded payload
  readonly rawText: string;        // exactly what the engine returned. NEVER trimmed or normalised
  readonly engine: ScanEngine;     // D10: measurements are never blended across engines
  readonly msElapsed: number;      // camera-open to successful decode
}

export interface Scanner {
  start(video: HTMLVideoElement): Promise<void>;
  /** Resolves on the first successful decode, rejects on abort. */
  next(): Promise<ScanResult>;
  stop(): Promise<void>;
  readonly engine: ScanEngine;
}

/**
 * `BarcodeDetector` where available, `zxing-wasm` otherwise (D10).
 *
 * MUST pass a same-origin `wasmUrl` on the zxing path. zxing-wasm@3.1.3 bakes a jsDelivr URL in
 * at build time; with the radio off that fetch fails and the scanner never initialises — on iOS,
 * where it is the ONLY scan path (D6 + D10). The .wasm file must also be in the service-worker
 * precache manifest.
 */
export function createScanner(opts: {
  preferEngine?: ScanEngine;
  wasmUrl: string;                 // required, same-origin
}): Promise<Scanner>;

/** Warm the WASM module during the intent screen so the camera is not waiting on it. */
export function preloadScannerEngine(wasmUrl: string): Promise<ScanEngine>;
```

`rawText` is returned alongside `bytes` specifically so whitespace damage — a collapsed run of spaces,
a substituted non-breaking space — is visible in a bug report rather than lost in a decode failure.

---

## `measure.ts` — a grant deliverable, not a debug tool

Types only here; the methodology is `32-MEASUREMENT-METHOD.md` and **it must be written before this
module is implemented** (WIRE-6).

```ts
export interface ReadTrial {
  readonly payloadType: PayloadType;
  readonly payloadBytes: number;
  readonly qrVersion: number;
  readonly ecLevel: EcLevel;
  readonly engine: ScanEngine;
  readonly deviceId: string;       // from the device matrix in 32-MEASUREMENT-METHOD.md
  readonly lighting: string;       // from the same fixed vocabulary
  readonly distanceCm: number;
  readonly success: boolean;
  readonly msElapsed: number | null;   // null when success is false
}

export interface RoundTripTrial {
  readonly msTotal: number;        // intent shown -> merchant sees "verified"
  readonly msByStage: Readonly<Record<'scanIntent' | 'confirm' | 'sign' | 'scanAuth' | 'verify', number>>;
  readonly engine: ScanEngine;
  readonly deviceId: string;
  readonly operatorId: string;     // anonymised participant
}

export interface MeasurementReport {
  readonly generatedAt: string;
  readonly trials: readonly ReadTrial[];
  readonly roundTrips: readonly RoundTripTrial[];
}

export function summarise(r: MeasurementReport): {
  /** Read success rate PER ENGINE. Never blended (D10). */
  readonly successRateByEngine: Readonly<Record<ScanEngine, number>>;
  readonly msElapsedPercentiles: Readonly<Record<'p50' | 'p90' | 'p99', number>>;
  /** The headline: what fraction of human-in-the-loop rounds exceed each expiry window.
   *  45s is the CURRENT 150-slot window at 300ms slots; 30s is the SIMD-0525 target. */
  readonly roundTripsExceeding: Readonly<Record<'45s' | '30s', number>>;
};
```

`roundTripsExceeding` is the single most valuable output of the entire project
(`VadumInfo.md` §9 deliverable #3). Its shape is frozen here so nobody has to guess what the
histogram is measuring.
