// B3: every rendered QR must land on the version the measurement table records (21-SPEC), as one
// explicit alphanumeric segment (D36). A version that drifts invalidates the report, not the table.

import { fixtures } from '@vadum/fixtures';
import { describe, expect, it } from 'vitest';
import { renderQr } from '../src/qr-encode.ts';
import { fromBase64 } from './helpers.ts';

describe('renderQr', () => {
  const payloads = fixtures.cases.flatMap((fixture) => [
    [`${fixture.name} intent`, fixture.expected.wireIntent, fixture.expected.wireIntentBase45, fixture.expected.qrVersions.intent] as const,
    [`${fixture.name} auth`, fixture.expected.wireAuth, fixture.expected.wireAuthBase45, fixture.expected.qrVersions.auth] as const,
  ]);
  const nonceReturns = fixtures.nonceReturn.map(
    (fixture) => [fixture.name, fixture.expected.wireNonceReturn, fixture.expected.wireNonceReturnBase45, fixture.expected.qrVersions] as const,
  );

  it.each([...payloads, ...nonceReturns])('%s matches the committed EC-M and EC-Q versions', async (_name, base64, base45, versions) => {
    const bytes = fromBase64(base64);
    for (const [ecLevel, version] of [['M', versions.M] as const, ['Q', versions.Q] as const]) {
      const render = await renderQr(bytes, { ecLevel });
      expect(render.version).toBe(version);
      expect(render.ecLevel).toBe(ecLevel);
      expect(render.matrixSize).toBe(version * 4 + 17);
      expect(render.segmentMode).toBe('alphanumeric');
      expect(render.text).toBe(base45);
      expect(render.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    }
  });

  it('defaults to EC-Q (D11)', async () => {
    const [fixture] = fixtures.cases;
    if (fixture === undefined) throw new Error('no positive fixtures');
    const render = await renderQr(fromBase64(fixture.expected.wireAuth));
    expect(render.ecLevel).toBe('Q');
    expect(render.version).toBe(fixture.expected.qrVersions.auth.Q);
  });

  it('never renders larger than v10, the largest QR the product shows', async () => {
    for (const [, base64] of payloads) {
      const render = await renderQr(fromBase64(base64));
      expect(render.version).toBeLessThanOrEqual(10);
    }
  });

  it('keeps a digit run in one alphanumeric segment (D36)', async () => {
    // A nonce-path INTENT carries the zero high bytes of a u64 amount; left to itself the encoder
    // would split that digit run into a numeric segment.
    const fixture = fixtures.cases.find((candidate) => candidate.expected.wireIntentBase45.includes('0000'));
    if (fixture === undefined) throw new Error('no fixture with a digit run');
    const render = await renderQr(fromBase64(fixture.expected.wireIntent));
    expect(render.segmentMode).toBe('alphanumeric');
    expect(render.version).toBe(fixture.expected.qrVersions.intent.Q);
  });
});
