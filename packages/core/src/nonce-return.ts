// The signed recovery payload (D20, D28). The merchant signs a statement both sides reconstruct —
// domain tag, payer, slot, prior value, new value — so a return verifies only for the payer and the
// prior value it was issued for.

import { getPublicKeyFromAddress, signBytes, verifySignature, type Address, type Nonce, type SignatureBytes } from '@solana/kit';
import { addressBytes, base58Bytes32 } from './bytes.ts';
import { nonceSeed } from './derive.ts';
import { VadumError } from './errors.ts';

/** ASCII `vadum:nonce-return:v1`, 21 bytes. */
export const NONCE_RETURN_DOMAIN: Uint8Array = new TextEncoder().encode('vadum:nonce-return:v1');

export interface NonceReturnStatement {
  readonly payer: Address;
  readonly nonceIndex: number;
  readonly spentAgainstValue: Nonce;
  readonly newNonceValue: Nonce;
}

/** The 118 signed bytes: NONCE_RETURN_DOMAIN ‖ payer ‖ nonceIndex ‖ spentAgainstValue ‖ newNonceValue. */
export function nonceReturnSigningBytes(statement: NonceReturnStatement): Uint8Array {
  nonceSeed(statement.nonceIndex); // range check
  const spentAgainst = base58Bytes32(statement.spentAgainstValue);
  const next = base58Bytes32(statement.newNonceValue);
  if (spentAgainst === null || next === null) throw new VadumError('CANON_ACCOUNT_MISMATCH', { reason: 'a nonce value is not 32 bytes' });
  const out = new Uint8Array(118);
  out.set(NONCE_RETURN_DOMAIN, 0);
  out.set(addressBytes(statement.payer), 21);
  out[53] = statement.nonceIndex;
  out.set(spentAgainst, 54);
  out.set(next, 86);
  return out;
}

/** Merchant side, after settlement. Returns the 64-byte signature. */
export async function signNonceReturn(statement: NonceReturnStatement, feePayerKey: CryptoKeyPair): Promise<Uint8Array> {
  return new Uint8Array(await signBytes(feePayerKey.privateKey, nonceReturnSigningBytes(statement)));
}

/**
 * Payer side, offline. `ledger` is the payer's own state — never the payload. Throws
 * NONCE_RETURN_UNTRUSTED on any failure and changes no state.
 */
export async function verifyNonceReturn(
  received: { readonly nonceIndex: number; readonly newNonceValue: Nonce; readonly signature: Uint8Array },
  ledger: { readonly payer: Address; readonly merchant: Address; readonly spentAgainstValue: Nonce },
): Promise<NonceReturnStatement> {
  const untrusted = (reason: string) => new VadumError('NONCE_RETURN_UNTRUSTED', { reason, nonceIndex: received.nonceIndex });
  // A settled nonce always advances (SOL-8): an unchanged value is a replay or an unsubmitted payment.
  if (received.newNonceValue === ledger.spentAgainstValue) throw untrusted('the new value equals the value the slot was spent against');
  if (received.signature.length !== 64) throw untrusted('the signature is not 64 bytes');

  const statement: NonceReturnStatement = {
    payer: ledger.payer,
    nonceIndex: received.nonceIndex,
    spentAgainstValue: ledger.spentAgainstValue,
    newNonceValue: received.newNonceValue,
  };
  let valid = false;
  try {
    valid = await verifySignature(
      await getPublicKeyFromAddress(ledger.merchant),
      received.signature as SignatureBytes,
      nonceReturnSigningBytes(statement),
    );
  } catch {
    throw untrusted('the statement or the merchant key is malformed');
  }
  if (!valid) throw untrusted('the signature does not cover this payer, slot and prior value under the recorded merchant');
  return statement;
}
