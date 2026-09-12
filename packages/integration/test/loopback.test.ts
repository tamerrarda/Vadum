// G3 · Loopback — `Pool.reserveSlot` → `signAsPayer` → encode → QR → **scan** → decode →
// `verifyAuth`, in one process with no network and no camera (plan/50-INTEGRATION.md).
//
// The QR hop is real: the payload is rendered to a PNG and read back through zxing-wasm, with the
// .wasm served over loopback. G3 is the gate that removes devices from the loop.

import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getBase64Encoder, type Address, type Nonce } from '@solana/kit';
import {
  createMemoryStore,
  createPool,
  createQueue,
  DEFAULT_QUEUE_LIMITS,
  precheckNonce,
  submit,
  type Pool,
} from '@vadum/client';
import { buildMessage, deriveAta, signAsPayer, signNonceReturn, verifyAuth, type Intent, type MintRecord } from '@vadum/core';
import { fixtures, MERCHANT_SEED, NONCE_VALUE, PAYER_SEED } from '@vadum/fixtures';
import {
  decodeAuth,
  decodeIntent,
  decodeNonceReturn,
  encodeAuth,
  encodeIntent,
  encodeNonceReturn,
  flagsFromByte,
  decodeImage,
  peekPayloadType,
  renderQr,
} from '@vadum/wire';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeChain, nextValue } from './fake-chain.ts';

const PNG_PREFIX = 'data:image/png;base64,';
const AMOUNT = 2_500_000n;
const POOL_SIZE = 5;

const fromBase64 = (value: string): Uint8Array => new Uint8Array(getBase64Encoder().encode(value));

const pngOf = (dataUrl: string): Blob => {
  const bytes = fromBase64(dataUrl.slice(PNG_PREFIX.length));
  return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'image/png' });
};

/** The committed mint records, as the payer's offline cache (receive rules 4 and 5). */
const mintCache: ReadonlyMap<Address, MintRecord> = new Map(
  fixtures.mintRecords.map((record) => [
    record.mint as Address,
    {
      mint: record.mint as Address,
      tokenProgram: record.tokenProgram,
      decimals: record.decimals,
      compatible: record.compatible,
      blockers: record.blockers as MintRecord['blockers'],
      warnings: record.warnings as MintRecord['warnings'],
      mutable: record.mutable,
      checkedAt: record.checkedAt,
    },
  ]),
);

const MINT = fixtures.mints.spl.address as Address;
const slotValue = (index: number): Nonce => {
  let value = NONCE_VALUE as Nonce;
  for (let step = 0; step < index; step++) value = nextValue(value);
  return value;
};

let server: Server;
let wasmUrl: string;

beforeAll(async () => {
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

/** Everything the two devices are, minus the screens. */
async function twoDevices() {
  const payerKey = await createKeyPairFromPrivateKeyBytes(PAYER_SEED);
  const merchantKey = await createKeyPairFromPrivateKeyBytes(MERCHANT_SEED);
  const payer = await getAddressFromPublicKey(payerKey.publicKey);
  const merchant = await getAddressFromPublicKey(merchantKey.publicKey);

  const chain = createFakeChain();
  await chain.seedPool(payer, POOL_SIZE, slotValue);
  chain.balances.set(payer, NONCE_RENT_TOTAL);

  const payerStore = createMemoryStore();
  const pool = createPool(chain, payer, payerStore);
  await pool.create(POOL_SIZE, payerKey);
  const queue = createQueue(chain, createMemoryStore(), DEFAULT_QUEUE_LIMITS);
  return { chain, payerKey, merchantKey, payer, merchant, pool, queue, payerStore };
}

const NONCE_RENT_TOTAL = 1_056_640n * BigInt(POOL_SIZE) + 5_000n + 890_880n;

const intentFor = (merchant: Address, amount: bigint): Intent => ({
  merchant,
  mint: MINT,
  decimals: 6,
  amount,
  lifetime: { kind: 'nonce' },
  includeCreateAta: false,
  tokenProgram: 'spl-token',
  feePayer: merchant,
  isStatic: false,
});

describe('G3 · loopback', () => {
  it('carries a payment from the merchant’s screen to a verified payment, through a real QR', { timeout: 120_000 }, async () => {
    const { payerKey, merchant, pool } = await twoDevices();
    const intent = intentFor(merchant, AMOUNT);

    // ── merchant: render the intent QR ──────────────────────────────────────────────────────────
    const intentBytes = encodeIntent(intent);
    const intentQr = await renderQr(intentBytes);
    expect(intentQr.segmentMode).toBe('alphanumeric');
    expect(intentQr.version).toBeLessThanOrEqual(10);

    // ── payer: scan it, decode against the offline mint cache, reserve a slot, sign ──────────────
    const scannedIntent = await decodeImage(pngOf(intentQr.dataUrl), wasmUrl);
    expect(peekPayloadType(scannedIntent.bytes)).toBe('INTENT');
    const decodedIntent = decodeIntent(scannedIntent.bytes, { mintCache });
    expect(decodedIntent).toEqual(intent);

    const slot = await pool.reserveSlot(merchant, Date.now());
    // The fail-safe order (D32): the slot is persisted as spent before a signature exists.
    expect(pool.status().slots[slot.index]).toMatchObject({ state: 'spent' });

    const auth = await signAsPayer({ intent: decodedIntent, payer: await getAddressFromPublicKey(payerKey.publicKey), nonceRef: slot, amount: AMOUNT }, payerKey);
    const authQr = await renderQr(encodeAuth(auth, flagsFromByte(intentBytes[2]!)));

    // ── merchant: scan the AUTH and verify offline ───────────────────────────────────────────────
    const scannedAuth = await decodeImage(pngOf(authQr.dataUrl), wasmUrl);
    expect(peekPayloadType(scannedAuth.bytes)).toBe('AUTH');
    const decodedAuth = decodeAuth(scannedAuth.bytes, { mintCache, intentFlags: flagsFromByte(intentBytes[2]!) });
    expect(decodedAuth).toEqual(auth);

    const payment = await verifyAuth(decodedIntent, decodedAuth);
    expect(payment.input.amount).toBe(AMOUNT);
    // The message the merchant verified is the message the payer signed, byte for byte.
    expect(payment.messageBytes).toEqual((await buildMessage({ intent, payer: payment.input.payer, nonceRef: slot, amount: AMOUNT })).messageBytes);
    // And the destination is derived, never transmitted.
    expect(await deriveAta(merchant, MINT, 'spl-token')).toBe(fixtures.cases[0]?.derived.destinationAta);
  });

  it('settles what it verified, and re-arms the slot from the 100-byte return (D28)', { timeout: 120_000 }, async () => {
    const { chain, payerKey, merchantKey, merchant, pool, queue } = await twoDevices();
    const intent = intentFor(merchant, AMOUNT);
    const slot = await pool.reserveSlot(merchant, Date.now());
    const spentAgainstValue = slot.value;
    const auth = await signAsPayer({ intent, payer: await getAddressFromPublicKey(payerKey.publicKey), nonceRef: slot, amount: AMOUNT }, payerKey);
    const payment = await verifyAuth(intent, auth);

    // ── merchant, online: pre-check, accept at T1, drain ────────────────────────────────────────
    const verdict = await precheckNonce(chain, payment);
    expect(verdict).toEqual({ ok: true, onChainValue: spentAgainstValue });
    await queue.accept(payment, 'T1', AMOUNT, verdict);
    const [outcome] = await queue.drain(merchantKey);
    expect(outcome?.kind).toBe('settled');
    if (outcome?.kind !== 'settled') throw new Error('unreachable');
    expect(outcome.newNonceValue).toBe(nextValue(spentAgainstValue));

    // ── merchant: sign the return; payer: scan it and re-arm, with the radio still off ──────────
    const returnBytes = encodeNonceReturn({
      nonceIndex: slot.index,
      newNonceValue: outcome.newNonceValue as Nonce,
      signature: await signNonceReturn(
        { payer: payment.input.payer, nonceIndex: slot.index, spentAgainstValue, newNonceValue: outcome.newNonceValue as Nonce },
        merchantKey,
      ),
    });
    const returnQr = await renderQr(returnBytes);
    const scanned = await decodeImage(pngOf(returnQr.dataUrl), wasmUrl);
    expect(peekPayloadType(scanned.bytes)).toBe('NONCE_RETURN');
    const status = await pool.applyNonceReturn(decodeNonceReturn(scanned.bytes));
    expect(status.slots[slot.index]).toMatchObject({ state: 'unspent', value: outcome.newNonceValue });

    // ── and the payer can pay again on the re-armed slot without ever reconnecting ──────────────
    const again = await pool.reserveSlot(merchant, Date.now());
    expect(again).toEqual({ index: slot.index, value: outcome.newNonceValue });
    const secondPayment = await verifyAuth(intent, await signAsPayer({ intent, payer: payment.input.payer, nonceRef: again, amount: AMOUNT }, payerKey));
    await queue.accept(secondPayment, 'T2', AMOUNT);
    const outcomes = await queue.drain(merchantKey);
    expect(outcomes.at(-1)?.kind).toBe('settled');
  });

  it('produces the committed fixture bytes for the fixture’s own input (cross-stream determinism)', async () => {
    const fixture = fixtures.cases.find((candidate) => candidate.name === 'nonce-dynamic-spl-no-ata');
    if (fixture === undefined) throw new Error('missing fixture');
    const intent = intentFor(fixture.input.intent.merchant as Address, BigInt(fixture.input.amount));
    const bytes = encodeIntent(intent);
    // The app path and the committed fixture agree on both halves of the air gap.
    expect(Buffer.from(bytes).toString('base64')).toBe(fixture.expected.wireIntent);
    const { messageBytes } = await buildMessage({
      intent,
      payer: fixture.input.payer as Address,
      nonceRef: { index: fixture.input.nonceRef?.index ?? 0, value: fixture.input.nonceRef?.value as Nonce },
      amount: BigInt(fixture.input.amount),
    });
    expect(Buffer.from(messageBytes).toString('base64')).toBe(fixture.expected.messageBytes);
  });
});

/** Exported for the scenario tests, which need the same two devices. */
export { intentFor, mintCache, twoDevices, type Pool };
