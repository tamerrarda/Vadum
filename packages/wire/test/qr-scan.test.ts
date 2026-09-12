// B4: the zxing path decodes a rendered payload with the .wasm served locally and nothing reaching
// the internet, the engine behind every read is reported (D10), and scanned text is never repaired.

import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { fixtures } from '@vadum/fixtures';
import { toDataURL } from 'qrcode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderQr } from '../src/qr-encode.ts';
import { createScanner, decodeImage, preloadScannerEngine } from '../src/qr-scan.ts';
import { expectVadumError, fromBase64 } from './helpers.ts';

const PNG_PREFIX = 'data:image/png;base64,';
const pngOf = (dataUrl: string): Blob => {
  const bytes = fromBase64(dataUrl.slice(PNG_PREFIX.length));
  return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'image/png' });
};

let server: Server;
let wasmUrl: string;

beforeAll(async () => {
  // Loopback only: the point is that the scanner initialises with no internet access, which is where
  // zxing-wasm's baked-in jsDelivr URL leaves iOS dead in airplane mode.
  const wasm = await readFile(createRequire(import.meta.url).resolve('zxing-wasm/reader/zxing_reader.wasm'));
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/wasm' });
    response.end(wasm);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the wasm server did not bind a port');
  wasmUrl = `http://127.0.0.1:${address.port}/zxing_reader.wasm`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
});

describe('decodeImage', () => {
  const payloads = [
    ...fixtures.cases.flatMap((fixture) => [
      [`${fixture.name} intent`, fixture.expected.wireIntent] as const,
      [`${fixture.name} auth`, fixture.expected.wireAuth] as const,
    ]),
    ...fixtures.nonceReturn.map((fixture) => [fixture.name, fixture.expected.wireNonceReturn] as const),
  ];

  it.each(payloads)('reads %s back out of its own QR', { timeout: 60_000 }, async (_name, base64) => {
    const bytes = fromBase64(base64);
    const render = await renderQr(bytes);
    const result = await decodeImage(pngOf(render.dataUrl), wasmUrl);
    expect(result.engine).toBe('zxing-wasm');
    expect(result.rawText).toBe(render.text);
    expect(result.bytes).toEqual(bytes);
    expect(result.msElapsed).toBeGreaterThanOrEqual(0);
  });

  it('returns the double space verbatim (receive rule 10)', { timeout: 60_000 }, async () => {
    const fixture = fixtures.cases.find((candidate) => candidate.name === 'base45-double-space');
    if (fixture === undefined) throw new Error('the double-space fixture is missing');
    const render = await renderQr(fromBase64(fixture.expected.wireAuth));
    const result = await decodeImage(pngOf(render.dataUrl), wasmUrl);
    expect(result.rawText).toContain('  ');
    expect(result.rawText).toBe(fixture.expected.wireAuthBase45);
  });

  it('refuses a QR whose text is not base45, instead of repairing it', { timeout: 60_000 }, async () => {
    const dataUrl = await toDataURL([{ data: new TextEncoder().encode('hello world'), mode: 'byte' }], { errorCorrectionLevel: 'Q' });
    await expectVadumError(() => decodeImage(pngOf(dataUrl), wasmUrl), 'WIRE_BASE45_INVALID');
  });

  it('refuses the collapsed-whitespace string the negative fixture records (D29)', { timeout: 60_000 }, async () => {
    const fixture = fixtures.negative.find((candidate) => candidate.name === 'bad-base45-whitespace-collapsed');
    if (fixture === undefined) throw new Error('the collapsed-whitespace fixture is missing');
    const dataUrl = await toDataURL([{ data: fixture.input.base45 as string, mode: 'alphanumeric' }], { errorCorrectionLevel: 'Q' });
    await expectVadumError(() => decodeImage(pngOf(dataUrl), wasmUrl), 'WIRE_BASE45_INVALID');
  });
});

describe('engine selection (D10)', () => {
  const setDetector = (value: unknown): void => {
    if (value === undefined) delete (globalThis as Record<string, unknown>).BarcodeDetector;
    else (globalThis as Record<string, unknown>).BarcodeDetector = value;
  };

  it('prefers BarcodeDetector when the platform supports QR', async () => {
    class FakeDetector {
      static async getSupportedFormats(): Promise<string[]> {
        return ['qr_code', 'ean_13'];
      }
      async detect(): Promise<readonly { rawValue: string }[]> {
        return [];
      }
    }
    setDetector(FakeDetector);
    try {
      expect((await createScanner({ wasmUrl })).engine).toBe('barcode-detector');
      expect(await preloadScannerEngine(wasmUrl)).toBe('barcode-detector');
      // An explicit preference still wins, which is what the measurement runs need.
      expect((await createScanner({ wasmUrl, preferEngine: 'zxing-wasm' })).engine).toBe('zxing-wasm');
    } finally {
      setDetector(undefined);
    }
  });

  it('ignores a BarcodeDetector that cannot read QR', async () => {
    class NoQrDetector {
      static async getSupportedFormats(): Promise<string[]> {
        return ['ean_13'];
      }
      async detect(): Promise<readonly { rawValue: string }[]> {
        return [];
      }
    }
    setDetector(NoQrDetector);
    try {
      expect((await createScanner({ wasmUrl })).engine).toBe('zxing-wasm');
    } finally {
      setDetector(undefined);
    }
  });

  it('falls back to zxing-wasm, warming the module from the local URL', { timeout: 60_000 }, async () => {
    expect((await createScanner({ wasmUrl })).engine).toBe('zxing-wasm');
    expect(await preloadScannerEngine(wasmUrl)).toBe('zxing-wasm');
  });

  it('requires a wasm URL', async () => {
    await expectVadumError(() => createScanner({ wasmUrl: '' }), 'INTERNAL_NOT_APPLICABLE');
  });

  it('rejects next() before start()', async () => {
    const scanner = await createScanner({ wasmUrl });
    await expectVadumError(() => scanner.next(), 'INTERNAL_NOT_APPLICABLE');
  });
});

describe('the BarcodeDetector path', () => {
  // Node has no BarcodeDetector and no camera, so this cannot prove that a platform detector decodes a
  // QR image — only `apps/AIRPLANE-MODE-CHECKLIST.md` step 4 on a real handset can, and the demo is
  // filmed on exactly this path (D13). What it does prove is everything between the detector and the
  // caller: the frame loop, the engine reported, the camera released, and scanned text left untouched.
  // Until now that branch had never run at all: the engine-selection tests above use a detector whose
  // `detect()` returns nothing.
  const stubs: { restore: () => void }[] = [];

  const withDetector = (rawValues: readonly string[]): { detected: number } => {
    const state = { detected: 0 };
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const tracks = [{ stopped: false, stop() { this.stopped = true; } }];

    class StubDetector {
      static async getSupportedFormats(): Promise<string[]> {
        return ['qr_code'];
      }
      async detect(): Promise<readonly { rawValue: string }[]> {
        const value = rawValues[state.detected++];
        return value === undefined ? [] : [{ rawValue: value }];
      }
    }
    (globalThis as Record<string, unknown>).BarcodeDetector = StubDetector;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) } },
    });
    stubs.push({
      restore: () => {
        delete (globalThis as Record<string, unknown>).BarcodeDetector;
        if (originalNavigator === undefined) delete (globalThis as Record<string, unknown>).navigator;
        else Object.defineProperty(globalThis, 'navigator', originalNavigator);
      },
    });
    return state;
  };

  const fakeVideo = (): HTMLVideoElement =>
    ({ srcObject: null, playsInline: false, videoWidth: 640, videoHeight: 480, play: async () => undefined }) as unknown as HTMLVideoElement;

  afterAll(() => {
    for (const stub of stubs) stub.restore();
  });

  it('returns the payload the detector read, and reports which engine read it (D10)', async () => {
    const fixture = fixtures.cases.find((candidate) => candidate.name === 'base45-double-space');
    if (fixture === undefined) throw new Error('the double-space fixture is missing');
    withDetector([fixture.expected.wireAuthBase45]);

    const scanner = await createScanner({ wasmUrl });
    expect(scanner.engine).toBe('barcode-detector');
    const video = fakeVideo();
    await scanner.start(video);
    const result = await scanner.next();

    expect(result.engine).toBe('barcode-detector');
    // Receive rule 10 on this path too: the double space survives, because nothing trimmed it.
    expect(result.rawText).toBe(fixture.expected.wireAuthBase45);
    expect(result.rawText).toContain('  ');
    expect(result.bytes).toEqual(fromBase64(fixture.expected.wireAuth));
    expect(result.msElapsed).toBeGreaterThanOrEqual(0);

    await scanner.stop();
    expect(video.srcObject).toBeNull();
  });

  it('keeps looking while the detector finds nothing', async () => {
    const fixture = fixtures.cases[0];
    if (fixture === undefined) throw new Error('no positive fixtures');
    // Two empty frames, then a code: `next()` must not resolve on an empty frame.
    const state = withDetector(['', '', fixture.expected.wireIntentBase45]);
    (globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => {
      setTimeout(callback, 0);
      return 0;
    };

    const scanner = await createScanner({ wasmUrl });
    await scanner.start(fakeVideo());
    const result = await scanner.next();
    expect(result.bytes).toEqual(fromBase64(fixture.expected.wireIntent));
    expect(state.detected).toBe(3);
    await scanner.stop();
    delete (globalThis as Record<string, unknown>).requestAnimationFrame;
  });

  it('refuses a scan that is not base45 rather than repairing it', async () => {
    const fixture = fixtures.negative.find((candidate) => candidate.name === 'bad-base45-whitespace-collapsed');
    if (fixture === undefined) throw new Error('the collapsed-whitespace fixture is missing');
    withDetector([fixture.input.base45 as string]);

    const scanner = await createScanner({ wasmUrl });
    await scanner.start(fakeVideo());
    await expectVadumError(() => scanner.next(), 'WIRE_BASE45_INVALID');
    await scanner.stop();
  });
});
