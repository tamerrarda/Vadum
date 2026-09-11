// Fixture generator — Stream 0 task 0.3 (plan/39-STREAM-0-bootstrap.md, plan/24-SPEC-fixtures.md).
//
//   node src/generate.ts           write fixtures.json
//   node src/generate.ts --check   regenerate in memory; fail unless fixtures.json matches byte-for-byte
//
// An independent reference implementation: kit and the program packages are imported directly, and no
// @vadum/* package is (D33). Every recorded value is self-checked against the specs before it is
// written, so a generator bug fails here rather than inside a stream's test suite.

import { readFile, writeFile } from 'node:fs/promises';
import {
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
  getTransactionEncoder,
  partiallySignTransaction,
  signBytes,
  verifySignature,
  type Address,
  type SignatureBytes,
  type Transaction,
} from '@solana/kit';
import QRCode from 'qrcode';
import { Base45Error, fromBase45, toBase45 } from './base45.ts';
import { addressBytes, bytesEqual, concat, toBase64 } from './bytes.ts';
import { buildMessage, deriveAta, deriveNonceAddress, type CanonicalInput, type Intent, type TokenProgram } from './canonical.ts';
import { nonceReturnRejection, nonceReturnSigningBytes, signNonceReturn, type NonceReturnStatement } from './nonce-return.ts';
import * as seeds from './seeds.ts';
import type {
  AuthJson,
  CanonicalInputJson,
  FixtureFile,
  IntentJson,
  MintRecordJson,
  NegativeCase,
  NegativeTarget,
  NonceReturnCase,
  PositiveCase,
  QrVersions,
  VerifiedPaymentJson,
} from './types.ts';
import { check, encodeAuth, encodeIntent, encodeNonceReturn, encodeStaticIntent, FLAG, Reject, type CachedMint, type Entry } from './wire.ts';

const OUTPUT = new URL('../fixtures.json', import.meta.url);
const PINNED_PACKAGES = ['@solana/kit', '@solana-program/system', '@solana-program/token', '@solana-program/token-2022', 'qrcode'];
const AMOUNT = 2_500_000n;
const DECIMALS = 6;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`fixture self-check failed: ${message}`);
}

// ─── keys and mints ─────────────────────────────────────────────────────────────────────────────────

async function keyFromSeed(seed: Uint8Array) {
  const keyPair = await createKeyPairFromPrivateKeyBytes(seed);
  return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
}

const payer = await keyFromSeed(seeds.PAYER_SEED);
const merchant = await keyFromSeed(seeds.MERCHANT_SEED);
const payer2 = await keyFromSeed(seeds.PAYER2_SEED);
const splMint = (await keyFromSeed(seeds.MINT_SEED)).address;
const t22Mint = (await keyFromSeed(seeds.MINT_T22_SEED)).address;

const mintRecords: MintRecordJson[] = [
  { mint: splMint, tokenProgram: 'spl-token', decimals: DECIMALS, compatible: true, blockers: [], warnings: [], mutable: false, checkedAt: 0 },
  { mint: t22Mint, tokenProgram: 'token-2022', decimals: DECIMALS, compatible: true, blockers: [], warnings: [], mutable: false, checkedAt: 0 },
];
const mintCache = new Map<string, CachedMint>(mintRecords.map((record) => [record.mint, record]));

// ─── base45 and QR, with the D29 properties asserted on every string ────────────────────────────────

/** 21-SPEC, measured QR sizes. */
const QR_VERSIONS_BY_LENGTH: Readonly<Record<number, QrVersions>> = {
  68: { M: 5, Q: 6 },
  76: { M: 5, Q: 7 },
  99: { M: 6, Q: 8 },
  100: { M: 6, Q: 8 },
  108: { M: 7, Q: 9 },
  132: { M: 8, Q: 10 },
  140: { M: 8, Q: 10 },
};
const BASE45_PREFIX_BY_TYPE: Readonly<Record<number, string>> = { 0x01: 'W50', 0x02: 'X50', 0x03: 'Y50', 0x04: 'Z50' };

function encodeForQr(payload: Uint8Array): { text: string; qr: QrVersions } {
  const text = toBase45(payload);
  assert(bytesEqual(fromBase45(text), payload), 'base45 round trip');
  assert(text.startsWith(BASE45_PREFIX_BY_TYPE[payload[1]!] ?? '?'), `base45 prefix for payload type ${payload[1]}`);
  assert(!text.endsWith(' '), 'a base45 string never ends with a space');
  const [M, Q] = (['M', 'Q'] as const).map((errorCorrectionLevel) => {
    // One explicit alphanumeric segment (D36). Automatic segmentation turns digit runs — the zero
    // bytes of a u64 amount — into numeric segments, which makes the version depend on content.
    const code = QRCode.create([{ data: text, mode: 'alphanumeric' }], { errorCorrectionLevel });
    const modes = code.segments.map((segment) => (segment as unknown as { mode: { id: string } }).mode.id);
    assert(modes.length === 1 && modes[0] === 'Alphanumeric', `a single alphanumeric QR segment, got ${modes.join('+')}`);
    return code.version;
  });
  const expected = QR_VERSIONS_BY_LENGTH[payload.length];
  assert(expected !== undefined && expected.M === M && expected.Q === Q, `QR versions for a ${payload.length}-byte payload: M=${M} Q=${Q}`);
  return { text, qr: { M: M!, Q: Q! } };
}

// ─── JSON conventions: base58 strings, base64 bytes, u64 as decimal strings ─────────────────────────

function intentJson(intent: Intent): IntentJson {
  return {
    merchant: intent.merchant,
    mint: intent.mint,
    decimals: intent.decimals,
    amount: intent.amount === null ? null : intent.amount.toString(),
    lifetime:
      intent.lifetime.kind === 'nonce'
        ? { kind: 'nonce' }
        : { kind: 'fresh', blockhash: intent.lifetime.blockhash, lastValidBlockHeight: intent.lifetime.lastValidBlockHeight.toString() },
    includeCreateAta: intent.includeCreateAta,
    tokenProgram: intent.tokenProgram,
    feePayer: intent.feePayer,
    isStatic: intent.isStatic,
  };
}

function canonicalInputJson(input: CanonicalInput): CanonicalInputJson {
  return {
    intent: intentJson(input.intent),
    payer: input.payer,
    nonceRef: input.nonceRef === null ? null : { index: input.nonceRef.index, value: input.nonceRef.value },
    amount: input.amount.toString(),
  };
}

// ─── payments ───────────────────────────────────────────────────────────────────────────────────────

interface Shape {
  readonly tokenProgram: TokenProgram;
  readonly includeCreateAta: boolean;
  readonly isStatic: boolean;
  readonly lifetime: 'nonce' | 'fresh';
  readonly amount: bigint;
  /** Replaces the merchant, and so the fee payer. Used only for the payer-is-fee-payer negative. */
  readonly merchant?: Address;
}

const DEFAULT_SHAPE: Shape = { tokenProgram: 'spl-token', includeCreateAta: false, isStatic: false, lifetime: 'nonce', amount: AMOUNT };

interface Payment {
  readonly input: CanonicalInput;
  readonly messageBytes: Uint8Array;
  readonly transaction: Transaction;
  readonly signature: Uint8Array;
  readonly flags: number;
  readonly wireIntent: Uint8Array;
  readonly wireAuth: Uint8Array;
  readonly auth: AuthJson;
}

async function buildPayment(shape: Shape): Promise<Payment> {
  const merchantAddress = shape.merchant ?? merchant.address;
  const fresh = shape.lifetime === 'fresh';
  const intent: Intent = {
    merchant: merchantAddress,
    mint: shape.tokenProgram === 'spl-token' ? splMint : t22Mint,
    decimals: DECIMALS,
    amount: shape.isStatic ? null : shape.amount,
    lifetime: fresh ? { kind: 'fresh', blockhash: seeds.BLOCKHASH, lastValidBlockHeight: 0n } : { kind: 'nonce' },
    includeCreateAta: shape.includeCreateAta,
    tokenProgram: shape.tokenProgram,
    feePayer: merchantAddress,
    isStatic: shape.isStatic,
  };
  const nonceRef = fresh ? null : { index: 0, value: seeds.NONCE_VALUE };
  const input: CanonicalInput = { intent, payer: payer.address, nonceRef, amount: shape.amount };
  const { messageBytes, transaction } = await buildMessage(input);

  const flipped = await buildMessage({ ...input, intent: { ...intent, isStatic: !intent.isStatic } });
  assert(bytesEqual(flipped.messageBytes, messageBytes), 'isStatic must not influence the compiled message (22-SPEC)');

  const signature = new Uint8Array(await signBytes(payer.keyPair.privateKey, messageBytes));
  assert(await verifySignature(payer.keyPair.publicKey, signature as SignatureBytes, messageBytes), 'the payer signature verifies');

  const flags =
    (fresh ? FLAG.LIFETIME_FRESH : 0) |
    (shape.includeCreateAta ? FLAG.INCLUDE_CREATE_ATA : 0) |
    (shape.tokenProgram === 'token-2022' ? FLAG.TOKEN_2022 : 0) |
    (shape.isStatic ? FLAG.AMOUNT_IN_AUTH : 0);
  const wireIntent = shape.isStatic
    ? encodeStaticIntent({ flags, merchant: intent.merchant, mint: intent.mint, decimals: DECIMALS })
    : encodeIntent({ flags, merchant: intent.merchant, mint: intent.mint, amount: shape.amount, decimals: DECIMALS, blockhash: fresh ? seeds.BLOCKHASH : null });
  const wireAuth = encodeAuth({ flags, payer: payer.address, nonce: nonceRef, amount: shape.isStatic ? shape.amount : null, signature });
  const auth: AuthJson = {
    payer: payer.address,
    nonceRef: nonceRef === null ? null : { index: nonceRef.index, value: nonceRef.value },
    amount: shape.isStatic ? shape.amount.toString() : null,
    signature: toBase64(signature),
  };
  return { input, messageBytes, transaction, signature, flags, wireIntent, wireAuth, auth };
}

// ─── positive cases (24-SPEC, required positive cases) ──────────────────────────────────────────────

const cases: PositiveCase[] = [];

async function positive(name: string, overrides: Partial<Shape>): Promise<{ record: PositiveCase; payment: Payment }> {
  const shape: Shape = { ...DEFAULT_SHAPE, ...overrides };
  const payment = await buildPayment(shape);
  const { intent, nonceRef } = payment.input;
  check(shape.isStatic ? 'decodeStaticIntent' : 'decodeIntent', payment.wireIntent, { mintCache });
  check('decodeAuth', payment.wireAuth, { intentFlags: payment.flags });

  const full = await partiallySignTransaction([payer.keyPair, merchant.keyPair], payment.transaction);
  const fullTransactionLength = getTransactionEncoder().encode(full).length;
  const [messageLength, transactionLength] = shape.lifetime === 'fresh' ? [248, 377] : shape.includeCreateAta ? [396, 525] : [354, 483];
  assert(payment.messageBytes[0] === 0x80, `${name}: v0 message marker (D18)`);
  assert(
    payment.messageBytes.length === messageLength && fullTransactionLength === transactionLength,
    `${name}: message ${payment.messageBytes.length} B, signed transaction ${fullTransactionLength} B`,
  );

  const intentQr = encodeForQr(payment.wireIntent);
  const authQr = encodeForQr(payment.wireAuth);
  const record: PositiveCase = {
    name,
    input: canonicalInputJson(payment.input),
    auth: payment.auth,
    expectedAmount: shape.isStatic ? shape.amount.toString() : null,
    derived: {
      nonceAddress: nonceRef === null ? null : await deriveNonceAddress(payer.address, nonceRef.index),
      sourceAta: await deriveAta(payer.address, intent.mint, intent.tokenProgram),
      destinationAta: await deriveAta(intent.merchant, intent.mint, intent.tokenProgram),
    },
    expected: {
      messageVersion: 0,
      messageBytes: toBase64(payment.messageBytes),
      messageByteLength: payment.messageBytes.length,
      wireFlags: payment.flags,
      wireIntent: toBase64(payment.wireIntent),
      wireIntentBase45: intentQr.text,
      wireAuth: toBase64(payment.wireAuth),
      wireAuthBase45: authQr.text,
      wireAuthBase45Length: authQr.text.length,
      qrVersions: { intent: intentQr.qr, auth: authQr.qr },
      signatureValid: true,
      fullTransactionLength,
    },
  };
  cases.push(record);
  return { record, payment };
}

const dynamic = await positive('nonce-dynamic-spl-no-ata', {});
await positive('nonce-dynamic-spl-with-ata', { includeCreateAta: true });
const staticSpl = await positive('nonce-static-spl', { isStatic: true });
await positive('nonce-dynamic-t22-no-ata', { tokenProgram: 'token-2022' });
await positive('nonce-dynamic-t22-with-ata', { tokenProgram: 'token-2022', includeCreateAta: true });
await positive('fresh-dynamic-spl-no-ata', { lifetime: 'fresh' });

// D29: the first amount from 2,500,000 whose AUTH base45 contains two adjacent spaces.
let doubleSpaceAmount = AMOUNT;
while (!toBase45((await buildPayment({ ...DEFAULT_SHAPE, amount: doubleSpaceAmount })).wireAuth).includes('  ')) {
  doubleSpaceAmount += 1n;
  assert(doubleSpaceAmount < AMOUNT + 10_000n, 'a double-space AUTH within 10,000 amounts');
}
const doubleSpace = await positive('base45-double-space', { amount: doubleSpaceAmount });

// ─── NONCE_RETURN (D20, D28) ────────────────────────────────────────────────────────────────────────

const statement: NonceReturnStatement = {
  payer: payer.address,
  nonceIndex: 0,
  spentAgainstValue: seeds.NONCE_VALUE,
  newNonceValue: seeds.NONCE_VALUE_NEXT,
};
const signingBytes = nonceReturnSigningBytes(statement);
assert(signingBytes.length === 118, 'the NONCE_RETURN statement is 118 bytes (D28)');
const returnSignature = await signNonceReturn(statement, merchant.keyPair.privateKey);
const returnWire = encodeNonceReturn(0, seeds.NONCE_VALUE_NEXT, returnSignature);
assert(returnWire.length === 100, 'NONCE_RETURN is 100 bytes');
check('decodeNonceReturn', returnWire);
const genuineLedger = { payer: payer.address, merchantPublicKey: merchant.keyPair.publicKey, spentAgainstValue: seeds.NONCE_VALUE };
assert(
  (await nonceReturnRejection({ nonceIndex: 0, newNonceValue: seeds.NONCE_VALUE_NEXT, signature: returnSignature }, genuineLedger)) === null,
  'the genuine NONCE_RETURN verifies',
);
const returnQr = encodeForQr(returnWire);
const nonceReturn: NonceReturnCase[] = [
  {
    name: 'nonce-return-signed',
    merchant: merchant.address,
    statement,
    expected: {
      signingBytes: toBase64(signingBytes),
      wireNonceReturn: toBase64(returnWire),
      wireNonceReturnBase45: returnQr.text,
      qrVersions: returnQr.qr,
      signatureValid: true,
    },
  },
];

// ─── negative cases (24-SPEC, required negative cases; written against the D30 check order) ─────────

const negative: NegativeCase[] = [];

function withByte(bytes: Uint8Array, index: number, value: number): Uint8Array {
  const out = bytes.slice();
  out[index] = value;
  return out;
}

function rejectionOf(run: () => unknown): { code: string; detail?: Readonly<Record<string, unknown>> | undefined } {
  try {
    run();
  } catch (error) {
    if (error instanceof Reject) return { code: error.code, detail: error.detail };
    if (error instanceof Base45Error) return { code: 'WIRE_BASE45_INVALID' };
    throw error;
  }
  throw new Error('fixture self-check failed: the reference decoder accepted a negative payload');
}

function codecCase(
  name: string,
  entry: Entry,
  bytes: Uint8Array,
  context: { readonly mintCache?: boolean; readonly intentFlags?: number },
  expectedError: string,
  note: string,
  expectedDetail?: Readonly<Record<string, unknown>>,
): void {
  const got = rejectionOf(() => check(entry, bytes, { mintCache: context.mintCache ? mintCache : undefined, intentFlags: context.intentFlags }));
  assert(got.code === expectedError, `${name}: the reference decoder raised ${got.code}, expected ${expectedError}`);
  assert(expectedDetail === undefined || JSON.stringify(got.detail) === JSON.stringify(expectedDetail), `${name}: detail ${JSON.stringify(got.detail)}`);
  const recordedContext = {
    ...(context.mintCache ? { mintCache: mintRecords.map((record) => record.mint) } : {}),
    ...(context.intentFlags === undefined ? {} : { intentFlags: context.intentFlags }),
  };
  negative.push({
    name,
    target: `wire.${entry}` as NegativeTarget,
    input: { bytes: toBase64(bytes) },
    ...(Object.keys(recordedContext).length > 0 ? { context: recordedContext } : {}),
    expectedError,
    ...(expectedDetail === undefined ? {} : { expectedDetail }),
    note,
  });
}

function base45Case(name: string, text: string, note: string): void {
  assert(rejectionOf(() => fromBase45(text)).code === 'WIRE_BASE45_INVALID', `${name}: fromBase45 rejects it`);
  negative.push({ name, target: 'wire.fromBase45', input: { base45: text }, expectedError: 'WIRE_BASE45_INVALID', note });
}

const dynamicIntent = dynamic.payment.wireIntent;
const dynamicAuth = dynamic.payment.wireAuth;
const staticIntent = staticSpl.payment.wireIntent;
const dynamicAuthBase45 = dynamic.record.expected.wireAuthBase45;

// Codec.
codecCase('bad-version', 'decodeAuth', withByte(dynamicAuth, 0, 0x02), { intentFlags: 0 }, 'WIRE_VERSION_UNSUPPORTED',
  'the nonce-dynamic-spl-no-ata AUTH with version byte 0x02');
codecCase('bad-unknown-type', 'peekPayloadType', withByte(dynamicAuth, 1, 0x05), {}, 'WIRE_UNKNOWN_TYPE',
  'the nonce-dynamic-spl-no-ata AUTH with type byte 0x05');
codecCase('bad-unexpected-type', 'decodeIntent', returnWire, { mintCache: true }, 'WIRE_UNEXPECTED_TYPE',
  'the nonce-return-signed payload handed to the INTENT decoder', { expected: 'INTENT', actual: 'NONCE_RETURN' });
codecCase('bad-reserved-flag', 'decodeAuth', withByte(dynamicAuth, 2, 0x20), { intentFlags: 0 }, 'WIRE_RESERVED_FLAG_SET',
  'AUTH flags 0x20 (bit 5)');
codecCase('bad-fee-payer-separate-set', 'decodeIntent', withByte(dynamicIntent, 2, 0x08), { mintCache: true }, 'WIRE_FEE_PAYER_SEPARATE_UNSUPPORTED',
  'INTENT flags 0x08 (bit 3)');
codecCase('bad-static-fee-payer-separate', 'decodeStaticIntent', withByte(staticIntent, 2, 0x18), { mintCache: true }, 'WIRE_FEE_PAYER_SEPARATE_UNSUPPORTED',
  'STATIC_INTENT flags 0x18 (bits 3 and 4); check-order step 6 precedes step 7 (D30)');
codecCase('bad-intent-amount-in-auth', 'decodeIntent', withByte(dynamicIntent, 2, 0x10), { mintCache: true }, 'WIRE_FLAG_NOT_ALLOWED_FOR_TYPE',
  'dynamic INTENT flags 0x10 (AMOUNT_IN_AUTH)', { type: 'INTENT', flag: 'AMOUNT_IN_AUTH' });
codecCase('bad-nonce-return-flags', 'decodeNonceReturn', withByte(returnWire, 2, 0x01), {}, 'WIRE_FLAG_NOT_ALLOWED_FOR_TYPE',
  'NONCE_RETURN flags 0x01 (bit 0)', { type: 'NONCE_RETURN', flag: 'LIFETIME_FRESH' });
codecCase('bad-static-fresh', 'decodeStaticIntent', withByte(staticIntent, 2, 0x11), { mintCache: true }, 'WIRE_STATIC_CONSTRAINT',
  'STATIC_INTENT flags 0x11 (LIFETIME_FRESH together with AMOUNT_IN_AUTH)');
codecCase('bad-static-no-amount-flag', 'decodeStaticIntent', withByte(staticIntent, 2, 0x00), { mintCache: true }, 'WIRE_STATIC_CONSTRAINT',
  'STATIC_INTENT flags 0x00 (AMOUNT_IN_AUTH clear)');
codecCase('bad-length-short', 'decodeAuth', dynamicAuth.slice(0, -1), { intentFlags: 0 }, 'WIRE_LENGTH_MISMATCH',
  'the 132-byte AUTH minus its last byte');
codecCase('bad-length-trailing', 'decodeAuth', concat(dynamicAuth, Uint8Array.of(0)), { intentFlags: 0 }, 'WIRE_LENGTH_MISMATCH',
  'the 132-byte AUTH plus one zero byte');
codecCase('bad-auth-flags-mismatch', 'decodeAuth', withByte(dynamicAuth, 2, 0x02), { intentFlags: 0 }, 'WIRE_FLAGS_MISMATCH',
  'AUTH flags 0x02 answering an intent with flags 0x00; the length is unaffected');
const unknownMintIntent = dynamicIntent.slice();
unknownMintIntent.set(addressBytes(payer2.address), 35);
codecCase('bad-mint-unknown', 'decodeIntent', unknownMintIntent, { mintCache: true }, 'MINT_UNKNOWN',
  'an INTENT whose mint is the PAYER2 address, which is absent from mintRecords');
codecCase('bad-decimals-mismatch', 'decodeIntent', withByte(dynamicIntent, 75, 9), { mintCache: true }, 'MINT_DECIMALS_MISMATCH',
  'INTENT decimals 9 for a mint cached with 6');
codecCase('bad-token-program-mismatch', 'decodeIntent', withByte(dynamicIntent, 2, 0x04), { mintCache: true }, 'MINT_TOKEN_PROGRAM_MISMATCH',
  'the legacy SPL Token test mint with the TOKEN_2022 flag set (D30)');
base45Case('bad-base45-out-of-alphabet', `y${dynamicAuthBase45.slice(1)}`,
  'the nonce-dynamic-spl-no-ata AUTH string with its first character lowercased');
base45Case('bad-base45-bad-length', `${dynamicAuthBase45}0`,
  'the same string plus one character: length 199, and 199 % 3 == 1');
base45Case('bad-base45-group-overflow', ':::',
  'one 3-character group decoding to 91,124, above 0xFFFF');
base45Case('bad-base45-tail-overflow', '000::',
  'a valid group followed by a 2-character tail decoding to 2,024, above 0xFF');

const collapsedText = doubleSpace.record.expected.wireAuthBase45.replace('  ', ' ');
const collapsed = rejectionOf(() => check('decodeAuth', fromBase45(collapsedText), { intentFlags: doubleSpace.payment.flags }));
negative.push({
  name: 'bad-base45-whitespace-collapsed',
  target: 'wire.fromBase45 → wire.decodeAuth',
  input: { base45: collapsedText },
  context: { intentFlags: doubleSpace.payment.flags },
  expectedError: collapsed.code,
  note: `the base45-double-space string with its double space collapsed to one; the reference decoder raises ${collapsed.code} (D29)`,
});

// Core.
const tampered = dynamic.payment.signature.slice();
tampered[0] = tampered[0]! ^ 0x01;
assert(!(await verifySignature(payer.keyPair.publicKey, tampered as SignatureBytes, dynamic.payment.messageBytes)), 'a tampered signature fails');
negative.push({
  name: 'bad-signature-tampered',
  target: 'core.verifyAuth',
  input: { intent: dynamic.record.input.intent, auth: { ...dynamic.payment.auth, signature: toBase64(tampered) }, expectedAmount: null },
  expectedError: 'SIG_INVALID',
  note: 'nonce-dynamic-spl-no-ata with bit 0 of the payer signature flipped',
});

const selfPaid = await buildPayment({ ...DEFAULT_SHAPE, merchant: payer.address });
assert(selfPaid.input.intent.feePayer === selfPaid.input.payer, 'the fee payer is the payer');
negative.push({
  name: 'bad-fee-payer-is-payer',
  target: ['core.verifyAuth', 'core.signAsPayer'],
  input: {
    'core.verifyAuth': { intent: intentJson(selfPaid.input.intent), auth: selfPaid.auth, expectedAmount: null },
    'core.signAsPayer': { input: canonicalInputJson(selfPaid.input), payerSeed: 'PAYER_SEED' },
  },
  expectedError: 'WIRE_FEE_PAYER_IS_PAYER',
  note: 'an intent whose merchant, and so fee payer, is the payer; the signature is valid, so receive rule 9 is the only failure (D30)',
});

negative.push({
  name: 'bad-static-amount-mismatch',
  target: 'core.verifyAuth',
  input: { intent: staticSpl.record.input.intent, auth: staticSpl.payment.auth, expectedAmount: '5000000' },
  expectedError: 'CANON_AMOUNT_MISMATCH',
  note: 'nonce-static-spl verified with expectedAmount 5000000 against an AUTH for 2500000',
});
negative.push({
  name: 'bad-static-no-expected-amount',
  target: 'core.verifyAuth',
  input: { intent: staticSpl.record.input.intent, auth: staticSpl.payment.auth, expectedAmount: null },
  expectedError: 'CANON_AMOUNT_MISMATCH',
  expectedDetail: { expected: null },
  note: 'nonce-static-spl verified without expectedAmount (D30)',
});
negative.push({
  name: 'bad-mint-hook-active',
  target: 'core.evaluateMint → core.assertMintCompatible',
  input: {
    raw: {
      mint: t22Mint,
      tokenProgram: 'token-2022',
      decimals: DECIMALS,
      freezeAuthority: null,
      extensions: [{ extension: 'transferHook', state: { authority: merchant.address, programId: payer2.address } }],
    },
    checkedAt: 0,
  },
  expectedError: 'MINT_INCOMPATIBLE',
  expectedDetail: { blockers: ['transfer-hook-active'] },
  note: 'RawMintData with a transferHook extension whose programId is set (to the PAYER2 address); no chain involved',
});

async function nonceReturnCase(
  name: string,
  received: { readonly signature: Uint8Array; readonly newNonceValue: string },
  ledger: { readonly payer: Address; readonly spentAgainstValue: string },
  reason: 'signature' | 'unchanged-value',
  note: string,
): Promise<void> {
  const rejection = await nonceReturnRejection({ nonceIndex: 0, ...received }, { ...ledger, merchantPublicKey: merchant.keyPair.publicKey });
  assert(rejection === reason, `${name}: reference verification says ${rejection}, expected ${reason}`);
  negative.push({
    name,
    target: 'core.verifyNonceReturn',
    input: {
      received: { nonceIndex: 0, newNonceValue: received.newNonceValue, signature: toBase64(received.signature) },
      ledger: { payer: ledger.payer, merchant: merchant.address, spentAgainstValue: ledger.spentAgainstValue },
    },
    expectedError: 'NONCE_RETURN_UNTRUSTED',
    note,
  });
}

await nonceReturnCase(
  'bad-nonce-return-wrong-signer',
  { signature: await signNonceReturn(statement, payer2.keyPair.privateKey), newNonceValue: seeds.NONCE_VALUE_NEXT },
  { payer: payer.address, spentAgainstValue: seeds.NONCE_VALUE },
  'signature',
  'the correct statement signed by PAYER2 instead of the merchant recorded in the ledger',
);
await nonceReturnCase(
  'bad-nonce-return-other-payer',
  { signature: returnSignature, newNonceValue: seeds.NONCE_VALUE_NEXT },
  { payer: payer2.address, spentAgainstValue: seeds.NONCE_VALUE },
  'signature',
  'the genuine nonce-return-signed payload verified by PAYER2, whose ledger has slot 0 spent at the same merchant against the same value — the D28 regression test',
);
await nonceReturnCase(
  'bad-nonce-return-other-prior-value',
  { signature: await signNonceReturn({ ...statement, spentAgainstValue: seeds.NONCE_VALUE_PREV }, merchant.keyPair.privateKey), newNonceValue: seeds.NONCE_VALUE_NEXT },
  { payer: payer.address, spentAgainstValue: seeds.NONCE_VALUE },
  'signature',
  'a genuine return signed over NONCE_VALUE_PREV, verified against a ledger recording NONCE_VALUE (D28)',
);
await nonceReturnCase(
  'bad-nonce-return-unchanged-value',
  { signature: await signNonceReturn({ ...statement, newNonceValue: seeds.NONCE_VALUE }, merchant.keyPair.privateKey), newNonceValue: seeds.NONCE_VALUE },
  { payer: payer.address, spentAgainstValue: seeds.NONCE_VALUE },
  'unchanged-value',
  'a genuinely signed return whose newNonceValue equals the recorded spentAgainstValue',
);

// Client.
const payment: VerifiedPaymentJson = { input: dynamic.record.input, messageBytes: dynamic.record.expected.messageBytes, auth: dynamic.payment.auth };
const dedupeKey = `nonce:${payer.address}:0:${seeds.NONCE_VALUE}`; // D31
const limits = {
  // 31-PARAMETERS (D23), in base units. T0 has no cap; it is recorded as u64 max.
  receiptCapByTier: { T0: ((1n << 64n) - 1n).toString(), T1: '20000000', T2: '5000000' },
  queueExposureCap: '50000000',
  maxConsecutiveFailedSends: 3,
  sendWindowMs: 86_400_000,
};
const priorEntry = (state: string) => ({ id: dedupeKey, state, tier: 'T2', amount: AMOUNT.toString() });
negative.push({
  name: 'bad-duplicate-auth-live',
  target: 'client.queue.accept',
  input: { payment, tier: 'T2', amount: AMOUNT.toString(), precheck: null },
  context: { limits, queue: [priorEntry('queued')] },
  expectedError: 'WIRE_DUPLICATE_AUTH',
  note: `the queue already holds ${dedupeKey} in state queued`,
});
negative.push({
  name: 'bad-duplicate-auth-settled',
  target: 'client.queue.accept',
  input: { payment, tier: 'T2', amount: AMOUNT.toString(), precheck: null },
  context: { limits, queue: [priorEntry('settled')] },
  expectedError: 'WIRE_DUPLICATE_AUTH',
  note: `the queue already holds ${dedupeKey} in state settled (D31)`,
});
negative.push({
  name: 'bad-t1-without-precheck',
  target: 'client.queue.accept',
  input: { payment, tier: 'T1', amount: AMOUNT.toString(), precheck: null },
  context: { limits, queue: [] },
  expectedError: 'LIMIT_PRECHECK_REQUIRED',
  note: 'tier T1 on the nonce path with no NonceVerdict (D30)',
});

assert(cases.length + nonceReturn.length === 8, `eight positive cases, have ${cases.length + nonceReturn.length}`);
assert(negative.length === 33, `thirty-three negative cases, have ${negative.length}`);
assert(new Set(negative.map((entry) => entry.name)).size === negative.length, 'negative case names are unique');

// ─── output ─────────────────────────────────────────────────────────────────────────────────────────

async function installedVersion(name: string): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

const file: FixtureFile = {
  _warning: 'DEVNET TEST KEYS. Zero value. Never reuse.',
  generator: 'packages/fixtures/src/generate.ts',
  packages: Object.fromEntries(await Promise.all(PINNED_PACKAGES.map(async (name) => [name, await installedVersion(name)] as const))),
  mints: {
    spl: { address: splMint, description: 'Throwaway test mint: legacy SPL Token, 6 decimals, no extensions (D24). Not USDC.' },
    t22: { address: t22Mint, description: 'Throwaway test mint: Token-2022, null transfer hook, zero transfer fee. Not USDG or PYUSD.' },
  },
  mintRecords,
  cases,
  nonceReturn,
  negative,
};
const text = `${JSON.stringify(file, null, 2)}\n`;
const summary = `${cases.length + nonceReturn.length} positive, ${negative.length} negative`;

if (process.argv.includes('--check')) {
  const committed = await readFile(OUTPUT, 'utf8').catch(() => null);
  if (committed === text) {
    console.log(`fixtures: fixtures.json reproduces byte-for-byte (${summary})`);
  } else {
    if (committed === null) {
      console.error('fixtures: fixtures.json is missing — run `pnpm fixtures:generate`');
    } else {
      const generated = text.split('\n');
      const existing = committed.split('\n');
      const line = generated.findIndex((value, index) => value !== existing[index]);
      const at = line === -1 ? generated.length : line;
      console.error(`fixtures: fixtures.json differs from a fresh generation at line ${at + 1}`);
      console.error(`  committed: ${existing[at] ?? '<end of file>'}`);
      console.error(`  generated: ${generated[at] ?? '<end of file>'}`);
    }
    console.error('A difference is never "update the fixture": it is a dependency or spec change (24-SPEC).');
    process.exitCode = 1;
  }
} else {
  await writeFile(OUTPUT, text);
  console.log(`fixtures: wrote fixtures.json (${summary})`);
}
