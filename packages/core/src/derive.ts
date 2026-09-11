// Addresses both sides derive instead of transmitting (plan/21-SPEC-wire-format.md, Principle).

import { createAddressWithSeed, type Address } from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { VadumError } from './errors.ts';
import type { TokenProgram } from './types.ts';

export function nonceSeed(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 255) throw new VadumError('NONCE_INDEX_OUT_OF_RANGE', { index });
  return `vadum-${index}`;
}

export async function deriveNonceAddress(payer: Address, index: number): Promise<Address> {
  return createAddressWithSeed({ baseAddress: payer, programAddress: SYSTEM_PROGRAM_ADDRESS, seed: nonceSeed(index) });
}

/** The token program is part of the ATA seeds, so the same owner and mint differ across programs. */
export async function deriveAta(owner: Address, mint: Address, tokenProgram: TokenProgram): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: tokenProgramAddress(tokenProgram) });
  return ata;
}

export function tokenProgramAddress(tokenProgram: TokenProgram): Address {
  return tokenProgram === 'spl-token' ? TOKEN_PROGRAM_ADDRESS : TOKEN_2022_PROGRAM_ADDRESS;
}
