// Stream B devnet verification — the "Done when" clauses of B6–B10 in plan/41-STREAM-B-wire-client.md,
// run against the live cluster through @vadum/client, @vadum/wire and @vadum/core rather than through
// the fixture generator's reference builder. A pass shows that the packages settle a real payment and
// that the three submission failure classes are three different observable events (D21).
//
//   pnpm devnet:b --merchant-key .devnet/merchant.json            plan only; sends nothing
//   pnpm devnet:b --merchant-key .devnet/merchant.json --yes      runs the steps on devnet
//
// Options: --rpc <url>, --mainnet-rpc <url> (read-only mint checks), --log <path>, --keep.
// Devnet only: the genesis hash is checked before anything is sent.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  createKeyPairFromPrivateKeyBytes,
  createSignerFromKeyPair,
  createSolanaRpc,
  generateKeyPair,
  getAddressFromPublicKey,
  type Address,
  type Nonce,
} from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  extension,
  getInitializeMint2Instruction as getInitializeMint2Instruction2022,
  getInitializeTransferHookInstruction,
  getMintSize as getMintSize2022,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import {
  createMemoryStore,
  createMintCache,
  createPool,
  createQueue,
  createRpc,
  DEFAULT_QUEUE_LIMITS,
  LAMPORTS_PER_SIGNATURE,
  precheckNonce,
  submit,
  type VadumRpc,
} from '@vadum/client';
import {
  assertMintCompatible,
  deriveAta,
  deriveNonceAddress,
  evaluateMint,
  signAsPayer,
  signNonceReturn,
  VadumError,
  verifyAuth,
  type CanonicalInput,
  type Intent,
  type MintRecord,
  type VerifiedPayment,
} from '@vadum/core';
import { decodeAuth, decodeIntent, decodeNonceReturn, encodeAuth, encodeIntent, encodeNonceReturn, flagsFromByte } from '@vadum/wire';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address;
const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address;
const USDG = '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH' as Address;
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' as Address;

const DECIMALS = 6;
const MINTED = 100_000_000n;
const AMOUNT = 2_500_000n;
const POOL_SIZE = 3;
const MIN_MERCHANT_LAMPORTS = 300_000_000n;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const flag = (name: string): boolean => argv.includes(name);

const RPC_URL = option('--rpc') ?? 'https://api.devnet.solana.com';
const MAINNET_RPC_URL = option('--mainnet-rpc') ?? 'https://api.mainnet-beta.solana.com';
const LOG_PATH = option('--log') ?? new URL('../../../plan/references/stream-b-devnet-log.md', import.meta.url).pathname;

// ─── output ─────────────────────────────────────────────────────────────────────────────────────────

interface LogEntry {
  readonly step: string;
  readonly outcome: 'ok' | 'observed' | 'failed';
  readonly detail: string;
}

const entries: LogEntry[] = [];
const show = (value: unknown): string => JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'bigint' ? inner.toString() : inner));
const explain = (error: unknown): string => {
  const context = (error as { context?: unknown }).context;
  const base = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return context === undefined ? base : `${base} ${show(context)}`;
};

/** A public endpoint throttles a burst of a dozen transactions, so the run paces itself. */
const PACE_MS = 2_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function log(step: string, outcome: LogEntry['outcome'], detail: string): void {
  entries.push({ step, outcome, detail });
  console.log(`  ${outcome === 'failed' ? '✗' : '✓'} ${step.padEnd(4)} ${detail}`);
}

/** Recorded, then paused: every step boundary gives the endpoint a moment. */
async function paced(step: string, outcome: LogEntry['outcome'], detail: string): Promise<void> {
  log(step, outcome, detail);
  await sleep(PACE_MS);
}

function expect(condition: unknown, step: string, detail: string): asserts condition {
  if (!condition) {
    log(step, 'failed', detail);
    throw new Error(`devnet-b assertion failed at step ${step}: ${detail}`);
  }
}

/** The VadumError code a call raises, for asserting a refusal without swallowing a real crash. */
const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof VadumError ? error.code : `unexpected: ${explain(error)}`;
  }
  return 'nothing thrown';
};

// ─── payments, built the way the two apps will build them ───────────────────────────────────────────

interface SignedPayment {
  readonly payment: VerifiedPayment;
  readonly intentBytes: Uint8Array;
  readonly authBytes: Uint8Array;
}

/**
 * The whole offline round trip: the merchant's intent encoded to QR bytes, decoded by the payer,
 * signed, encoded back as an AUTH, decoded by the merchant, and verified against a rebuilt message.
 */
async function signedPayment(
  intent: Intent,
  payerKey: CryptoKeyPair,
  nonceRef: NonNullable<CanonicalInput['nonceRef']>,
  amount: bigint,
  mintCache: ReadonlyMap<Address, MintRecord>,
): Promise<SignedPayment> {
  const payer = await getAddressFromPublicKey(payerKey.publicKey);
  const intentBytes = encodeIntent(intent);
  const decodedIntent = decodeIntent(intentBytes, { mintCache });
  const auth = await signAsPayer({ intent: decodedIntent, payer, nonceRef, amount }, payerKey);

  const flags = flagsFromByte(intentBytes[2]!);
  const authBytes = encodeAuth(auth, flags);
  const decodedAuth = decodeAuth(authBytes, { mintCache, intentFlags: flags });
  return { payment: await verifyAuth(decodedIntent, decodedAuth), intentBytes, authBytes };
}

const intentFor = (merchant: Address, mint: Address, amount: bigint): Intent => ({
  merchant,
  mint,
  decimals: DECIMALS,
  amount,
  lifetime: { kind: 'nonce' },
  includeCreateAta: false,
  tokenProgram: 'spl-token',
  feePayer: merchant,
  isStatic: false,
});

// ─── B6: the live mint claims in the plan, checked against the live clusters ─────────────────────────

async function liveMintChecks(rpc: VadumRpc, mainnet: VadumRpc): Promise<MintRecord[]> {
  const records: MintRecord[] = [];
  const check = async (label: string, client: VadumRpc, mint: Address, expectMutable: boolean): Promise<void> => {
    const cache = createMintCache(client, createMemoryStore());
    const evaluated = await cache.refresh(mint);
    records.push(evaluated);
    expect(evaluated.compatible, '1', `${label} must evaluate compatible; blockers ${show(evaluated.blockers)}`);
    expect(evaluated.mutable === expectMutable, '1', `${label} mutable must be ${String(expectMutable)}; got ${String(evaluated.mutable)}`);
    const staleness = cache.staleness(mint, evaluated.checkedAt + YEAR_MS);
    expect(staleness === (expectMutable ? 'stale-mutable' : 'fresh'), '1', `${label} staleness after a year reads ${staleness}`);
    console.log(`      ${label}: ${evaluated.tokenProgram}, decimals ${evaluated.decimals}, warnings [${evaluated.warnings.join(', ')}], mutable ${String(evaluated.mutable)}`);
  };

  await check('devnet USDC', rpc, DEVNET_USDC, false);
  await check('mainnet USDC', mainnet, MAINNET_USDC, false);
  await check('mainnet USDG', mainnet, USDG, true);
  await check('mainnet PYUSD', mainnet, PYUSD, true);
  log('1', 'ok', 'live USDC on both clusters evaluates compatible and immutable; USDG and PYUSD compatible with warnings and mutable, so D22 staleness applies to them alone');
  return records;
}

// ─── the run ────────────────────────────────────────────────────────────────────────────────────────

async function run(merchantKeyPath: string): Promise<void> {
  const merchantKey = await createKeyPairFromPrivateKeyBytes(
    Uint8Array.from(JSON.parse(await readFile(merchantKeyPath, 'utf8')) as number[]).subarray(0, 32),
  );
  const merchant = await getAddressFromPublicKey(merchantKey.publicKey);
  const merchantSigner = await createSignerFromKeyPair(merchantKey);

  const rpc = createRpc(RPC_URL);
  const mainnet = createRpc(MAINNET_RPC_URL);
  expect(rpc.cluster === 'devnet', '0', `${RPC_URL} must be devnet; the endpoint reads as ${rpc.cluster}`);
  const genesis = await createSolanaRpc(RPC_URL).getGenesisHash().send();
  expect(genesis === DEVNET_GENESIS_HASH, '0', `refusing to run: ${RPC_URL} is not devnet (genesis ${genesis})`);

  const merchantLamports = await rpc.getBalance(merchant);
  console.log('\nStream B devnet verification — plan');
  console.log(`  cluster    devnet (${RPC_URL}); mainnet reads from ${MAINNET_RPC_URL}, read-only`);
  console.log(`  merchant   ${merchant} — ${Number(merchantLamports) / 1e9} SOL`);
  console.log('  sends      ~12 devnet transactions: an SPL test mint, a Token-2022 mint with an active');
  console.log('             transfer hook, two ATAs, a nonce pool of 3, one settling payment, three');
  console.log('             deliberate failures, then closes the pool and sweeps the payer');
  console.log('  spends     roughly 0.01 devnet SOL of unrecoverable rent plus fees; pool rent is refunded');
  expect(merchantLamports >= MIN_MERCHANT_LAMPORTS, '0', `the merchant needs at least 0.3 devnet SOL; it has ${Number(merchantLamports) / 1e9}`);

  if (!flag('--yes')) {
    console.log('\nNothing was sent. Re-run with --yes to execute.\n');
    return;
  }
  console.log('\nStream B devnet verification — run\n');

  let payer: Address | undefined;
  let mint: Address | undefined;
  let hookMint: Address | undefined;
  try {
    // 1 · live mint reads (B6), before anything is sent
    const records = await liveMintChecks(rpc, mainnet);

    // 2 · an SPL test mint, both ATAs, and tokens for a fresh payer (D24)
    const payerKey = await generateKeyPair();
    payer = await getAddressFromPublicKey(payerKey.publicKey);
    const mintKey = await generateKeyPair();
    mint = await getAddressFromPublicKey(mintKey.publicKey);
    const mintSigner = await createSignerFromKeyPair(mintKey);
    await rpc.sendSetup(
      [
        getCreateAccountInstruction({
          payer: merchantSigner,
          newAccount: mintSigner,
          lamports: await rpc.getRentExemption(getMintSize()),
          space: BigInt(getMintSize()),
          programAddress: TOKEN_PROGRAM_ADDRESS,
        }),
        getInitializeMint2Instruction({ mint, decimals: DECIMALS, mintAuthority: merchant }),
      ],
      merchantKey,
    );
    const payerAta = await deriveAta(payer, mint, 'spl-token');
    const merchantAta = await deriveAta(merchant, mint, 'spl-token');
    await rpc.sendSetup(
      [
        getCreateAssociatedTokenIdempotentInstruction({ payer: merchantSigner, ata: payerAta, owner: payer, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
        getCreateAssociatedTokenIdempotentInstruction({ payer: merchantSigner, ata: merchantAta, owner: merchant, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
        getMintToInstruction({ mint, token: payerAta, mintAuthority: merchantSigner, amount: MINTED }),
      ],
      merchantKey,
    );
    expect((await rpc.getTokenBalance(payerAta)) === MINTED, '2', `the payer must hold ${MINTED} base units`);
    const testMint = await createMintCache(rpc, createMemoryStore()).refresh(mint);
    expect(testMint.compatible && !testMint.mutable, '2', 'the test mint must evaluate compatible and immutable');
    records.push(testMint);
    const mintCache: ReadonlyMap<Address, MintRecord> = new Map(records.map((record) => [record.mint, record]));
    await paced('2', 'ok', `SPL test mint ${mint} created and evaluated compatible; the payer holds ${MINTED} base units`);

    // 3 · a Token-2022 mint with an ACTIVE transfer hook must be refused (B6, TOK-3)
    const hookMintKey = await generateKeyPair();
    hookMint = await getAddressFromPublicKey(hookMintKey.publicKey);
    const hookSize = getMintSize2022([extension('TransferHook', { authority: merchant, programId: TOKEN_PROGRAM_ADDRESS })]);
    await rpc.sendSetup(
      [
        getCreateAccountInstruction({
          payer: merchantSigner,
          newAccount: await createSignerFromKeyPair(hookMintKey),
          lamports: await rpc.getRentExemption(hookSize),
          space: BigInt(hookSize),
          programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        }),
        getInitializeTransferHookInstruction({ mint: hookMint, authority: merchant, programId: TOKEN_PROGRAM_ADDRESS }),
        getInitializeMint2Instruction2022({ mint: hookMint, decimals: DECIMALS, mintAuthority: merchant }),
      ],
      merchantKey,
    );
    const hookFetch = await rpc.getMintAccount(hookMint);
    const hookRecord = evaluateMint(hookFetch.raw, hookFetch.fetchedAt);
    expect(!hookRecord.compatible && hookRecord.blockers.includes('transfer-hook-active'), '3', `the hook mint must block; got ${show(hookRecord.blockers)}`);
    expect((await codeOf(async () => assertMintCompatible(hookRecord))) === 'MINT_INCOMPATIBLE', '3', 'assertMintCompatible must throw MINT_INCOMPATIBLE');
    await paced('3', 'ok', `a live Token-2022 mint with an active transfer hook is blocked: ${show(hookRecord.blockers)}, warnings ${show(hookRecord.warnings)}, mutable ${String(hookRecord.mutable)}`);

    // 4 · an underfunded wallet is refused before anything is sent (B8, D38)
    const brokeKey = await generateKeyPair();
    const brokePool = createPool(rpc, await getAddressFromPublicKey(brokeKey.publicKey), createMemoryStore());
    expect((await codeOf(() => brokePool.create(POOL_SIZE, brokeKey))) === 'NONCE_POOL_UNDERFUNDED', '4', 'a 0-lamport wallet must raise NONCE_POOL_UNDERFUNDED');
    await paced('4', 'ok', 'pool creation for a 0-lamport wallet raised NONCE_POOL_UNDERFUNDED and sent nothing (D38)');

    // 5 · the payer funds and creates its own pool (B8, D26)
    const store = createMemoryStore();
    const pool = createPool(rpc, payer, store);
    const cost = await pool.estimateSetupCost(POOL_SIZE);
    // The last `cost.fee` is for the eventual close: a wallet left exactly at the rent floor cannot
    // pay any fee at all, because the fee payer must stay rent-exempt after the deduction (D38).
    await rpc.sendSetup(
      [getTransferSolInstruction({ source: merchantSigner, destination: payer, amount: cost.nonceRent + cost.fee + cost.walletMinimum + cost.fee })],
      merchantKey,
    );
    const created = await pool.create(POOL_SIZE, payerKey);
    expect(created.slots.every((slot) => slot.value !== null && slot.state === 'unspent'), '5', 'every slot must be initialised and unspent');
    expect((await rpc.getBalance(payer)) >= cost.walletMinimum, '5', 'the payer wallet must stay rent-exempt (D38)');
    await paced('5', 'ok', `the payer created its own pool of ${POOL_SIZE}: ${cost.nonceRent} lamports of refundable rent, wallet left at the rent-exempt floor`);

    // 6 · a real payment: reserve, sign offline, verify, pre-check, accept at T1, drain (B7, B9, B10)
    const slot = await pool.reserveSlot(merchant, Date.now());
    const spentAgainstValue = slot.value;
    const first = await signedPayment(intentFor(merchant, mint, AMOUNT), payerKey, slot, AMOUNT, mintCache);
    expect(first.intentBytes.length === 76 && first.authBytes.length === 132, '6', `wire sizes must be 76 and 132; got ${first.intentBytes.length} and ${first.authBytes.length}`);
    const verdict = await precheckNonce(rpc, first.payment);
    expect(verdict.ok, '6', `the pre-check must pass for a live slot; got ${show(verdict)}`);

    const queue = createQueue(rpc, createMemoryStore(), DEFAULT_QUEUE_LIMITS);
    await queue.accept(first.payment, 'T1', AMOUNT, verdict);
    const [settled] = await queue.drain(merchantKey);
    expect(settled?.kind === 'settled', '6', `the payment must settle; got ${show(settled)}`);
    const afterSettle = await rpc.getNonceAccount(await deriveNonceAddress(payer, slot.index));
    expect(afterSettle.kind === 'initialized', '6', 'the slot must still exist after settlement');
    expect(settled.newNonceValue === afterSettle.value, '6', `newNonceValue must equal the value read back; got ${show(settled.newNonceValue)} vs ${afterSettle.value}`);
    expect((await rpc.getTokenBalance(merchantAta)) === AMOUNT, '6', 'the merchant must have received the tokens');
    await paced('6', 'ok', `a T1 payment settled through queue.drain (${settled.signature.slice(0, 12)}…); newNonceValue equals the slot's new value, and the merchant received ${AMOUNT} base units`);

    // 7 · the signed NONCE_RETURN re-arms the slot, and only for this payer (B8, D28)
    const newNonceValue = afterSettle.value;
    const returnBytes = encodeNonceReturn({
      nonceIndex: slot.index,
      newNonceValue,
      signature: await signNonceReturn({ payer, nonceIndex: slot.index, spentAgainstValue, newNonceValue }, merchantKey),
    });
    expect(returnBytes.length === 100, '7', `NONCE_RETURN must be 100 bytes; got ${returnBytes.length}`);
    const strangerKey = await generateKeyPair();
    const forStranger = await signNonceReturn(
      { payer: await getAddressFromPublicKey(strangerKey.publicKey), nonceIndex: slot.index, spentAgainstValue, newNonceValue },
      merchantKey,
    );
    expect(
      (await codeOf(() => pool.applyNonceReturn({ nonceIndex: slot.index, newNonceValue, signature: forStranger }))) === 'NONCE_RETURN_UNTRUSTED',
      '7',
      'a return issued to another payer must be refused',
    );
    const rearmed = await pool.applyNonceReturn(decodeNonceReturn(returnBytes));
    expect(rearmed.slots[slot.index]?.state === 'unspent' && rearmed.slots[slot.index]?.value === newNonceValue, '7', 'the slot must come back holding the new value');
    await paced('7', 'ok', 'the 100-byte signed NONCE_RETURN re-armed the slot; the same return issued to another payer was refused (D28)');

    // 8 · the pre-check now reports a race, and a fabricated nonce reports fraud (B7, D21, T6)
    const stale = await precheckNonce(rpc, first.payment);
    expect(!stale.ok && stale.reason === 'stale', '8', `a consumed slot must read stale; got ${show(stale)}`);
    const ghostKey = await generateKeyPair();
    const invented = created.slots[2]?.value as Nonce;
    const fabricated = await signedPayment(intentFor(merchant, mint, AMOUNT), ghostKey, { index: 0, value: invented }, AMOUNT, mintCache);
    const absent = await precheckNonce(rpc, fabricated.payment);
    expect(!absent.ok && absent.reason === 'absent', '8', `an invented nonce under a fresh payer must read absent; got ${show(absent)}`);
    await paced('8', 'ok', 'the pre-check separates a consumed slot (stale) from a nonce account that never existed (absent): the T1 mitigation, live');

    // 9 · SUBMIT_EXECUTION_FAILED — the failure that actually costs the merchant (B9, SOL-7, D21).
    // Preflight rejects an overdraft before it lands, and a payment that never lands charges nothing,
    // so the expensive class has to be produced deliberately: preflight skipped, transaction lands,
    // fee taken. That is the only way to watch `feeCharged: true` come out of the shipped classifier
    // rather than out of a test double — which is exactly what an adversarial review called out.
    const overdraftSlot = await pool.reserveSlot(merchant, Date.now());
    const overdraft = await signedPayment(intentFor(merchant, mint, MINTED * 10n), payerKey, overdraftSlot, MINTED * 10n, mintCache);
    const lamportsBefore = await rpc.getBalance(merchant);
    const overdraftOutcome = await submit(rpc, overdraft.payment, merchantKey, { skipPreflight: true });
    const charged = lamportsBefore - (await rpc.getBalance(merchant));
    expect(overdraftOutcome.kind === 'failed' && overdraftOutcome.code === 'SUBMIT_EXECUTION_FAILED', '9', `expected SUBMIT_EXECUTION_FAILED; got ${show(overdraftOutcome)}`);
    expect(overdraftOutcome.kind === 'failed' && overdraftOutcome.feeCharged, '9', 'a landed execution failure must report feeCharged true');
    expect(charged > 0n, '9', `the merchant must have paid the fee; its balance moved by ${charged} lamports`);
    log('9', 'observed', `an overdraft sent with preflight skipped landed, failed, and was classified SUBMIT_EXECUTION_FAILED with feeCharged true; ${charged} lamports left the merchant`);

    // 10 · SUBMIT_NONCE_STALE, and the control that separates it from a duplicate (B9, D21, D35).
    // A **different** payment against the value the slot was already spent against is a stale nonce.
    // The byte-identical one is not: same message, same signatures, same signature — it is the
    // transaction that already settled, and the cluster says so. Phase 0 drew the same line (step 12),
    // and an earlier version of this step blurred it by replaying the identical payment.
    const STALE_AMOUNT = AMOUNT + 1n;
    const staleAttempt = await signedPayment(intentFor(merchant, mint, STALE_AMOUNT), payerKey, { index: slot.index, value: spentAgainstValue }, STALE_AMOUNT, mintCache);
    const staleQueue = createQueue(rpc, createMemoryStore(), DEFAULT_QUEUE_LIMITS);
    await staleQueue.accept(staleAttempt.payment, 'T2', STALE_AMOUNT);
    const [staleOutcome] = await staleQueue.drain(merchantKey);
    expect(staleOutcome?.kind === 'failed' && staleOutcome.code === 'SUBMIT_NONCE_STALE', '10', `expected SUBMIT_NONCE_STALE; got ${show(staleOutcome)}`);
    expect(staleQueue.consecutiveFailedSends() === 0, '10', `a stale nonce must not raise the counter; it reads ${staleQueue.consecutiveFailedSends()}`);

    const duplicate = await submit(rpc, first.payment, merchantKey);
    expect(duplicate.kind === 'settled', '10', `re-submitting the identical transaction must report settled, not a fresh failure; got ${show(duplicate)}`);
    await paced(
      '10',
      'observed',
      'a different payment against the consumed value was classified SUBMIT_NONCE_STALE, cost nothing, and left the counter at 0; re-submitting the identical transaction reported settled, because it is the transaction that already landed',
    );

    // 11 · SUBMIT_NONCE_ABSENT, near-certain fraud (B9, T6)
    const fabricatedQueue = createQueue(rpc, createMemoryStore(), DEFAULT_QUEUE_LIMITS);
    await fabricatedQueue.accept(fabricated.payment, 'T2', AMOUNT);
    const [fabricatedOutcome] = await fabricatedQueue.drain(merchantKey);
    expect(fabricatedOutcome?.kind === 'failed' && fabricatedOutcome.code === 'SUBMIT_NONCE_ABSENT', '11', `expected SUBMIT_NONCE_ABSENT; got ${show(fabricatedOutcome)}`);
    expect(fabricatedQueue.consecutiveFailedSends() === 1, '11', `an absent nonce must raise the counter; it reads ${fabricatedQueue.consecutiveFailedSends()}`);
    await paced('11', 'observed', 'a fabricated nonce verified offline, was classified SUBMIT_NONCE_ABSENT on submission, and raised the failed-send counter (T6, D21)');

    // 12 · reconcile: a settled slot comes back with no NONCE_RETURN at all, an abandoned one is
    // released past the send window, and a slot whose payment never landed is released too (B8, D32).
    const settledSlot = await pool.reserveSlot(merchant, Date.now());
    const second = await signedPayment(intentFor(merchant, mint, AMOUNT), payerKey, settledSlot, AMOUNT, mintCache);
    const secondQueue = createQueue(rpc, createMemoryStore(), DEFAULT_QUEUE_LIMITS);
    await secondQueue.accept(second.payment, 'T0', AMOUNT);
    const [secondOutcome] = await secondQueue.drain(merchantKey);
    expect(secondOutcome?.kind === 'settled', '12', `the second payment must settle; got ${show(secondOutcome)}`);

    const abandoned = await pool.reserveSlot(merchant, Date.now());
    const immediate = createPool(rpc, payer, store, { sendWindowMs: 0 });
    await immediate.load();
    const reconciled = await immediate.reconcile(Date.now());
    expect(reconciled.settled.includes(settledSlot.index), '12', `the settled slot must reconcile as settled; got ${show(reconciled)}`);
    expect(reconciled.released.includes(abandoned.index), '12', `the abandoned slot must be released past the window; got ${show(reconciled)}`);
    // The overdraft landed and failed, which advances the nonce exactly as a success does (SOL-8), so
    // its slot reconciles as settled and the payer gets the capacity back.
    expect(reconciled.settled.includes(overdraftSlot.index), '12', `the overdraft slot advanced, so it must reconcile as settled; got ${show(reconciled)}`);
    log(
      '12',
      'ok',
      `reconcile: settled ${show(reconciled.settled)} (re-armed with the on-chain value, no NONCE_RETURN needed), released ${show(reconciled.released)}, still pending ${show(reconciled.stillPending)}`,
    );

    if (flag('--keep')) {
      await paced('13', 'ok', 'close skipped: --keep leaves the pool open');
    } else {
      const payerBefore = await rpc.getBalance(payer);
      const { refundedLamports } = await immediate.close(payerKey);
      const payerAfter = await rpc.getBalance(payer);
      expect(payerAfter >= payerBefore + refundedLamports - LAMPORTS_PER_SIGNATURE, '13', `the refund must arrive in the payer wallet; ${payerBefore} → ${payerAfter}`);
      expect(refundedLamports >= cost.nonceRent, '13', `the full pool rent must come back; got ${refundedLamports} of ${cost.nonceRent}`);
      await rpc.sendSetup(
        [getTransferSolInstruction({ source: await createSignerFromKeyPair(payerKey), destination: merchant, amount: await rpc.getBalance(payer) })],
        merchantKey,
      );
      await paced('13', 'ok', `pool closed: ${refundedLamports} lamports of rent refunded to the payer, then swept back to the merchant (D26)`);
    }

    await writeLog('PASSED', { merchant, payer, mint, hookMint });
    console.log(`\n  STREAM B DEVNET VERIFICATION PASSED — log written to ${LOG_PATH}\n`);
  } catch (error) {
    await writeLog('FAILED', { merchant, payer, mint, hookMint }, error);
    console.error(`\n  FAILED — log written to ${LOG_PATH}\n`);
    throw error;
  }
}

async function writeLog(
  status: 'PASSED' | 'FAILED',
  addresses: { merchant: Address; payer?: Address | undefined; mint?: Address | undefined; hookMint?: Address | undefined },
  error?: unknown,
): Promise<void> {
  const cell = (text: string): string => text.replaceAll('|', '\\|');
  const header: Record<string, string> = {
    Cluster: `devnet — ${RPC_URL} (mainnet reads: ${MAINNET_RPC_URL}, read-only)`,
    Merchant: `\`${addresses.merchant}\``,
    ...(addresses.payer === undefined ? {} : { Payer: `\`${addresses.payer}\` — fresh keypair, funded its own pool (D26)` }),
    ...(addresses.mint === undefined ? {} : { 'SPL test mint': `\`${addresses.mint}\` — 6 decimals, no extensions (D24)` }),
    ...(addresses.hookMint === undefined ? {} : { 'Token-2022 hook mint': `\`${addresses.hookMint}\` — an ACTIVE transferHook, expected to be blocked` }),
    Under_test: '`@vadum/core`, `@vadum/wire`, `@vadum/client` — not the fixture generator’s reference builder',
  };
  const lines = [
    '# Stream B — devnet verification log',
    '',
    `**${status}** · ${new Date().toISOString()} · written by \`tools/devnet-b/src/devnet-b.ts\` for the B6–B10 "Done when" clauses of \`plan/41-STREAM-B-wire-client.md\``,
    '',
    '| | |',
    '|---|---|',
    ...Object.entries(header).map(([key, value]) => `| ${key.replaceAll('_', ' ')} | ${cell(value)} |`),
    '',
    '| Step | Outcome | Detail |',
    '|---|---|---|',
    ...entries.map((entry) => `| ${entry.step} | ${entry.outcome} | ${cell(entry.detail)} |`),
    ...(error === undefined ? [] : ['', '## Failure', '', '```', explain(error), '```']),
    '',
  ];
  await mkdir(dirname(LOG_PATH), { recursive: true });
  await writeFile(LOG_PATH, lines.join('\n'));
}

const merchantKeyPath = option('--merchant-key');
if (merchantKeyPath === undefined) {
  console.log('usage: pnpm devnet:b --merchant-key <path> [--yes] [--keep] [--rpc <url>] [--mainnet-rpc <url>] [--log <path>]');
  process.exitCode = 2;
} else {
  await run(merchantKeyPath);
  process.exit(process.exitCode ?? 0);
}
