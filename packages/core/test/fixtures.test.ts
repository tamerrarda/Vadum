// A7: the core half of the golden-fixture CI rule (plan/24-SPEC-fixtures.md). A failure here is
// never "update the fixture" — it is a dependency or a spec change.

import { createKeyPairFromPrivateKeyBytes, type Address, type Blockhash, type Nonce } from '@solana/kit';
import { fixtures, MERCHANT_SEED, PAYER_SEED, type NegativeCase, type NegativeTarget } from '@vadum/fixtures';
import { describe, expect, it } from 'vitest';
import {
  assertMintCompatible,
  buildMessage,
  buildWireTransaction,
  deriveAta,
  deriveNonceAddress,
  evaluateMint,
  nonceReturnSigningBytes,
  signAsPayer,
  verifyAuth,
  verifyNonceReturn,
  type Auth,
  type Intent,
  type RawMintData,
  type VadumErrorCode,
} from '../src/index.ts';
import { authFrom, expectVadumError, fromBase64, inputFrom, intentFrom, prng, randomAddress, toBase64 } from './helpers.ts';

const SEEDS: Readonly<Record<string, Uint8Array>> = { PAYER_SEED, MERCHANT_SEED };

describe('positive fixtures', () => {
  describe.each(fixtures.cases.map((fixture) => [fixture.name, fixture] as const))('%s', (_name, fixture) => {
    const input = inputFrom(fixture.input);
    const expectedAmount = fixture.expectedAmount === null ? undefined : BigInt(fixture.expectedAmount);

    it('compiles exactly the committed message bytes, version 0', async () => {
      const { messageBytes } = await buildMessage(input);
      expect(toBase64(messageBytes)).toBe(fixture.expected.messageBytes);
      expect(messageBytes.length).toBe(fixture.expected.messageByteLength);
      expect(messageBytes[0]).toBe(0x80);
    });

    it('derives the committed addresses', async () => {
      const { intent, payer, nonceRef } = input;
      expect(await deriveAta(payer, intent.mint, intent.tokenProgram)).toBe(fixture.derived.sourceAta);
      expect(await deriveAta(intent.merchant, intent.mint, intent.tokenProgram)).toBe(fixture.derived.destinationAta);
      expect(nonceRef === null ? null : await deriveNonceAddress(payer, nonceRef.index)).toBe(fixture.derived.nonceAddress);
    });

    it('verifies the committed AUTH offline', async () => {
      const payment = await verifyAuth(intentFrom(fixture.input.intent), authFrom(fixture.auth), expectedAmount);
      expect(toBase64(payment.messageBytes)).toBe(fixture.expected.messageBytes);
    });

    it('signs as the payer to an AUTH that verifies', async () => {
      const auth = await signAsPayer(input, await createKeyPairFromPrivateKeyBytes(PAYER_SEED));
      expect(toBase64(auth.signature)).toBe(fixture.auth.signature); // Node's Ed25519 is deterministic
      await verifyAuth(input.intent, auth, expectedAmount);
    });

    it('builds a wire transaction of the recorded length', async () => {
      const payment = await verifyAuth(intentFrom(fixture.input.intent), authFrom(fixture.auth), expectedAmount);
      const wire = await buildWireTransaction(payment, await createKeyPairFromPrivateKeyBytes(MERCHANT_SEED));
      expect(wire.length).toBe(fixture.expected.fullTransactionLength);
    });

    it('refuses a mutated intent or AUTH with SIG_INVALID, never a silent pass', async () => {
      const intent = intentFrom(fixture.input.intent);
      const auth = authFrom(fixture.auth);
      const other = randomAddress(prng(7));

      const intents: Intent[] = [
        { ...intent, merchant: other },
        { ...intent, mint: other },
        { ...intent, decimals: intent.decimals + 1 },
        { ...intent, includeCreateAta: !intent.includeCreateAta },
        { ...intent, tokenProgram: intent.tokenProgram === 'spl-token' ? 'token-2022' : 'spl-token' },
        { ...intent, feePayer: other },
      ];
      if (intent.amount !== null) intents.push({ ...intent, amount: intent.amount + 1n });
      if (intent.lifetime.kind === 'fresh') intents.push({ ...intent, lifetime: { ...intent.lifetime, blockhash: other as string as Blockhash } });
      for (const mutated of intents) await expectVadumError(() => verifyAuth(mutated, auth, expectedAmount), 'SIG_INVALID');

      const auths: Auth[] = [];
      if (auth.nonceRef !== null) {
        auths.push({ ...auth, nonceRef: { ...auth.nonceRef, value: other as string as Nonce } });
        auths.push({ ...auth, nonceRef: { ...auth.nonceRef, index: (auth.nonceRef.index + 1) % 256 } });
      }
      for (const mutated of auths) await expectVadumError(() => verifyAuth(intent, mutated, expectedAmount), 'SIG_INVALID');

      const { amount: staticAmount } = auth;
      if (staticAmount !== null && expectedAmount !== undefined) {
        await expectVadumError(() => verifyAuth(intent, { ...auth, amount: staticAmount + 1n }, expectedAmount + 1n), 'SIG_INVALID');
      }
    });
  });
});

describe('nonce-return-signed', () => {
  const [fixture] = fixtures.nonceReturn;
  if (fixture === undefined) throw new Error('the fixture file has no nonce-return case');
  const statement = {
    payer: fixture.statement.payer as Address,
    nonceIndex: fixture.statement.nonceIndex,
    spentAgainstValue: fixture.statement.spentAgainstValue as Nonce,
    newNonceValue: fixture.statement.newNonceValue as Nonce,
  };

  it('reconstructs the 118 signed bytes (D28)', () => {
    expect(toBase64(nonceReturnSigningBytes(statement))).toBe(fixture.expected.signingBytes);
  });

  it('verifies against the payer ledger', async () => {
    const wire = fromBase64(fixture.expected.wireNonceReturn);
    const verified = await verifyNonceReturn(
      { nonceIndex: wire[3]!, newNonceValue: statement.newNonceValue, signature: wire.subarray(36) },
      { payer: statement.payer, merchant: fixture.merchant as Address, spentAgainstValue: statement.spentAgainstValue },
    );
    expect(verified).toEqual(statement);
  });
});

type Input = Record<string, unknown>;

async function runCoreTarget(target: NegativeTarget, input: Input): Promise<unknown> {
  switch (target) {
    case 'core.verifyAuth':
      return verifyAuth(
        intentFrom(input.intent as never),
        authFrom(input.auth as never),
        input.expectedAmount === null ? undefined : BigInt(input.expectedAmount as string),
      );
    case 'core.signAsPayer': {
      const seed = SEEDS[input.payerSeed as string];
      if (seed === undefined) throw new Error(`unknown seed ${String(input.payerSeed)}`);
      return signAsPayer(inputFrom(input.input as never), await createKeyPairFromPrivateKeyBytes(seed));
    }
    case 'core.evaluateMint → core.assertMintCompatible':
      return assertMintCompatible(evaluateMint(input.raw as RawMintData, input.checkedAt as number));
    case 'core.verifyNonceReturn': {
      const received = input.received as { nonceIndex: number; newNonceValue: string; signature: string };
      const ledger = input.ledger as { payer: string; merchant: string; spentAgainstValue: string };
      return verifyNonceReturn(
        { nonceIndex: received.nonceIndex, newNonceValue: received.newNonceValue as Nonce, signature: fromBase64(received.signature) },
        { payer: ledger.payer as Address, merchant: ledger.merchant as Address, spentAgainstValue: ledger.spentAgainstValue as Nonce },
      );
    }
    default:
      throw new Error(`not a core target: ${target}`);
  }
}

const targetsOf = (fixture: NegativeCase): readonly NegativeTarget[] => (Array.isArray(fixture.target) ? fixture.target : [fixture.target as NegativeTarget]);
const coreNegatives = fixtures.negative.filter((fixture) => targetsOf(fixture).some((target) => target.startsWith('core.')));

describe('negative fixtures owned by core', () => {
  it('covers all nine core cases', () => {
    expect(coreNegatives.length).toBe(9);
  });

  it.each(coreNegatives.map((fixture) => [fixture.name, fixture] as const))('%s', async (_name, fixture) => {
    for (const target of targetsOf(fixture)) {
      const input = (Array.isArray(fixture.target) ? fixture.input[target] : fixture.input) as Input;
      // The generator writes `expectedDetail: null` when a case asserts the code only.
      await expectVadumError(() => runCoreTarget(target, input), fixture.expectedError as VadumErrorCode, fixture.expectedDetail ?? undefined);
    }
  });
});
