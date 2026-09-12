// The two devices, minus the screens: what every integration scenario needs before it can start.

import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, type Address, type Nonce } from '@solana/kit';
import { createMemoryStore, createPool, createQueue, DEFAULT_QUEUE_LIMITS, type KeyValueStore, type Pool, type Queue } from '@vadum/client';
import { signAsPayer, verifyAuth, type Intent, type MintRecord, type VerifiedPayment } from '@vadum/core';
import { fixtures, MERCHANT_SEED, NONCE_VALUE, PAYER_SEED } from '@vadum/fixtures';
import { decodeAuth, decodeIntent, encodeAuth, encodeIntent, flagsFromByte } from '@vadum/wire';
import { createFakeChain, nextValue, type FakeChain } from './fake-chain.ts';

export const AMOUNT = 2_500_000n;
export const POOL_SIZE = 5;
export const MINT = fixtures.mints.spl.address as Address;
/** Enough to pass the D38 check: pool rent, one signature, and the wallet floor. */
export const PAYER_FUNDING = 1_056_640n * BigInt(POOL_SIZE) + 5_000n + 890_880n;

/** The committed mint records as the payer's offline cache (receive rules 4 and 5). */
export const mintCache: ReadonlyMap<Address, MintRecord> = new Map(
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

/** A distinct starting value per slot, all valid base58 and all 32 bytes. */
export const slotValue = (index: number): Nonce => {
  let value = NONCE_VALUE as Nonce;
  for (let step = 0; step < index; step++) value = nextValue(value);
  return value;
};

export const intentFor = (merchant: Address, amount: bigint): Intent => ({
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

export interface Devices {
  readonly chain: FakeChain;
  readonly payerKey: CryptoKeyPair;
  readonly merchantKey: CryptoKeyPair;
  readonly payer: Address;
  readonly merchant: Address;
  readonly pool: Pool;
  readonly queue: Queue;
  readonly payerStore: KeyValueStore;
}

/** A payer with a created pool of five, and a merchant with an empty queue. */
export async function twoDevices(): Promise<Devices> {
  const payerKey = await createKeyPairFromPrivateKeyBytes(PAYER_SEED);
  const merchantKey = await createKeyPairFromPrivateKeyBytes(MERCHANT_SEED);
  const payer = await getAddressFromPublicKey(payerKey.publicKey);
  const merchant = await getAddressFromPublicKey(merchantKey.publicKey);

  const chain = createFakeChain();
  await chain.seedPool(payer, POOL_SIZE, slotValue);
  chain.balances.set(payer, PAYER_FUNDING);

  const payerStore = createMemoryStore();
  const pool = createPool(chain, payer, payerStore);
  await pool.create(POOL_SIZE, payerKey);
  return { chain, payerKey, merchantKey, payer, merchant, pool, queue: createQueue(chain, createMemoryStore(), DEFAULT_QUEUE_LIMITS), payerStore };
}

/**
 * One payment, taken through the whole air gap except the camera: encode the intent, decode it as the
 * payer, sign, encode the AUTH, decode it as the merchant, and verify against a rebuilt message.
 */
export async function signedPayment(
  intent: Intent,
  payerKey: CryptoKeyPair,
  nonceRef: { readonly index: number; readonly value: Nonce },
  amount: bigint,
): Promise<VerifiedPayment> {
  const payer = await getAddressFromPublicKey(payerKey.publicKey);
  const intentBytes = encodeIntent(intent);
  const decodedIntent = decodeIntent(intentBytes, { mintCache });
  const auth = await signAsPayer({ intent: decodedIntent, payer, nonceRef, amount }, payerKey);
  const flags = flagsFromByte(intentBytes[2]!);
  return verifyAuth(decodedIntent, decodeAuth(encodeAuth(auth, flags), { mintCache, intentFlags: flags }));
}
