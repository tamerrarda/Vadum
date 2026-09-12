// A4: mint compatibility against live mint shapes, and the instruction whitelist.

import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from '@solana/kit';
import { getAdvanceNonceAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import { getApproveInstruction, getTransferCheckedInstruction } from '@solana-program/token';
import { describe, expect, it } from 'vitest';
import {
  assertCanonical,
  assertMintCompatible,
  buildMessage,
  deriveAta,
  deriveNonceAddress,
  durableNonceProvider,
  evaluateMint,
  tokenProgramAddress,
  type CanonicalInput,
  type RawMintData,
  type RawMintExtension,
} from '../src/index.ts';
import { expectVadumError, prng, randomAddress, randomInput } from './helpers.ts';

const PAXOS = '2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk';

// Read from mainnet-beta with encoding: 'jsonParsed' on 2026-09-11.
const USDC: RawMintData = {
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address,
  tokenProgram: 'spl-token',
  decimals: 6,
  freezeAuthority: '7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar' as Address,
  extensions: [],
};

const PAXOS_EXTENSIONS = (mint: string): RawMintExtension[] => [
  { extension: 'mintCloseAuthority', state: { closeAuthority: PAXOS } },
  { extension: 'permanentDelegate', state: { delegate: PAXOS } },
  {
    extension: 'transferFeeConfig',
    state: {
      newerTransferFee: { epoch: 722, maximumFee: 0, transferFeeBasisPoints: 0 },
      olderTransferFee: { epoch: 722, maximumFee: 0, transferFeeBasisPoints: 0 },
      transferFeeConfigAuthority: PAXOS,
      withdrawWithheldAuthority: PAXOS,
      withheldAmount: 0,
    },
  },
  { extension: 'confidentialTransferMint', state: { auditorElgamalPubkey: null, authority: PAXOS, autoApproveNewAccounts: false } },
  { extension: 'confidentialTransferFeeConfig', state: { authority: PAXOS, harvestToMintEnabled: true } },
  { extension: 'transferHook', state: { authority: PAXOS, programId: null } },
  { extension: 'metadataPointer', state: { authority: PAXOS, metadataAddress: mint } },
  { extension: 'tokenMetadata', state: { mint, name: 'Global Dollar', symbol: 'USDG', updateAuthority: PAXOS } },
];

const USDG: RawMintData = {
  mint: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH' as Address,
  tokenProgram: 'token-2022',
  decimals: 6,
  freezeAuthority: PAXOS as Address,
  extensions: PAXOS_EXTENSIONS('2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'),
};

const withExtension = (base: RawMintData, extension: RawMintExtension): RawMintData => ({
  ...base,
  extensions: [...base.extensions.filter((entry) => entry.extension !== extension.extension), extension],
});

describe('evaluateMint', () => {
  it('passes USDC unconditionally: immutable, a freeze-authority warning only', () => {
    expect(evaluateMint(USDC, 1_700_000_000_000)).toEqual({
      mint: USDC.mint,
      tokenProgram: 'spl-token',
      decimals: 6,
      compatible: true,
      blockers: [],
      warnings: ['freeze-authority'],
      mutable: false,
      checkedAt: 1_700_000_000_000,
    });
  });

  it('passes USDG today, with warnings, and marks it mutable (D22)', () => {
    const record = evaluateMint(USDG, 0);
    expect(record.compatible).toBe(true);
    expect(record.blockers).toEqual([]);
    expect(record.warnings).toEqual(['permanent-delegate', 'confidential-transfer', 'freeze-authority', 'mint-close-authority']);
    expect(record.mutable).toBe(true);
  });

  it.each([
    ['an installed transfer hook', { extension: 'transferHook', state: { authority: PAXOS, programId: PAXOS } }, 'transfer-hook-active'],
    ['a transfer hook with no programId field', { extension: 'transferHook', state: { authority: null } }, 'transfer-hook-active'],
    [
      'a non-zero current transfer fee',
      { extension: 'transferFeeConfig', state: { olderTransferFee: { transferFeeBasisPoints: 50 }, newerTransferFee: { transferFeeBasisPoints: 0 }, transferFeeConfigAuthority: null } },
      'transfer-fee-nonzero',
    ],
    [
      'a non-zero scheduled transfer fee',
      { extension: 'transferFeeConfig', state: { olderTransferFee: { transferFeeBasisPoints: 0 }, newerTransferFee: { transferFeeBasisPoints: 1 }, transferFeeConfigAuthority: null } },
      'transfer-fee-nonzero',
    ],
    ['an unreadable transfer fee', { extension: 'transferFeeConfig', state: { transferFeeConfigAuthority: null } }, 'transfer-fee-nonzero'],
    ['frozen-by-default accounts', { extension: 'defaultAccountState', state: { accountState: 'frozen' } }, 'default-account-state-frozen'],
    ['a non-transferable mint', { extension: 'nonTransferable', state: {} }, 'non-transferable'],
    ['a mint observed paused', { extension: 'pausableConfig', state: { authority: PAXOS, paused: true } }, 'paused'],
  ] as const)('blocks %s', (_label, extension, blocker) => {
    const record = evaluateMint(withExtension(USDG, extension as RawMintExtension), 0);
    expect(record.compatible).toBe(false);
    expect(record.blockers).toContain(blocker);
  });

  it('lets a pausable mint through while it is running, but never caches it forever (D22)', () => {
    const running = evaluateMint(withExtension(USDC, { extension: 'pausableConfig', state: { authority: PAXOS, paused: false } }), 0);
    expect(running.compatible).toBe(true);
    expect(running.warnings).toContain('pausable');
    // Without `mutable` this record would never expire, and a pause is the most time-varying thing
    // TOK-3 lists — so the one property that must not be cached forever would be.
    expect(running.mutable).toBe(true);
  });

  it('warns rather than blocks when the pause state is unreadable', () => {
    // A jsonParsed spelling change must not take every pausable mint offline; a pause can be lifted,
    // unlike a transfer fee, so this deliberately does not fail safe into a block.
    const unknown = evaluateMint(withExtension(USDC, { extension: 'pausableConfig', state: { authority: null } }), 0);
    expect(unknown.compatible).toBe(true);
    expect(unknown.blockers).toEqual([]);
    expect(unknown.warnings).toContain('pausable');
    expect(unknown.mutable).toBe(true);
  });

  it('warns on an extension it does not recognise, never silently passes', () => {
    expect(evaluateMint(withExtension(USDC, { extension: 'interestBearingConfig', state: {} }), 0).warnings).toContain('unknown-extension');
  });

  it('marks a mint immutable when every transfer-relevant authority is null', () => {
    const hardened: RawMintData = {
      ...USDG,
      extensions: USDG.extensions.map((entry) =>
        entry.extension === 'transferHook'
          ? { extension: 'transferHook', state: { authority: null, programId: null } }
          : entry.extension === 'transferFeeConfig'
            ? { extension: 'transferFeeConfig', state: { ...entry.state, transferFeeConfigAuthority: null } }
            : entry,
      ),
    };
    expect(evaluateMint(hardened, 0).mutable).toBe(false);
  });

  it('rejects data that is not the jsonParsed projection', async () => {
    await expectVadumError(() => evaluateMint({ ...USDC, extensions: 'AAAA' as never }, 0), 'MINT_INCOMPATIBLE');
  });
});

describe('assertMintCompatible', () => {
  it('throws MINT_INCOMPATIBLE with the blocker list', async () => {
    const record = evaluateMint(withExtension(USDG, { extension: 'transferHook', state: { authority: PAXOS, programId: PAXOS } }), 0);
    await expectVadumError(() => assertMintCompatible(record), 'MINT_INCOMPATIBLE', { blockers: ['transfer-hook-active'] });
  });

  it('accepts a compatible record', () => {
    expect(() => assertMintCompatible(evaluateMint(USDC, 0))).not.toThrow();
  });
});

/** The canonical instructions for `input`, built here so tests can tamper with them. */
async function canonicalInstructions(input: CanonicalInput): Promise<Instruction[]> {
  const { intent, payer, amount } = input;
  const programAddress = tokenProgramAddress(intent.tokenProgram);
  const source = await deriveAta(payer, intent.mint, intent.tokenProgram);
  const destination = await deriveAta(intent.merchant, intent.mint, intent.tokenProgram);
  return [getTransferCheckedInstruction({ source, mint: intent.mint, destination, authority: createNoopSigner(payer), amount, decimals: intent.decimals }, { programAddress })];
}

async function compileNonceMessage(input: CanonicalInput, instructions: Instruction[]): Promise<Uint8Array> {
  const draft = appendTransactionMessageInstructions(instructions, setTransactionMessageFeePayer(input.intent.feePayer, createTransactionMessage({ version: 0 })));
  return new Uint8Array(compileTransaction(await durableNonceProvider.applyLifetime(draft, input)).messageBytes);
}

describe('assertCanonical', () => {
  const next = prng(4);
  const base = randomInput(next);
  const input: CanonicalInput = {
    ...base,
    intent: { ...base.intent, lifetime: { kind: 'nonce' }, includeCreateAta: false, isStatic: false, amount: 2_500_000n },
    nonceRef: { index: 3, value: randomAddress(next) as string as never },
    amount: 2_500_000n,
  };

  it('accepts the canonical message', async () => {
    await assertCanonical((await buildMessage(input)).messageBytes, input);
  });

  it('rejects one extra instruction spliced in', async () => {
    const spliced = await compileNonceMessage(input, [
      ...(await canonicalInstructions(input)),
      getTransferSolInstruction({ source: createNoopSigner(input.payer), destination: randomAddress(next), amount: 1n }),
    ]);
    await expectVadumError(() => assertCanonical(spliced, input), 'CANON_INSTRUCTION_NOT_ALLOWED');
  });

  it('rejects an approval hidden next to the transfer', async () => {
    const [transfer] = await canonicalInstructions(input);
    const source = await deriveAta(input.payer, input.intent.mint, input.intent.tokenProgram);
    const approve = getApproveInstruction(
      { source, delegate: randomAddress(next), owner: createNoopSigner(input.payer), amount: 1n },
      { programAddress: tokenProgramAddress(input.intent.tokenProgram) },
    );
    await expectVadumError(async () => assertCanonical(await compileNonceMessage(input, [transfer!, approve]), input), 'CANON_INSTRUCTION_NOT_ALLOWED', {
      programAddress: tokenProgramAddress(input.intent.tokenProgram),
    });
  });

  it('rejects a different amount', async () => {
    const other = { ...input, intent: { ...input.intent, amount: 2_500_001n }, amount: 2_500_001n };
    await expectVadumError(async () => assertCanonical((await buildMessage(other)).messageBytes, input), 'CANON_AMOUNT_MISMATCH', {
      expected: '2500000',
      actual: '2500001',
    });
  });

  it('rejects a different destination', async () => {
    const [transfer] = await canonicalInstructions({ ...input, intent: { ...input.intent, merchant: randomAddress(next) } });
    await expectVadumError(async () => assertCanonical(await compileNonceMessage(input, [transfer!]), input), 'CANON_DESTINATION_MISMATCH');
  });

  it('rejects AdvanceNonceAccount out of first place', async () => {
    const [transfer] = await canonicalInstructions(input);
    const advance = getAdvanceNonceAccountInstruction({
      nonceAccount: await deriveNonceAddress(input.payer, 3),
      nonceAuthority: createNoopSigner(input.payer),
    });
    const draft = appendTransactionMessageInstructions([transfer!, advance], setTransactionMessageFeePayer(input.intent.feePayer, createTransactionMessage({ version: 0 })));
    const misordered = setTransactionMessageLifetimeUsingBlockhash({ blockhash: input.nonceRef!.value as string as Blockhash, lastValidBlockHeight: 0n }, draft);
    await expectVadumError(() => assertCanonical(new Uint8Array(compileTransaction(misordered).messageBytes), input), 'CANON_INSTRUCTION_ORDER');
  });

  it('rejects a different nonce value', async () => {
    const other = { ...input, nonceRef: { index: 3, value: randomAddress(next) as string as never } };
    await expectVadumError(async () => assertCanonical((await buildMessage(other)).messageBytes, input), 'CANON_ACCOUNT_MISMATCH');
  });
});
