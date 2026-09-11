// A2/A3/A5/A6 edge cases: misuse, malformed input, and what the wire transaction actually carries.

import {
  createKeyPairFromPrivateKeyBytes,
  generateKeyPair,
  getAddressFromPublicKey,
  getTransactionDecoder,
  verifySignature,
  type Address,
  type Nonce,
} from '@solana/kit';
import { fixtures, MERCHANT_SEED, PAYER_SEED, type PositiveCase } from '@vadum/fixtures';
import { describe, expect, it } from 'vitest';
import {
  buildMessage,
  buildWireTransaction,
  deriveAta,
  durableNonceProvider,
  freshBlockhashProvider,
  NONCE_RETURN_DOMAIN,
  nonceReturnSigningBytes,
  nonceSeed,
  signAsPayer,
  signNonceReturn,
  tokenProgramAddress,
  verifyAuth,
  verifyNonceReturn,
} from '../src/index.ts';
import { authFrom, expectVadumError, inputFrom, intentFrom, prng, randomAddress, toBase64 } from './helpers.ts';

const caseNamed = (name: string): PositiveCase => {
  const found = fixtures.cases.find((fixture) => fixture.name === name);
  if (found === undefined) throw new Error(`no positive fixture named ${name}`);
  return found;
};

const dynamicCase = caseNamed('nonce-dynamic-spl-no-ata');
const staticCase = caseNamed('nonce-static-spl');
const freshCase = caseNamed('fresh-dynamic-spl-no-ata');

describe('derive', () => {
  it('names slots vadum-0 to vadum-255 and nothing else', async () => {
    expect(nonceSeed(0)).toBe('vadum-0');
    expect(nonceSeed(255)).toBe('vadum-255');
    for (const index of [-1, 256, 1.5, Number.NaN]) await expectVadumError(() => nonceSeed(index), 'NONCE_INDEX_OUT_OF_RANGE');
  });

  it('derives different ATAs for the same owner and mint under the two token programs (TOK-4)', async () => {
    const { payer, intent } = inputFrom(dynamicCase.input);
    expect(await deriveAta(payer, intent.mint, 'spl-token')).not.toBe(await deriveAta(payer, intent.mint, 'token-2022'));
    expect(tokenProgramAddress('spl-token')).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    expect(tokenProgramAddress('token-2022')).toBe('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  });
});

describe('nonce providers (D17)', () => {
  it('claims at-most-once for durable nonce only', () => {
    expect([durableNonceProvider.kind, durableNonceProvider.guaranteesAtMostOnce]).toEqual(['durable-nonce', true]);
    expect([freshBlockhashProvider.kind, freshBlockhashProvider.guaranteesAtMostOnce]).toEqual(['fresh-blockhash', false]);
  });
});

describe('buildMessage', () => {
  const input = inputFrom(dynamicCase.input);

  it('refuses an amount outside u64, and one that differs from the intent', async () => {
    const withAmount = (amount: bigint) => ({ ...input, intent: { ...input.intent, amount }, amount });
    await expectVadumError(() => buildMessage(withAmount(-1n)), 'CANON_AMOUNT_MISMATCH');
    await expectVadumError(() => buildMessage(withAmount(1n << 64n)), 'CANON_AMOUNT_MISMATCH');
    await expectVadumError(() => buildMessage({ ...input, amount: input.amount + 1n }), 'CANON_AMOUNT_MISMATCH');
  });

  it('refuses decimals outside u8', async () => {
    await expectVadumError(() => buildMessage({ ...input, intent: { ...input.intent, decimals: 256 } }), 'MINT_DECIMALS_MISMATCH');
  });

  it('refuses a lifetime that disagrees with the nonce reference', async () => {
    await expectVadumError(() => buildMessage({ ...input, nonceRef: null }), 'INTERNAL_NOT_APPLICABLE');
    const fresh = inputFrom(freshCase.input);
    const nonceRef = { index: 0, value: randomAddress(prng(8)) as string as Nonce };
    await expectVadumError(() => buildMessage({ ...fresh, nonceRef }), 'INTERNAL_NOT_APPLICABLE');
  });

  it('ignores lastValidBlockHeight on the fresh path', async () => {
    const fresh = inputFrom(freshCase.input);
    if (fresh.intent.lifetime.kind !== 'fresh') throw new Error('expected a fresh-path fixture');
    const moved = { ...fresh, intent: { ...fresh.intent, lifetime: { ...fresh.intent.lifetime, lastValidBlockHeight: 987_654_321n } } };
    expect(toBase64((await buildMessage(moved)).messageBytes)).toBe(freshCase.expected.messageBytes);
  });
});

describe('verifyAuth', () => {
  const intent = intentFrom(dynamicCase.input.intent);
  const auth = authFrom(dynamicCase.auth);
  const amount = BigInt(dynamicCase.input.amount);

  it('refuses a dynamic AUTH that carries a second amount', async () => {
    await expectVadumError(() => verifyAuth(intent, { ...auth, amount }), 'CANON_AMOUNT_MISMATCH');
  });

  it('refuses a dynamic expectedAmount that disagrees with the intent, and accepts one that agrees', async () => {
    await expectVadumError(() => verifyAuth(intent, auth, amount + 1n), 'CANON_AMOUNT_MISMATCH', { expected: String(amount + 1n), actual: String(amount) });
    await verifyAuth(intent, auth, amount);
  });

  it('refuses a static AUTH without an amount', async () => {
    const staticAuth = authFrom(staticCase.auth);
    const expected = BigInt(staticCase.expectedAmount ?? '0');
    await expectVadumError(() => verifyAuth(intentFrom(staticCase.input.intent), { ...staticAuth, amount: null }, expected), 'CANON_AMOUNT_MISMATCH');
  });

  it('refuses a signature that is not 64 bytes', async () => {
    await expectVadumError(() => verifyAuth(intent, { ...auth, signature: auth.signature.subarray(0, 63) }), 'SIG_LENGTH', { length: 63 });
  });

  it('turns a payer address that is not a public key into SIG_INVALID', async () => {
    const offCurve = dynamicCase.derived.sourceAta as Address; // an ATA is a PDA, so off the curve
    await expectVadumError(() => verifyAuth(intent, { ...auth, payer: offCurve }), 'SIG_INVALID');
  });

  it('refuses a slot index outside 0..255', async () => {
    const nonceRef = { index: 256, value: auth.nonceRef?.value ?? ('' as Nonce) };
    await expectVadumError(() => verifyAuth(intent, { ...auth, nonceRef }), 'NONCE_INDEX_OUT_OF_RANGE');
  });
});

describe('signAsPayer', () => {
  const input = inputFrom(dynamicCase.input);

  it('refuses a key that is not the payer', async () => {
    await expectVadumError(async () => signAsPayer(input, await generateKeyPair()), 'CANON_ACCOUNT_MISMATCH');
  });

  it('refuses an intent whose static flag disagrees with its amount', async () => {
    const key = await createKeyPairFromPrivateKeyBytes(PAYER_SEED);
    await expectVadumError(() => signAsPayer({ ...input, intent: { ...input.intent, isStatic: true } }, key), 'CANON_AMOUNT_MISMATCH');
  });

  it('puts the amount in the AUTH in static mode only', async () => {
    const key = await createKeyPairFromPrivateKeyBytes(PAYER_SEED);
    expect((await signAsPayer(input, key)).amount).toBeNull();
    const staticInput = inputFrom(staticCase.input);
    expect((await signAsPayer(staticInput, key)).amount).toBe(staticInput.amount);
  });
});

describe('buildWireTransaction', () => {
  it('carries the fee-payer and payer signatures in header order, both valid', async () => {
    const payment = await verifyAuth(intentFrom(dynamicCase.input.intent), authFrom(dynamicCase.auth));
    const merchantKey = await createKeyPairFromPrivateKeyBytes(MERCHANT_SEED);
    const transaction = getTransactionDecoder().decode(await buildWireTransaction(payment, merchantKey));
    expect(toBase64(new Uint8Array(transaction.messageBytes))).toBe(dynamicCase.expected.messageBytes);

    const entries = Object.entries(transaction.signatures);
    expect(entries.map(([address]) => address)).toEqual([dynamicCase.input.intent.feePayer, dynamicCase.input.payer]);
    const feePayerSignature = entries[0]?.[1];
    const payerSignature = entries[1]?.[1];
    if (feePayerSignature == null || payerSignature == null) throw new Error('a signature slot is empty');
    expect(await verifySignature(merchantKey.publicKey, feePayerSignature, payment.messageBytes)).toBe(true);
    expect(toBase64(new Uint8Array(payerSignature))).toBe(dynamicCase.auth.signature);
  });

  it('refuses a key that is not the fee payer', async () => {
    const payment = await verifyAuth(intentFrom(dynamicCase.input.intent), authFrom(dynamicCase.auth));
    await expectVadumError(async () => buildWireTransaction(payment, await createKeyPairFromPrivateKeyBytes(PAYER_SEED)), 'SIG_FEE_PAYER_MISSING');
  });
});

describe('nonce return', () => {
  it('signs 118 bytes that start with the 21-byte domain tag', () => {
    const next = prng(9);
    const bytes = nonceReturnSigningBytes({
      payer: randomAddress(next),
      nonceIndex: 7,
      spentAgainstValue: randomAddress(next) as string as Nonce,
      newNonceValue: randomAddress(next) as string as Nonce,
    });
    expect(NONCE_RETURN_DOMAIN.length).toBe(21);
    expect(bytes.length).toBe(118);
    expect(bytes.subarray(0, 21)).toEqual(NONCE_RETURN_DOMAIN);
    expect(bytes[53]).toBe(7);
  });

  it('answers malformed input with NONCE_RETURN_UNTRUSTED and nothing else', async () => {
    const next = prng(10);
    const merchantKey = await generateKeyPair();
    const merchant = await getAddressFromPublicKey(merchantKey.publicKey);
    const statement = {
      payer: randomAddress(next),
      nonceIndex: 1,
      spentAgainstValue: randomAddress(next) as string as Nonce,
      newNonceValue: randomAddress(next) as string as Nonce,
    };
    const signature = await signNonceReturn(statement, merchantKey);
    const ledger = { payer: statement.payer, merchant, spentAgainstValue: statement.spentAgainstValue };
    const received = { nonceIndex: 1, newNonceValue: statement.newNonceValue, signature };

    await verifyNonceReturn(received, ledger);
    await expectVadumError(() => verifyNonceReturn({ ...received, nonceIndex: 256 }, ledger), 'NONCE_RETURN_UNTRUSTED');
    await expectVadumError(() => verifyNonceReturn({ ...received, nonceIndex: 2 }, ledger), 'NONCE_RETURN_UNTRUSTED');
    await expectVadumError(() => verifyNonceReturn({ ...received, signature: signature.subarray(0, 63) }, ledger), 'NONCE_RETURN_UNTRUSTED');
    await expectVadumError(() => verifyNonceReturn({ ...received, newNonceValue: 'not base58' as string as Nonce }, ledger), 'NONCE_RETURN_UNTRUSTED');
    await expectVadumError(() => verifyNonceReturn(received, { ...ledger, merchant: randomAddress(next) }), 'NONCE_RETURN_UNTRUSTED');
  });
});
