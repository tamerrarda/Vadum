// @vadum/wire — the public API specified in plan/25-SPEC-wire-api.md.

export { BASE45_ALPHABET, fromBase45, toBase45 } from './base45.ts';
export {
  decodeAuth,
  decodeIntent,
  decodeNonceReturn,
  decodeStaticIntent,
  encodeAuth,
  encodeIntent,
  encodeNonceReturn,
  encodeStaticIntent,
  expectedLength,
  flagsFromByte,
  flagsToByte,
  peekPayloadType,
  type DecodeContext,
  type NonceReturnPayload,
  type PayloadType,
  type WireFlags,
} from './codec.ts';
export { renderQr, type EcLevel, type QrRender } from './qr-encode.ts';
export { createScanner, decodeImage, preloadScannerEngine, type ScanEngine, type Scanner, type ScanResult } from './qr-scan.ts';
