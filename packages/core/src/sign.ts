// Offline signing and verification — the whole merchant-side security model for what a merchant can
// see offline (plan/22-SPEC-core-api.md, sign.ts). It cannot see chain state: see precheckNonce.

import {
  getAddressFromPublicKey,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionEncoder,
  partiallySignTransaction,
  signBytes,
  verifySignature,
  type SignatureBytes,
  type Transaction,
  type TransactionMessageBytes,
} from '@solana/kit';
import { buildMessage } from './canonical.ts';
import { VadumError } from './errors.ts';
import { assertCanonical } from './validate.ts';
import type { Auth, CanonicalInput, Intent, VerifiedPayment } from './types.ts';

/** Payer side, fully offline. Refuses an intent naming the payer as fee payer (rule 9, D30). */
export async function signAsPayer(input: CanonicalInput, key: CryptoKeyPair): Promise<Auth> {
  if (input.intent.feePayer === input.payer) throw new VadumError('WIRE_FEE_PAYER_IS_PAYER', { payer: input.payer });
  if (input.intent.isStatic !== (input.intent.amount === null)) {
    throw new VadumError('CANON_AMOUNT_MISMATCH', { reason: 'a static intent carries no amount and a dynamic one always does' });
  }
  const signer = await getAddressFromPublicKey(key.publicKey);
  if (signer !== input.payer) throw new VadumError('CANON_ACCOUNT_MISMATCH', { reason: 'the key is not the payer', payer: input.payer, key: signer });

  const { messageBytes } = await buildMessage(input);
  await assertCanonical(messageBytes, input);
  const signature = new Uint8Array(await signBytes(key.privateKey, messageBytes));
  return { payer: input.payer, nonceRef: input.nonceRef, amount: input.intent.isStatic ? input.amount : null, signature };
}

function resolveAmount(intent: Intent, auth: Auth, expectedAmount: bigint | undefined): bigint {
  if (intent.isStatic) {
    // Without an expected amount, static mode would verify any amount the payer chose (D30).
    if (expectedAmount === undefined || auth.amount === null || auth.amount !== expectedAmount) {
      throw new VadumError('CANON_AMOUNT_MISMATCH', { expected: expectedAmount ?? null, actual: auth.amount });
    }
    return auth.amount;
  }
  if (intent.amount === null) throw new VadumError('CANON_AMOUNT_MISMATCH', { reason: 'a dynamic intent carries its amount', expected: expectedAmount ?? null, actual: null });
  // AMOUNT_IN_AUTH is forbidden on a dynamic intent, so a second amount is refused, never ignored.
  if (auth.amount !== null) {
    throw new VadumError('CANON_AMOUNT_MISMATCH', { reason: 'a dynamic payment carries no amount in its AUTH', expected: intent.amount, actual: auth.amount });
  }
  if (expectedAmount !== undefined && expectedAmount !== intent.amount) {
    throw new VadumError('CANON_AMOUNT_MISMATCH', { expected: expectedAmount, actual: intent.amount });
  }
  return intent.amount;
}

/** Merchant side, fully offline. Rebuilds from (intent, auth) and verifies against the rebuilt bytes. */
export async function verifyAuth(intent: Intent, auth: Auth, expectedAmount?: bigint): Promise<VerifiedPayment> {
  if (auth.signature.length !== 64) throw new VadumError('SIG_LENGTH', { length: auth.signature.length });
  if (intent.feePayer === auth.payer) throw new VadumError('WIRE_FEE_PAYER_IS_PAYER', { payer: auth.payer });
  const amount = resolveAmount(intent, auth, expectedAmount);

  const input: CanonicalInput = { intent, payer: auth.payer, nonceRef: auth.nonceRef, amount };
  const { messageBytes } = await buildMessage(input);
  let valid = false;
  try {
    valid = await verifySignature(await getPublicKeyFromAddress(auth.payer), auth.signature as SignatureBytes, messageBytes);
  } catch {
    // A payer address that is not a valid public key cannot have signed anything.
  }
  if (!valid) throw new VadumError('SIG_INVALID');
  return { input, messageBytes, auth };
}

/** Merchant side, at submission: attaches the fee-payer signature and returns the wire transaction. */
export async function buildWireTransaction(payment: VerifiedPayment, feePayerKey: CryptoKeyPair): Promise<Uint8Array> {
  const feePayer = await getAddressFromPublicKey(feePayerKey.publicKey);
  if (feePayer !== payment.input.intent.feePayer) {
    throw new VadumError('SIG_FEE_PAYER_MISSING', { reason: 'the key is not the fee payer', feePayer: payment.input.intent.feePayer, key: feePayer });
  }
  if (payment.auth.signature.length !== 64) throw new VadumError('SIG_LENGTH', { length: payment.auth.signature.length });

  const message = getCompiledTransactionMessageDecoder().decode(payment.messageBytes);
  const signers = message.staticAccounts.slice(0, message.header.numSignerAccounts);
  const signatures = Object.fromEntries(
    signers.map((address) => [address, address === payment.auth.payer ? (payment.auth.signature as SignatureBytes) : null]),
  );
  const unsigned = { messageBytes: payment.messageBytes as unknown as TransactionMessageBytes, signatures } as Transaction;
  const signed = await partiallySignTransaction([feePayerKey], unsigned);
  if (Object.values(signed.signatures).some((signature) => signature === null)) {
    throw new VadumError('SIG_FEE_PAYER_MISSING', { reason: 'a required signature is still missing' });
  }
  return new Uint8Array(getTransactionEncoder().encode(signed));
}
