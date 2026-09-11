// Reference canonical message builder for the fixture generator, written from
// plan/22-SPEC-core-api.md. Deliberately independent of packages/core (D33).

import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createAddressWithSeed,
  createNoopSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  type Address,
  type Blockhash,
  type Instruction,
  type Nonce,
  type Transaction,
} from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

export type TokenProgram = 'spl-token' | 'token-2022';

export type Lifetime =
  | { readonly kind: 'nonce' }
  | { readonly kind: 'fresh'; readonly blockhash: Blockhash; readonly lastValidBlockHeight: bigint };

export interface Intent {
  readonly merchant: Address;
  readonly mint: Address;
  readonly decimals: number;
  readonly amount: bigint | null;
  readonly lifetime: Lifetime;
  readonly includeCreateAta: boolean;
  readonly tokenProgram: TokenProgram;
  readonly feePayer: Address;
  readonly isStatic: boolean;
}

export interface NonceRef {
  readonly index: number;
  readonly value: Nonce;
}

export interface CanonicalInput {
  readonly intent: Intent;
  readonly payer: Address;
  readonly nonceRef: NonceRef | null;
  readonly amount: bigint;
}

export const tokenProgramAddress = (tokenProgram: TokenProgram): Address =>
  tokenProgram === 'spl-token' ? TOKEN_PROGRAM_ADDRESS : TOKEN_2022_PROGRAM_ADDRESS;

export const deriveNonceAddress = (payer: Address, index: number): Promise<Address> =>
  createAddressWithSeed({ baseAddress: payer, programAddress: SYSTEM_PROGRAM_ADDRESS, seed: `vadum-${index}` });

export async function deriveAta(owner: Address, mint: Address, tokenProgram: TokenProgram): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: tokenProgramAddress(tokenProgram) });
  return ata;
}

/**
 * The canonical message: version 0 (D18), the payer as a noop-signer transfer authority (D14),
 * `intent.feePayer` as fee payer and ATA funder (D19). Token-2022 instructions come from
 * @solana-program/token with the program address overridden; the token-2022 package's own builders
 * compile identical bytes (TOK-5, re-measured by Stream 0 on 2026-09-11).
 */
export async function buildMessage(input: CanonicalInput): Promise<{ messageBytes: Uint8Array; transaction: Transaction }> {
  const { intent, payer, nonceRef, amount } = input;
  const tokenProgram = tokenProgramAddress(intent.tokenProgram);
  const source = await deriveAta(payer, intent.mint, intent.tokenProgram);
  const destination = await deriveAta(intent.merchant, intent.mint, intent.tokenProgram);

  const instructions: Instruction[] = [];
  if (intent.includeCreateAta) {
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer: createNoopSigner(intent.feePayer),
        ata: destination,
        owner: intent.merchant,
        mint: intent.mint,
        tokenProgram,
      }),
    );
  }
  instructions.push(
    getTransferCheckedInstruction(
      { source, mint: intent.mint, destination, authority: createNoopSigner(payer), amount, decimals: intent.decimals },
      { programAddress: tokenProgram },
    ),
  );

  const message = appendTransactionMessageInstructions(
    instructions,
    setTransactionMessageFeePayer(intent.feePayer, createTransactionMessage({ version: 0 })),
  );

  if (intent.lifetime.kind === 'nonce') {
    if (nonceRef === null) throw new Error('the durable-nonce path needs a nonceRef');
    const nonceAccountAddress = await deriveNonceAddress(payer, nonceRef.index);
    const transaction = compileTransaction(
      setTransactionMessageLifetimeUsingDurableNonce({ nonce: nonceRef.value, nonceAccountAddress, nonceAuthorityAddress: payer }, message),
    );
    return { messageBytes: new Uint8Array(transaction.messageBytes), transaction };
  }

  const transaction = compileTransaction(
    setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: intent.lifetime.blockhash, lastValidBlockHeight: intent.lifetime.lastValidBlockHeight },
      message,
    ),
  );
  return { messageBytes: new Uint8Array(transaction.messageBytes), transaction };
}
