// Scanning: the platform's BarcodeDetector where it exists, zxing-wasm everywhere else (D10).
//
// `wasmUrl` is required and MUST be same-origin. zxing-wasm@3.1.3 bakes a jsDelivr URL in at build
// time; with the radio off that fetch fails and the scanner never initialises — on iOS, where it is
// the only scan path. The .wasm also belongs in the service-worker precache manifest.
//
// Scanned text is never trimmed or normalised (receive rule 10): `rawText` is exactly what the engine
// returned, so whitespace damage shows up in a bug report instead of vanishing into a decode failure.

import { VadumError } from '@vadum/core';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { fromBase45 } from './base45.ts';

export type ScanEngine = 'barcode-detector' | 'zxing-wasm';

export interface ScanResult {
  /** base45-decoded payload. */
  readonly bytes: Uint8Array;
  /** Exactly what the engine returned. NEVER trimmed or normalised. */
  readonly rawText: string;
  /** D10: measurements are never blended across engines. */
  readonly engine: ScanEngine;
  /** Camera-open to successful decode. */
  readonly msElapsed: number;
}

export interface Scanner {
  start(video: HTMLVideoElement): Promise<void>;
  /** Resolves on the first successful decode, rejects on abort. */
  next(): Promise<ScanResult>;
  stop(): Promise<void>;
  readonly engine: ScanEngine;
}

/** The slice of the BarcodeDetector API this module uses; it is not in TypeScript's DOM library. */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource | ImageData | Blob): Promise<readonly { readonly rawValue: string }[]>;
}
interface BarcodeDetectorConstructor {
  new (options?: { formats?: readonly string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<readonly string[]>;
}

const barcodeDetectorCtor = (): BarcodeDetectorConstructor | undefined =>
  (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;

async function supportsQrCode(): Promise<boolean> {
  const ctor = barcodeDetectorCtor();
  if (ctor === undefined) return false;
  try {
    const formats = await ctor.getSupportedFormats?.();
    return formats === undefined || formats.includes('qr_code');
  } catch {
    return false;
  }
}

/** Points Emscripten at the caller's copy of the .wasm instead of the CDN URL baked in at build time. */
let preparedWasmUrl: string | undefined;
function prepareZXing(wasmUrl: string): void {
  if (preparedWasmUrl === wasmUrl) return;
  prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : `${prefix}${path}`) },
    fireImmediately: false,
  });
  preparedWasmUrl = wasmUrl;
}

/** Warm the WASM module during the intent screen so the camera is not waiting on it. */
export async function preloadScannerEngine(wasmUrl: string): Promise<ScanEngine> {
  if (await supportsQrCode()) return 'barcode-detector';
  prepareZXing(wasmUrl);
  await prepareZXingModule({ fireImmediately: true });
  return 'zxing-wasm';
}

/**
 * Decode one still image. Exported so the QR pipeline can be exercised without a camera, and so an
 * app can read a photographed or pasted code. zxing only: BarcodeDetector needs a live document.
 */
export async function decodeImage(image: Blob | Uint8Array | ImageData, wasmUrl: string): Promise<ScanResult> {
  const startedAt = performance.now();
  prepareZXing(wasmUrl);
  const rawText = firstQrText(await readBarcodes(image, { formats: ['QRCode'], tryHarder: true }));
  if (rawText === null) throw new VadumError('WIRE_BASE45_INVALID', { reason: 'no QR code found in the image' });
  return { bytes: fromBase45(rawText), rawText, engine: 'zxing-wasm', msElapsed: performance.now() - startedAt };
}

const firstQrText = (results: readonly { isValid: boolean; format: string; text: string }[]): string | null =>
  results.find((result) => result.isValid && result.format === 'QRCode')?.text ?? null;

class CameraScanner implements Scanner {
  readonly engine: ScanEngine;
  readonly #wasmUrl: string;
  #video: HTMLVideoElement | null = null;
  #stream: MediaStream | null = null;
  #openedAt = 0;
  #aborted = false;
  #detector: BarcodeDetectorLike | null = null;
  #canvas: OffscreenCanvas | null = null;

  constructor(engine: ScanEngine, wasmUrl: string) {
    this.engine = engine;
    this.#wasmUrl = wasmUrl;
  }

  async start(video: HTMLVideoElement): Promise<void> {
    this.#aborted = false;
    // The camera permission is asked for here and nowhere else (31-PARAMETERS).
    this.#stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = this.#stream;
    video.playsInline = true;
    await video.play();
    this.#video = video;
    this.#openedAt = performance.now();
    if (this.engine === 'barcode-detector') {
      const ctor = barcodeDetectorCtor();
      if (ctor === undefined) throw new VadumError('INTERNAL_NOT_APPLICABLE', { reason: 'BarcodeDetector disappeared between selection and start' });
      this.#detector = new ctor({ formats: ['qr_code'] });
    } else {
      prepareZXing(this.#wasmUrl);
    }
  }

  async next(): Promise<ScanResult> {
    const video = this.#video;
    if (video === null) throw new VadumError('INTERNAL_NOT_APPLICABLE', { reason: 'next() before start()' });
    for (;;) {
      if (this.#aborted) throw new VadumError('INTERNAL_NOT_APPLICABLE', { reason: 'the scanner was stopped' });
      const rawText = await this.#readFrame(video);
      if (rawText !== null) {
        // A non-Vadum code throws here rather than being repaired; the app simply scans again.
        return { bytes: fromBase45(rawText), rawText, engine: this.engine, msElapsed: performance.now() - this.#openedAt };
      }
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }
  }

  async #readFrame(video: HTMLVideoElement): Promise<string | null> {
    if (this.#detector !== null) {
      const [found] = await this.#detector.detect(video);
      return found?.rawValue ?? null;
    }
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width === 0 || height === 0) return null;
    this.#canvas ??= new OffscreenCanvas(width, height);
    this.#canvas.width = width;
    this.#canvas.height = height;
    const context = this.#canvas.getContext('2d');
    if (context === null) throw new VadumError('INTERNAL_NOT_APPLICABLE', { reason: 'no 2d context for frame capture' });
    context.drawImage(video, 0, 0, width, height);
    return firstQrText(await readBarcodes(context.getImageData(0, 0, width, height), { formats: ['QRCode'], tryHarder: true }));
  }

  async stop(): Promise<void> {
    this.#aborted = true;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    if (this.#video !== null) this.#video.srcObject = null;
    this.#stream = null;
    this.#video = null;
    this.#detector = null;
  }
}

/** BarcodeDetector where available, zxing-wasm otherwise (D10). */
export async function createScanner(opts: { preferEngine?: ScanEngine; wasmUrl: string }): Promise<Scanner> {
  if (opts.wasmUrl === '') throw new VadumError('INTERNAL_NOT_APPLICABLE', { reason: 'wasmUrl is required and must be same-origin' });
  const engine: ScanEngine = opts.preferEngine === 'zxing-wasm' || !(await supportsQrCode()) ? 'zxing-wasm' : 'barcode-detector';
  if (engine === 'zxing-wasm') prepareZXing(opts.wasmUrl);
  return new CameraScanner(engine, opts.wasmUrl);
}
