// B10: submission through the confirmer that matches the lifetime (SOL-15), and the three failure
// classes D21 refuses to let anyone collapse.

import { createKeyPairFromPrivateKeyBytes, getTransactionDecoder, type Address, type Nonce } from '@solana/kit';
import { MERCHANT_SEED } from '@vadum/fixtures';
import { describe, expect, it } from 'vitest';
import type { NonceAccountState } from '../src/rpc.ts';
import { submit } from '../src/submit.ts';
import { caseNamed, fakeRpc, paymentOf } from './helpers.ts';

const NONCE_FIXTURE = caseNamed('nonce-dynamic-spl-no-ata');
const FRESH_FIXTURE = caseNamed('fresh-dynamic-spl-no-ata');
const advanced = 'AdVaNcEdVaLuE111111111111111111111111111119' as string as Nonce;

const merchantKey = () => createKeyPairFromPrivateKeyBytes(MERCHANT_SEED);
const nonceAddress = NONCE_FIXTURE.derived.nonceAddress as string;

const initialized = (value: Nonce, authority: Address): Record<string, NonceAccountState> => ({
  [nonceAddress]: { kind: 'initialized', authority, value, lamports: 1_056_640n },
});

describe('submit', () => {
  it('settles through the durable-nonce confirmer and reports the new value (D28)', async () => {
    const payment = await paymentOf(NONCE_FIXTURE);
    const rpc = fakeRpc({ nonceAccounts: initialized(advanced, payment.input.payer), sendPayment: async () => 'sig-1' });
    const outcome = await submit(rpc, payment, await merchantKey());

    expect(outcome).toEqual({ kind: 'settled', signature: 'sig-1', newNonceValue: advanced });
    expect(rpc.sent[0]?.lifetime).toMatchObject({ kind: 'nonce', nonce: payment.input.nonceRef?.value, nonceAuthorityAddress: payment.input.payer });
    // What went out is the payment's own message with both signatures attached.
    const transaction = getTransactionDecoder().decode(rpc.sent[0]!.wireTransaction);
    expect(new Uint8Array(transaction.messageBytes)).toEqual(payment.messageBytes);
    expect(Object.values(transaction.signatures).every((signature) => signature !== null)).toBe(true);
  });

  it('uses the blockhash confirmer on the fresh path, where there is no nonce to report', async () => {
    const payment = await paymentOf(FRESH_FIXTURE);
    const rpc = fakeRpc({ sendPayment: async () => 'sig-2' });
    expect(await submit(rpc, payment, await merchantKey())).toEqual({ kind: 'settled', signature: 'sig-2', newNonceValue: null });
    expect(rpc.sent[0]?.lifetime.kind).toBe('fresh');
  });

  it('reports settlement even when the slot cannot be read back', async () => {
    const payment = await paymentOf(NONCE_FIXTURE);
    const rpc = fakeRpc({ sendPayment: async () => 'sig-3' });
    expect(await submit(rpc, payment, await merchantKey())).toEqual({ kind: 'settled', signature: 'sig-3', newNonceValue: null });
  });

  it.each([
    ['an execution failure that landed charges the merchant (SOL-7)', 'Error processing Instruction 2: custom program error: 0x1', 'SUBMIT_EXECUTION_FAILED', true],
    ['the same failure caught at preflight costs nothing', 'Transaction simulation failed: InstructionError [1, {"Custom": 1}]', 'SUBMIT_EXECUTION_FAILED', false],
    ['an expired blockhash', 'TransactionExpiredBlockheightExceededError: block height exceeded', 'SUBMIT_BLOCKHASH_EXPIRED', false],
    ['a duplicate submission', 'This transaction has already been processed', 'SUBMIT_ALREADY_PROCESSED', false],
    ['a dead connection', 'TypeError: fetch failed', 'SUBMIT_RPC_UNAVAILABLE', false],
  ] as const)('classifies %s', async (_name, message, code, feeCharged) => {
    const payment = await paymentOf(NONCE_FIXTURE);
    const rpc = fakeRpc({
      nonceAccounts: initialized(payment.input.nonceRef?.value as Nonce, payment.input.payer),
      sendPayment: async () => {
        throw new Error(message);
      },
    });
    expect(await submit(rpc, payment, await merchantKey())).toMatchObject({ kind: 'failed', code, feeCharged });
  });

  it('separates a stale nonce from an absent one when the error says nothing (D21)', async () => {
    const payment = await paymentOf(NONCE_FIXTURE);
    const opaque = async (): Promise<string> => {
      throw new Error('SolanaError: transaction failed to confirm');
    };

    const stale = fakeRpc({ nonceAccounts: initialized(advanced, payment.input.payer), sendPayment: opaque });
    expect(await submit(stale, payment, await merchantKey())).toMatchObject({ kind: 'failed', code: 'SUBMIT_NONCE_STALE', feeCharged: false });

    const fabricated = fakeRpc({ sendPayment: opaque });
    expect(await submit(fabricated, payment, await merchantKey())).toMatchObject({ kind: 'failed', code: 'SUBMIT_NONCE_ABSENT', feeCharged: false });

    const hijacked = fakeRpc({ nonceAccounts: initialized(payment.input.nonceRef?.value as Nonce, payment.input.intent.merchant), sendPayment: opaque });
    expect(await submit(hijacked, payment, await merchantKey())).toMatchObject({ kind: 'failed', code: 'SUBMIT_NONCE_ABSENT', feeCharged: false });

    // The nonce is still exactly as claimed: the send itself is what failed.
    const transport = fakeRpc({ nonceAccounts: initialized(payment.input.nonceRef?.value as Nonce, payment.input.payer), sendPayment: opaque });
    expect(await submit(transport, payment, await merchantKey())).toMatchObject({ kind: 'failed', code: 'SUBMIT_RPC_UNAVAILABLE', feeCharged: false });
  });
});
