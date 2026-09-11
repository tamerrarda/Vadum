// QR rendering with qrcode@1.5.4. The payload is encoded as ONE EXPLICIT alphanumeric segment (D36):
// left to segment the string itself, the encoder turns the digit run of a u64 amount into a numeric
// segment, and the version stops following from the payload length alone.

import { VadumError } from '@vadum/core';
import { create, toDataURL, type QRCodeSegment } from 'qrcode';
import { toBase45 } from './base45.ts';

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrRender {
  /** The base45 string actually encoded, verbatim — every space included. */
  readonly text: string;
  readonly version: number;
  readonly ecLevel: EcLevel;
  readonly matrixSize: number;
  /** Always 'alphanumeric' (D36); anything else means the measured version no longer follows. */
  readonly segmentMode: 'alphanumeric' | 'byte' | 'numeric' | 'kanji';
  readonly dataUrl: string;
}

/** The EC level bits the QR standard assigns, as qrcode reports them back. */
const LEVEL_BY_BIT: Readonly<Record<number, EcLevel>> = { 0: 'M', 1: 'L', 2: 'H', 3: 'Q' };

/** Default EC-Q (D11): two versions larger, and readable on a scratched screen in sunlight. */
export async function renderQr(payload: Uint8Array, opts?: { ecLevel?: EcLevel }): Promise<QrRender> {
  const ecLevel = opts?.ecLevel ?? 'Q';
  const text = toBase45(payload);
  const segments: QRCodeSegment[] = [{ data: text, mode: 'alphanumeric' }];

  const symbol = create(segments, { errorCorrectionLevel: ecLevel });
  const [segment, ...rest] = symbol.segments;
  if (segment === undefined || rest.length > 0) {
    throw new VadumError('WIRE_LENGTH_MISMATCH', { reason: 'the encoder split the payload into several segments', segments: symbol.segments.length });
  }

  return {
    text,
    version: symbol.version,
    ecLevel: LEVEL_BY_BIT[symbol.errorCorrectionLevel.bit] ?? ecLevel,
    matrixSize: symbol.modules.size,
    segmentMode: segment.mode.id.toLowerCase() as QrRender['segmentMode'],
    dataUrl: await toDataURL(segments, { errorCorrectionLevel: ecLevel }),
  };
}
