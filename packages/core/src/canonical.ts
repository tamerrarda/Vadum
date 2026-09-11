// The canonical message — the single builder both sides call (plan/22-SPEC-core-api.md). Pure: no
// network, no clock, no storage. Its determinism is a property of kit's compiler, which is why the
// golden fixtures pin its output.

import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  type Instruction,
  type Transaction,
} from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token';
import { deriveAta, tokenProgramAddress } from './derive.ts';
import { VadumError } from './errors.ts';
import { providerFor } from './nonce-provider.ts';
import type { CanonicalInput, CompiledMessage } from './types.ts';

const U64_MAX = (1n << 64n) - 1n;

/**
 * Instruction order is fixed: [AdvanceNonceAccount]? [CreateAssociatedTokenAccountIdempotent]?
 * TransferChecked. `intent.isStatic` never affects the bytes.
 */
export async function buildMessage(input: CanonicalInput): Promise<CompiledMessage> {
  const transaction = await compileCanonicalTransaction(input);
  return { messageBytes: new Uint8Array(transaction.messageBytes) };
}

/** The compiled transaction with its empty signature slots. Internal: sign.ts needs the slots. */
export async function compileCanonicalTransaction(input: CanonicalInput): Promise<Transaction> {
  const { intent, payer, amount } = input;
  if (amount < 0n || amount > U64_MAX) throw new VadumError('CANON_AMOUNT_MISMATCH', { reason: 'amount outside u64', actual: amount });
  if (intent.amount !== null && intent.amount !== amount) {
    throw new VadumError('CANON_AMOUNT_MISMATCH', { reason: 'resolved amount differs from the intent', expected: intent.amount, actual: amount });
  }
  if (!Number.isInteger(intent.decimals) || intent.decimals < 0 || intent.decimals > 255) {
    throw new VadumError('MINT_DECIMALS_MISMATCH', { reason: 'decimals outside u8', decimals: intent.decimals });
  }

  const tokenProgram = tokenProgramAddress(intent.tokenProgram);
  const [source, destination] = await Promise.all([
    deriveAta(payer, intent.mint, intent.tokenProgram),
    deriveAta(intent.merchant, intent.mint, intent.tokenProgram),
  ]);

  const instructions: Instruction[] = [];
  if (intent.includeCreateAta) {
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer: createNoopSigner(intent.feePayer), // D19: the fee payer funds the ATA
        ata: destination,
        owner: intent.merchant,
        mint: intent.mint,
        tokenProgram,
      }),
    );
  }
  instructions.push(
    getTransferCheckedInstruction(
      // The authority MUST be a signer, not a bare address: on the fresh path a bare address silently
      // drops the payer's signer flag (D14, SOL-14).
      { source, mint: intent.mint, destination, authority: createNoopSigner(payer), amount, decimals: intent.decimals },
      { programAddress: tokenProgram },
    ),
  );

  const draft = appendTransactionMessageInstructions(
    instructions,
    setTransactionMessageFeePayer(intent.feePayer, createTransactionMessage({ version: 0 })), // D18
  );
  return compileTransaction(await providerFor(input).applyLifetime(draft, input));
}
