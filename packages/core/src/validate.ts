// Mint compatibility and the strict instruction whitelist (plan/22-SPEC-core-api.md, validate.ts).

import { getCompiledTransactionMessageDecoder, type Address } from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { bytesEqual } from './bytes.ts';
import { buildMessage } from './canonical.ts';
import { VadumError } from './errors.ts';
import type { CanonicalInput, MintBlocker, MintRecord, MintWarning, RawMintData } from './types.ts';

// ─── mint compatibility (11-RESEARCH-tokens.md TOK-3, D22) ─────────────────────────────────────────

const BLOCKER_ORDER: readonly MintBlocker[] = ['transfer-hook-active', 'transfer-fee-nonzero', 'default-account-state-frozen'];
const WARNING_ORDER: readonly MintWarning[] = [
  'permanent-delegate',
  'pausable',
  'confidential-transfer',
  'freeze-authority',
  'mint-close-authority',
  'unknown-extension',
];
/** Recognised extensions with no effect on building or verifying a transfer. */
const WITHOUT_EFFECT = new Set(['metadataPointer', 'tokenMetadata']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A transfer fee in basis points; anything unreadable counts as non-zero, so a malformed config blocks. */
function feeBasisPoints(fee: unknown): number {
  if (!isRecord(fee) || typeof fee.transferFeeBasisPoints !== 'number') return Number.POSITIVE_INFINITY;
  return fee.transferFeeBasisPoints;
}

/** Pure: raw jsonParsed mint data to a verdict. `checkedAt` is the caller's fetch time (D34). */
export function evaluateMint(raw: RawMintData, checkedAt: number): MintRecord {
  const wellFormed =
    (raw.tokenProgram === 'spl-token' || raw.tokenProgram === 'token-2022') &&
    Number.isInteger(raw.decimals) &&
    Array.isArray(raw.extensions) &&
    raw.extensions.every((entry) => isRecord(entry) && typeof entry.extension === 'string' && isRecord(entry.state));
  if (!wellFormed) throw new VadumError('MINT_INCOMPATIBLE', { blockers: [], reason: 'RawMintData is not the jsonParsed projection' });

  const blockers = new Set<MintBlocker>();
  const warnings = new Set<MintWarning>();
  let mutable = false;

  for (const { extension, state } of raw.extensions) {
    switch (extension) {
      case 'transferHook':
        // Only an explicit null means "no hook"; a missing field fails safe.
        if (state.programId !== null) blockers.add('transfer-hook-active');
        if (state.authority !== null) mutable = true;
        break;
      case 'transferFeeConfig':
        // The newer fee takes effect at an epoch an offline device cannot see, so either one counts.
        if (feeBasisPoints(state.olderTransferFee) > 0 || feeBasisPoints(state.newerTransferFee) > 0) blockers.add('transfer-fee-nonzero');
        if (state.transferFeeConfigAuthority !== null) mutable = true;
        break;
      case 'defaultAccountState':
        if (state.accountState !== 'initialized') blockers.add('default-account-state-frozen');
        // The default state is changed by the mint's freeze authority.
        if (raw.freezeAuthority !== null) mutable = true;
        break;
      case 'permanentDelegate':
        if (state.delegate !== null) warnings.add('permanent-delegate');
        break;
      case 'pausableConfig':
        warnings.add('pausable');
        break;
      case 'confidentialTransferMint':
      case 'confidentialTransferFeeConfig':
        warnings.add('confidential-transfer');
        break;
      case 'mintCloseAuthority':
        if (state.closeAuthority !== null) warnings.add('mint-close-authority');
        break;
      default:
        if (!WITHOUT_EFFECT.has(extension)) warnings.add('unknown-extension');
    }
  }
  if (raw.freezeAuthority !== null) warnings.add('freeze-authority');

  return {
    mint: raw.mint,
    tokenProgram: raw.tokenProgram,
    decimals: raw.decimals,
    compatible: blockers.size === 0,
    blockers: BLOCKER_ORDER.filter((blocker) => blockers.has(blocker)),
    warnings: WARNING_ORDER.filter((warning) => warnings.has(warning)),
    mutable,
    checkedAt,
  };
}

export function assertMintCompatible(record: MintRecord): void {
  if (!record.compatible || record.blockers.length > 0) throw new VadumError('MINT_INCOMPATIBLE', { blockers: [...record.blockers] });
}

// ─── the instruction whitelist ─────────────────────────────────────────────────────────────────────

const ADVANCE_NONCE_DATA = Uint8Array.of(4, 0, 0, 0);
const TRANSFER_CHECKED = 12;

interface ResolvedInstruction {
  readonly program: Address;
  readonly accounts: readonly (Address | undefined)[];
  readonly data: Uint8Array;
}

const isAdvanceNonce = (instruction: ResolvedInstruction): boolean =>
  instruction.program === SYSTEM_PROGRAM_ADDRESS && bytesEqual(instruction.data, ADVANCE_NONCE_DATA);

const amountOf = (data: Uint8Array): bigint | null =>
  data.length === 10 && data[0] === TRANSFER_CHECKED ? new DataView(data.buffer, data.byteOffset).getBigUint64(1, true) : null;

const mismatch = (reason: string, extra: Readonly<Record<string, unknown>> = {}): VadumError =>
  new VadumError('CANON_ACCOUNT_MISMATCH', { reason, ...extra });

/**
 * Asserts that `messageBytes` is exactly the canonical message for `expected` — its instructions,
 * accounts, mint, amount and destination, nothing more. Rebuilds and compares bytes; on a difference,
 * decodes both messages to name the error.
 */
export async function assertCanonical(messageBytes: Uint8Array, expected: CanonicalInput): Promise<void> {
  const canonical = (await buildMessage(expected)).messageBytes;
  if (bytesEqual(messageBytes, canonical)) return;
  throw explainDifference(messageBytes, canonical);
}

interface ResolvedMessage {
  readonly version: unknown;
  readonly lookups: number;
  /** Null for a message layout without an instruction list (version 1). */
  readonly instructions: readonly ResolvedInstruction[] | null;
}

function resolveInstructions(bytes: Uint8Array): ResolvedMessage | null {
  try {
    const message = getCompiledTransactionMessageDecoder().decode(bytes);
    if (!('instructions' in message)) return { version: message.version, lookups: 0, instructions: null };
    const { staticAccounts } = message;
    const lookups = 'addressTableLookups' in message && Array.isArray(message.addressTableLookups) ? message.addressTableLookups.length : 0;
    const instructions = message.instructions.map((instruction) => ({
      program: staticAccounts[instruction.programAddressIndex] as Address,
      accounts: (instruction.accountIndices ?? []).map((index) => staticAccounts[index]),
      data: Uint8Array.from(instruction.data ?? []),
    }));
    return { version: message.version, lookups, instructions };
  } catch {
    return null;
  }
}

function explainDifference(actualBytes: Uint8Array, canonicalBytes: Uint8Array): VadumError {
  const actual = resolveInstructions(actualBytes);
  const canonical = resolveInstructions(canonicalBytes);
  if (actual === null) return mismatch('the message does not decode');
  if (actual.version !== 0 || actual.instructions === null) return mismatch('the message is not version 0', { version: String(actual.version) });
  if (actual.lookups > 0) return mismatch('address lookup tables are never canonical');
  if (canonical === null || canonical.instructions === null) return mismatch('the canonical message does not decode');

  const got = actual.instructions;
  const want = canonical.instructions;
  const allowed = new Set(want.map((instruction) => instruction.program));
  const foreign = got.find((instruction) => !allowed.has(instruction.program));
  if (foreign !== undefined) return new VadumError('CANON_INSTRUCTION_NOT_ALLOWED', { programAddress: foreign.program });

  if (want[0] !== undefined && isAdvanceNonce(want[0])) {
    const advanceAt = got.findIndex(isAdvanceNonce);
    if (advanceAt !== 0) return new VadumError('CANON_INSTRUCTION_ORDER', { advanceNonceIndex: advanceAt });
  }

  for (let index = 0; index < Math.max(got.length, want.length); index++) {
    const g = got[index];
    const w = want[index];
    if (w === undefined) return new VadumError('CANON_INSTRUCTION_NOT_ALLOWED', { programAddress: g?.program, index });
    if (g === undefined) return mismatch('an expected instruction is missing', { programAddress: w.program, index });
    if (g.program !== w.program || g.data[0] !== w.data[0] || (w.program === SYSTEM_PROGRAM_ADDRESS && !isAdvanceNonce(g))) {
      return new VadumError('CANON_INSTRUCTION_NOT_ALLOWED', { programAddress: g.program, index });
    }
    if (w.program === ASSOCIATED_TOKEN_PROGRAM_ADDRESS && (g.accounts[1] !== w.accounts[1] || g.accounts[2] !== w.accounts[2])) {
      return new VadumError('CANON_DESTINATION_MISMATCH', { expected: w.accounts[1], actual: g.accounts[1] });
    }
    if (w.data[0] === TRANSFER_CHECKED && w.program !== SYSTEM_PROGRAM_ADDRESS && w.program !== ASSOCIATED_TOKEN_PROGRAM_ADDRESS) {
      if (!bytesEqual(g.data, w.data)) {
        return new VadumError('CANON_AMOUNT_MISMATCH', {
          expected: amountOf(w.data),
          actual: amountOf(g.data),
          expectedDecimals: w.data[9],
          actualDecimals: g.data[9],
        });
      }
      if (g.accounts[2] !== w.accounts[2]) return new VadumError('CANON_DESTINATION_MISMATCH', { expected: w.accounts[2], actual: g.accounts[2] });
    }
    if (!bytesEqual(g.data, w.data)) return new VadumError('CANON_INSTRUCTION_NOT_ALLOWED', { programAddress: g.program, index });
    if (g.accounts.length !== w.accounts.length || g.accounts.some((account, at) => account !== w.accounts[at])) {
      return mismatch('instruction accounts differ', { programAddress: g.program, index });
    }
  }
  return mismatch('the fee payer, signer header or lifetime differs');
}
