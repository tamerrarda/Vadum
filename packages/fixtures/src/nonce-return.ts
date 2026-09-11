// Reference NONCE_RETURN statement for the fixture generator (plan/21-SPEC-wire-format.md, D28).
// Deliberately independent of packages/core (D33).

import { signBytes, verifySignature, type Address, type SignatureBytes } from '@solana/kit';
import { addressBytes, base58Bytes32, concat } from './bytes.ts';

export const NONCE_RETURN_DOMAIN = new TextEncoder().encode('vadum:nonce-return:v1');

export interface NonceReturnStatement {
  readonly payer: Address;
  readonly nonceIndex: number;
  readonly spentAgainstValue: string;
  readonly newNonceValue: string;
}

/** domain tag ‖ payer ‖ nonceIndex ‖ spentAgainstValue ‖ newNonceValue — 118 bytes. */
export function nonceReturnSigningBytes(statement: NonceReturnStatement): Uint8Array {
  return concat(
    NONCE_RETURN_DOMAIN,
    addressBytes(statement.payer),
    Uint8Array.of(statement.nonceIndex),
    base58Bytes32(statement.spentAgainstValue),
    base58Bytes32(statement.newNonceValue),
  );
}

export async function signNonceReturn(statement: NonceReturnStatement, merchantPrivateKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await signBytes(merchantPrivateKey, nonceReturnSigningBytes(statement)));
}

/**
 * Why a payer must reject a received return, or null if it must accept it. The statement is built
 * from the payer's own ledger, never from the payload (21-SPEC receive MUSTs).
 */
export async function nonceReturnRejection(
  received: { readonly nonceIndex: number; readonly newNonceValue: string; readonly signature: Uint8Array },
  ledger: { readonly payer: Address; readonly merchantPublicKey: CryptoKey; readonly spentAgainstValue: string },
): Promise<'signature' | 'unchanged-value' | null> {
  const statement: NonceReturnStatement = {
    payer: ledger.payer,
    nonceIndex: received.nonceIndex,
    spentAgainstValue: ledger.spentAgainstValue,
    newNonceValue: received.newNonceValue,
  };
  const signatureValid = await verifySignature(
    ledger.merchantPublicKey,
    received.signature as SignatureBytes,
    nonceReturnSigningBytes(statement),
  );
  if (!signatureValid) return 'signature';
  if (received.newNonceValue === ledger.spentAgainstValue) return 'unchanged-value';
  return null;
}
