// A8: property tests over seeded random inputs (plan/40-STREAM-A-core.md).

import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  setTransactionMessageFeePayer,
  verifySignature,
  type Instruction,
  type Nonce,
  type SignatureBytes,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { getApproveInstruction, getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token';
import { describe, expect, it } from 'vitest';
import {
  assertCanonical,
  buildMessage,
  deriveAta,
  durableNonceProvider,
  freshBlockhashProvider,
  signAsPayer,
  signNonceReturn,
  tokenProgramAddress,
  VadumError,
  verifyAuth,
  verifyNonceReturn,
  type CanonicalInput,
} from '../src/index.ts';
import { expectVadumError, prng, randomAddress, randomInput } from './helpers.ts';

const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);

describe('determinism', () => {
  it('compiles 1000 random inputs identically twice, and identically with isStatic flipped', { timeout: 120_000 }, async () => {
    const next = prng(1);
    for (let run = 0; run < 1000; run++) {
      const input = randomInput(next);
      const first = (await buildMessage(input)).messageBytes;
      const second = (await buildMessage(input)).messageBytes;
      const flipped = (await buildMessage({ ...input, intent: { ...input.intent, isStatic: !input.intent.isStatic } })).messageBytes;
      expect(bytesEqual(first, second), `run ${run}`).toBe(true);
      expect(bytesEqual(first, flipped), `run ${run}: isStatic changed the bytes`).toBe(true);
      expect(first[0]).toBe(0x80);
    }
  });
});

describe('round trip', () => {
  it('signAsPayer then verifyAuth always succeeds', { timeout: 120_000 }, async () => {
    const next = prng(2);
    for (let run = 0; run < 200; run++) {
      const key = await generateKeyPair();
      const input = randomInput(next, await getAddressFromPublicKey(key.publicKey));
      const auth = await signAsPayer(input, key);
      const payment = await verifyAuth(input.intent, auth, input.intent.isStatic ? input.amount : undefined);
      expect(bytesEqual(payment.messageBytes, (await buildMessage(input)).messageBytes), `run ${run}`).toBe(true);
    }
  });
});

describe('tamper resistance', () => {
  it('flipping any single bit of the message breaks the signature', { timeout: 120_000 }, async () => {
    const key = await generateKeyPair();
    const input = randomInput(prng(3), await getAddressFromPublicKey(key.publicKey));
    const auth = await signAsPayer(input, key);
    const message = (await buildMessage(input)).messageBytes;
    for (let bit = 0; bit < message.length * 8; bit++) {
      const tampered = message.slice();
      tampered[bit >> 3] = tampered[bit >> 3]! ^ (1 << (bit & 7));
      expect(await verifySignature(key.publicKey, auth.signature as SignatureBytes, tampered), `bit ${bit}`).toBe(false);
    }
  });
});

describe('whitelist', () => {
  /** The canonical instructions plus one extra, compiled through the same lifetime provider. */
  async function spliced(input: CanonicalInput, extra: Instruction, atStart: boolean): Promise<Uint8Array> {
    const { intent, payer, amount } = input;
    const programAddress = tokenProgramAddress(intent.tokenProgram);
    const source = await deriveAta(payer, intent.mint, intent.tokenProgram);
    const destination = await deriveAta(intent.merchant, intent.mint, intent.tokenProgram);
    const canonical: Instruction[] = [];
    if (intent.includeCreateAta) {
      canonical.push(getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(intent.feePayer), ata: destination, owner: intent.merchant, mint: intent.mint, tokenProgram: programAddress }));
    }
    canonical.push(getTransferCheckedInstruction({ source, mint: intent.mint, destination, authority: createNoopSigner(payer), amount, decimals: intent.decimals }, { programAddress }));
    const instructions = atStart ? [extra, ...canonical] : [...canonical, extra];
    const draft = appendTransactionMessageInstructions(instructions, setTransactionMessageFeePayer(intent.feePayer, createTransactionMessage({ version: 0 })));
    const provider = intent.lifetime.kind === 'nonce' ? durableNonceProvider : freshBlockhashProvider;
    return new Uint8Array(compileTransaction(await provider.applyLifetime(draft, input)).messageBytes);
  }

  it('no instruction outside {AdvanceNonce?, CreateAtaIdempotent?, TransferChecked} survives', { timeout: 120_000 }, async () => {
    const next = prng(5);
    for (let run = 0; run < 120; run++) {
      const input = randomInput(next);
      const programAddress = tokenProgramAddress(input.intent.tokenProgram);
      const source = await deriveAta(input.payer, input.intent.mint, input.intent.tokenProgram);
      const payer = createNoopSigner(input.payer);
      const extras: Instruction[] = [
        getTransferSolInstruction({ source: payer, destination: randomAddress(next), amount: 1n }),
        getApproveInstruction({ source, delegate: randomAddress(next), owner: payer, amount: 1n }, { programAddress }),
        getCloseAccountInstruction({ account: source, destination: randomAddress(next), owner: payer }, { programAddress }),
        getTransferCheckedInstruction({ source, mint: input.intent.mint, destination: randomAddress(next), authority: payer, amount: 1n, decimals: input.intent.decimals }, { programAddress }),
        { programAddress: randomAddress(next), accounts: [], data: Uint8Array.of(1, 2, 3) },
      ];
      const extra = extras[run % extras.length]!;
      const error = await expectRejected(async () => assertCanonical(await spliced(input, extra, next() < 0.5), input));
      expect(error.code, `run ${run}`).toMatch(/^CANON_/);
    }
  });
});

async function expectRejected(run: () => Promise<unknown>): Promise<VadumError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof VadumError) return error;
    throw error;
  }
  throw new Error('a tampered message passed assertCanonical');
}

describe('recovery binding (D28)', () => {
  it('a NONCE_RETURN signed for one (payer, prior value) never verifies for another', { timeout: 120_000 }, async () => {
    const next = prng(6);
    const merchantKey = await generateKeyPair();
    const merchant = await getAddressFromPublicKey(merchantKey.publicKey);
    for (let run = 0; run < 100; run++) {
      const statement = {
        payer: randomAddress(next),
        nonceIndex: Math.floor(next() * 256),
        spentAgainstValue: randomAddress(next) as string as Nonce,
        newNonceValue: randomAddress(next) as string as Nonce,
      };
      const signature = await signNonceReturn(statement, merchantKey);
      const received = { nonceIndex: statement.nonceIndex, newNonceValue: statement.newNonceValue, signature };
      await verifyNonceReturn(received, { payer: statement.payer, merchant, spentAgainstValue: statement.spentAgainstValue });
      await expectVadumError(() => verifyNonceReturn(received, { payer: randomAddress(next), merchant, spentAgainstValue: statement.spentAgainstValue }), 'NONCE_RETURN_UNTRUSTED');
      await expectVadumError(
        () => verifyNonceReturn(received, { payer: statement.payer, merchant, spentAgainstValue: randomAddress(next) as string as Nonce }),
        'NONCE_RETURN_UNTRUSTED',
      );
    }
  });
});
