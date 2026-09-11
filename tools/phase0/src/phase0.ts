// Phase 0 — live-chain de-risk (plan/60-PHASE0-derisk.md, Stream 0 task 0.5).
//
//   pnpm phase0 --dry                                    offline half: no chain, no SOL
//   pnpm phase0 --init-key .devnet/merchant.json         write a throwaway devnet key and print its address
//   pnpm phase0 --merchant-key .devnet/merchant.json     show the plan and balances; sends nothing
//   pnpm phase0 --merchant-key .devnet/merchant.json --yes   run steps 1–17 on devnet
//
// Options: --rpc <url> (default https://api.devnet.solana.com), --keep (leave the nonce accounts open),
// --log <path> (default plan/references/phase0-log.md).
//
// Devnet only: the cluster's genesis hash is checked before anything is sent. Payments are built with
// the fixture generator's reference builder, so a pass also shows that the committed fixture bytes
// describe transactions the chain accepts.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  appendTransactionMessageInstructions,
  createKeyPairFromPrivateKeyBytes,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  partiallySignTransaction,
  sendAndConfirmDurableNonceTransactionFactory,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  signTransactionMessageWithSigners,
  verifySignature,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Nonce,
  type SignatureBytes,
  type Transaction,
} from '@solana/kit';
import {
  fetchMaybeNonce,
  getCreateAccountInstruction,
  getCreateAccountWithSeedInstruction,
  getInitializeNonceAccountInstruction,
  getNonceSize,
  getTransferSolInstruction,
  getWithdrawNonceAccountInstruction,
  SYSTEM_PROGRAM_ADDRESS,
} from '@solana-program/system';
import {
  fetchMaybeToken,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { buildMessage, bytesEqual, deriveAta, deriveNonceAddress, encodeAuth, FLAG, toBase58, type CanonicalInput } from '@vadum/fixtures/reference';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DECIMALS = 6;
const MINTED = 100_000_000n;
const AMOUNT_A = 2_500_000n;
const AMOUNT_B = 1_000_000n;
const PAYER_FEE_BUFFER = 10_000n;
const MERCHANT2_FUNDING = 10_000_000n;
const MIN_MERCHANT_LAMPORTS = 500_000_000n;

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const flag = (name: string): boolean => argv.includes(name);

const RPC_URL = option('--rpc') ?? 'https://api.devnet.solana.com';
const LOG_PATH = option('--log') ?? new URL('../../../plan/references/phase0-log.md', import.meta.url).pathname;

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_URL.replace(/^http/, 'ws'));
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
const sendAndConfirmDurableNonce = sendAndConfirmDurableNonceTransactionFactory({ rpc, rpcSubscriptions });
type BlockhashSendable = Parameters<typeof sendAndConfirm>[0];
type DurableNonceSendable = Parameters<typeof sendAndConfirmDurableNonce>[0];

// ─── output ─────────────────────────────────────────────────────────────────────────────────────────

interface LogEntry {
  readonly step: string;
  readonly outcome: 'ok' | 'observed' | 'control' | 'failed';
  readonly detail: string;
  readonly signature?: string | undefined;
}

const entries: LogEntry[] = [];
const explorer = (signature: string): string => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
const show = (value: unknown): string => JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'bigint' ? inner.toString() : inner));
const describe = (error: unknown): string => {
  const context = (error as { context?: unknown }).context;
  const base = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return context === undefined ? base : `${base} ${show(context)}`;
};

function record(step: string, outcome: LogEntry['outcome'], detail: string, signature?: string): void {
  entries.push({ step, outcome, detail, signature });
  const mark = outcome === 'failed' ? '✗' : outcome === 'control' ? '○' : '✓';
  console.log(`  ${mark} ${step.padEnd(5)} ${detail}${signature === undefined ? '' : `\n          ${explorer(signature)}`}`);
}

function expect(condition: unknown, step: string, detail: string): asserts condition {
  if (!condition) {
    record(step, 'failed', detail);
    throw new Error(`Phase 0 assertion failed at step ${step}: ${detail}`);
  }
}

// ─── the network guard: proves the offline steps really are offline ─────────────────────────────────

let online = true;

function guard<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value: unknown = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (!online) throw new Error(`network guard: rpc.${String(property)}() called while offline`);
        return (value as (...inner: unknown[]) => unknown).apply(object, args);
      };
    },
  });
}

async function offline<T>(run: () => Promise<T>): Promise<T> {
  online = false;
  try {
    return await run();
  } finally {
    online = true;
  }
}

const guardedRpc = guard(rpc);

// ─── payments, built with the fixture generator's reference builder ─────────────────────────────────

interface SignedPayment {
  readonly input: CanonicalInput;
  /** Compiled, carrying the payer's signature only. */
  readonly transaction: Transaction;
  readonly auth: Uint8Array;
}

async function signPayment(
  payer: KeyPairSigner,
  merchant: Address,
  mint: Address,
  nonceIndex: number,
  nonceValue: Nonce,
  amount: bigint,
  includeCreateAta = false,
): Promise<SignedPayment> {
  const input: CanonicalInput = {
    intent: {
      merchant,
      mint,
      decimals: DECIMALS,
      amount,
      lifetime: { kind: 'nonce' },
      includeCreateAta,
      tokenProgram: 'spl-token',
      feePayer: merchant,
      isStatic: false,
    },
    payer: payer.address,
    nonceRef: { index: nonceIndex, value: nonceValue },
    amount,
  };
  const { messageBytes, transaction } = await buildMessage(input);
  const signature = await signBytes(payer.keyPair.privateKey, messageBytes);
  const auth = encodeAuth({
    flags: includeCreateAta ? FLAG.INCLUDE_CREATE_ATA : 0,
    payer: payer.address,
    nonce: { index: nonceIndex, value: nonceValue },
    amount: null,
    signature: new Uint8Array(signature),
  });
  return { input, transaction: { ...transaction, signatures: { ...transaction.signatures, [payer.address]: signature } }, auth };
}

/** The merchant's offline check: rebuild from the intent and the 132-byte AUTH alone, then verify. */
async function verifyAsMerchant(intent: CanonicalInput['intent'], auth: Uint8Array): Promise<boolean> {
  if (auth.length !== 132 || intent.amount === null) return false;
  const payer = toBase58(auth.subarray(3, 35)) as Address;
  const rebuilt = await buildMessage({
    intent,
    payer,
    nonceRef: { index: auth[35]!, value: toBase58(auth.subarray(36, 68)) as Nonce },
    amount: intent.amount,
  });
  return verifySignature(await getPublicKeyFromAddress(payer), auth.subarray(68) as SignatureBytes, rebuilt.messageBytes);
}

// ─── chain helpers ──────────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const sol = async (address: Address): Promise<bigint> => (await rpc.getBalance(address, { commitment: 'confirmed' }).send()).value;

async function tokens(ata: Address): Promise<bigint> {
  const account = await fetchMaybeToken(rpc, ata, { commitment: 'confirmed' });
  return account.exists ? account.data.amount : 0n;
}

type SlotState =
  | { readonly exists: false }
  | { readonly exists: true; readonly initialized: boolean; readonly authority: Address; readonly value: Nonce; readonly lamports: bigint };

async function readSlot(address: Address): Promise<SlotState> {
  const account = await fetchMaybeNonce(rpc, address, { commitment: 'confirmed' });
  if (!account.exists) return { exists: false };
  return {
    exists: true,
    initialized: Number(account.data.state) === 1,
    authority: account.data.authority,
    // D34: the one place a nonce value typed as Address becomes a Nonce.
    value: account.data.blockhash as string as Nonce,
    lamports: account.lamports,
  };
}

/** client/nonce-check.ts's four checks, in order (26-SPEC). */
function classify(slot: SlotState, payer: Address, claimed: Nonce): 'ok' | 'stale' | 'absent' | 'uninitialized' | 'wrong-authority' {
  if (!slot.exists) return 'absent';
  if (!slot.initialized) return 'uninitialized';
  if (slot.authority !== payer) return 'wrong-authority';
  return slot.value === claimed ? 'ok' : 'stale';
}

async function sendSetup(feePayer: KeyPairSigner, instructions: readonly Instruction[]): Promise<{ signature: string; signerCount: number }> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = appendTransactionMessageInstructions(
    instructions,
    setTransactionMessageLifetimeUsingBlockhash(blockhash, setTransactionMessageFeePayerSigner(feePayer, createTransactionMessage({ version: 0 }))),
  );
  const signed = await signTransactionMessageWithSigners(message as unknown as Parameters<typeof signTransactionMessageWithSigners>[0]);
  await sendAndConfirm(signed as BlockhashSendable, { commitment: 'confirmed' });
  return { signature: getSignatureFromTransaction(signed), signerCount: Object.keys(signed.signatures).length };
}

/**
 * A validation failure, observed the way 60-PHASE0 requires: simulate for the error string, then send
 * with skipPreflight and poll so the validator — not the RPC's simulation — decides. `watchForLanding`
 * is false for an identical replay, whose signature already has a status from the original landing.
 */
async function observeValidationFailure(transaction: Transaction, watchForLanding: boolean) {
  const wire = getBase64EncodedWireTransaction(transaction);
  const simulation = await rpc.simulateTransaction(wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' }).send();
  let sendResponse: string;
  try {
    sendResponse = `accepted for broadcast as ${await rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: true }).send()}`;
  } catch (error) {
    sendResponse = `rejected by the RPC: ${describe(error)}`;
  }
  let landed = false;
  if (watchForLanding) {
    const signature = getSignatureFromTransaction(transaction);
    for (const deadline = Date.now() + 60_000; Date.now() < deadline && !landed; await sleep(2_000)) {
      landed = (await rpc.getSignatureStatuses([signature]).send()).value[0] !== null;
    }
  }
  return { simulationError: show(simulation.value.err), sendResponse, landed };
}

/** An execution failure: send with skipPreflight, wait for confirmation, read the fee and the error. */
async function observeExecutionFailure(transaction: Transaction) {
  const signature = await rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64', skipPreflight: true }).send();
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; await sleep(2_000)) {
    const status = (await rpc.getSignatureStatuses([signature]).send()).value[0];
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') break;
  }
  const landed = await rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
  if (landed === null || landed.meta === null) throw new Error(`transaction ${signature} did not confirm within 90 s`);
  return { signature, err: landed.meta.err, fee: landed.meta.fee };
}

// ─── modes ──────────────────────────────────────────────────────────────────────────────────────────

async function dryRun(): Promise<void> {
  console.log('\nPhase 0 — dry run: the offline half, with no chain and no SOL\n');
  const payer = await generateKeyPairSigner();
  const merchant = await generateKeyPairSigner();
  const mint = (await generateKeyPairSigner()).address;
  const nonceValue = toBase58(crypto.getRandomValues(new Uint8Array(32))) as Nonce;

  const one = await offline(() => signPayment(payer, merchant.address, mint, 0, nonceValue, AMOUNT_A));
  const two = await offline(() => signPayment(payer, merchant.address, mint, 0, nonceValue, AMOUNT_B));
  expect(!bytesEqual(new Uint8Array(one.transaction.messageBytes), new Uint8Array(two.transaction.messageBytes)), '5', 'two different payments signed offline against one nonce value');
  expect(one.auth.length === 132 && two.auth.length === 132, '6', 'both AUTH payloads are 132 bytes');
  expect((await offline(() => verifyAsMerchant(one.input.intent, one.auth))) && (await offline(() => verifyAsMerchant(two.input.intent, two.auth))), '7',
    'both verify offline from (intent, AUTH) alone — the double-spend precondition');
  const full = await offline(() => partiallySignTransaction([merchant.keyPair], one.transaction));
  expect(Object.values(full.signatures).every((signature) => signature !== null), '8', 'the fee-payer signature attaches without the network');

  let guarded = false;
  try {
    await offline(async () => guardedRpc.getLatestBlockhash().send());
  } catch (error) {
    guarded = describe(error).includes('network guard');
  }
  expect(guarded, 'guard', 'an RPC call made while offline throws instead of silently succeeding');
  console.log('\n  DRY RUN PASSED\n');
}

async function initKey(path: string): Promise<void> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const keyPair = await createKeyPairFromPrivateKeyBytes(seed);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const bytes = Uint8Array.from([...seed, ...publicKey]);
  const signer = await createKeyPairSignerFromBytes(bytes);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify([...bytes])}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`\nWrote a throwaway devnet key to ${path} (never overwritten, git-ignored).`);
  console.log(`\n  Address: ${signer.address}\n`);
  console.log('Fund it with at least 0.5 devnet SOL at https://faucet.solana.com, then run:');
  console.log(`  pnpm phase0 --merchant-key ${path}\n`);
}

async function fullRun(merchantKeyPath: string): Promise<void> {
  const merchant = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(await readFile(merchantKeyPath, 'utf8')) as number[]));
  const genesis = await rpc.getGenesisHash().send();
  if (genesis !== DEVNET_GENESIS_HASH) throw new Error(`refusing to run: ${RPC_URL} is not devnet (genesis hash ${genesis})`);
  const merchantLamports = await sol(merchant.address);

  console.log('\nPhase 0 — plan');
  console.log(`  cluster    devnet (${RPC_URL})`);
  console.log(`  merchant   ${merchant.address} — ${Number(merchantLamports) / 1e9} SOL`);
  console.log('  sends      ~12 devnet transactions: a test mint, two nonce slots, payments A and B against one');
  console.log('             nonce, a deliberate overdraft, a fabricated nonce, a create-ATA payment, then closes');
  console.log('             the slots and sweeps leftover SOL back to the merchant');
  console.log('  spends     roughly 0.01 devnet SOL in rent that is not refunded, plus fees');
  if (merchantLamports < MIN_MERCHANT_LAMPORTS) throw new Error(`the merchant needs at least 0.5 devnet SOL; it has ${Number(merchantLamports) / 1e9}`);
  if (!flag('--yes')) {
    console.log('\nNothing was sent. Re-run with --yes to execute steps 1–17 on devnet.\n');
    return;
  }

  const payer = await generateKeyPairSigner();
  const merchant2 = await generateKeyPairSigner();
  const ghost = await generateKeyPairSigner();
  const mint = await generateKeyPairSigner();
  const header: Record<string, string> = {
    Cluster: `devnet — ${RPC_URL}, genesis \`${genesis}\``,
    Merchant: `\`${merchant.address}\``,
    Payer: `\`${payer.address}\` (fresh keypair)`,
    'Merchant 2': `\`${merchant2.address}\` (fresh keypair)`,
    Ghost: `\`${ghost.address}\` (fresh keypair, never funded)`,
    'Test mint': `\`${mint.address}\` — legacy SPL Token, 6 decimals, no extensions (D24)`,
  };
  console.log('\nPhase 0 — run\n');

  try {
    // 1 · test mint, token accounts, tokens for the payer
    const mintRent = await rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize())).send();
    await sendSetup(merchant, [
      getCreateAccountInstruction({ payer: merchant, newAccount: mint, lamports: mintRent, space: BigInt(getMintSize()), programAddress: TOKEN_PROGRAM_ADDRESS }),
      getInitializeMint2Instruction({ mint: mint.address, decimals: DECIMALS, mintAuthority: merchant.address }),
    ]);
    const payerAta = await deriveAta(payer.address, mint.address, 'spl-token');
    const merchantAta = await deriveAta(merchant.address, mint.address, 'spl-token');
    const funded = await sendSetup(merchant, [
      getCreateAssociatedTokenIdempotentInstruction({ payer: merchant, ata: payerAta, owner: payer.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: merchant, ata: merchantAta, owner: merchant.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
      getMintToInstruction({ mint: mint.address, token: payerAta, mintAuthority: merchant, amount: MINTED }),
    ]);
    expect((await tokens(payerAta)) === MINTED, '1', `the payer holds ${MINTED} base units of the test mint`);
    record('1', 'ok', `test mint created; the payer holds ${MINTED} base units`, funded.signature);

    // 2 · the payer funds and creates its own pool of two slots (D26)
    // A system account must end every transaction at zero or rent-exempt, so the payer receives the
    // pool's rent, the setup fee, and its own rent-exempt minimum. Step 3 sweeps whatever is left.
    const nonceRent = await rpc.getMinimumBalanceForRentExemption(BigInt(getNonceSize())).send();
    const walletRent = await rpc.getMinimumBalanceForRentExemption(0n).send();
    await sendSetup(merchant, [
      getTransferSolInstruction({ source: merchant, destination: payer.address, amount: 2n * nonceRent + PAYER_FEE_BUFFER + walletRent }),
    ]);
    const slot0 = await deriveNonceAddress(payer.address, 0);
    const slot1 = await deriveNonceAddress(payer.address, 1);
    const slotInstructions = (index: number, address: Address): Instruction[] => [
      getCreateAccountWithSeedInstruction({
        payer,
        newAccount: address,
        base: payer.address,
        seed: `vadum-${index}`,
        amount: nonceRent,
        space: BigInt(getNonceSize()),
        programAddress: SYSTEM_PROGRAM_ADDRESS,
      }),
      getInitializeNonceAccountInstruction({ nonceAccount: address, nonceAuthority: payer.address }),
    ];
    const pool = await sendSetup(payer, [...slotInstructions(0, slot0), ...slotInstructions(1, slot1)]);
    expect(pool.signerCount === 1, '2', `pool setup needs exactly one signature (D26); it needed ${pool.signerCount}`);
    record('2', 'ok', `the payer created slots 0 and 1 with one signature, funding ${2n * nonceRent} lamports of rent itself (D26)`, pool.signature);

    // 3 · sweep the payer's wallet to zero
    await sendSetup(merchant, [getTransferSolInstruction({ source: payer, destination: merchant.address, amount: await sol(payer.address) })]);
    expect((await sol(payer.address)) === 0n, '3', 'the payer wallet holds 0 SOL');
    record('3', 'ok', 'the payer wallet holds 0 SOL; its rent deposit sits in the nonce accounts');

    // 4 · read both slots
    const before0 = await readSlot(slot0);
    const before1 = await readSlot(slot1);
    expect(before0.exists && before0.initialized && before0.authority === payer.address, '4', 'slot 0 is initialized with the payer as authority');
    expect(before1.exists && before1.initialized && before1.authority === payer.address, '4', 'slot 1 is initialized with the payer as authority');
    record('4', 'ok', `slot 0 holds ${before0.value}; slot 1 holds ${before1.value}`);

    // 5–7 · offline: two different payments against slot 0, both verified by the merchant
    const payment1 = await offline(() => signPayment(payer, merchant.address, mint.address, 0, before0.value, AMOUNT_A));
    const payment2 = await offline(() => signPayment(payer, merchant.address, mint.address, 0, before0.value, AMOUNT_B));
    expect(!bytesEqual(new Uint8Array(payment1.transaction.messageBytes), new Uint8Array(payment2.transaction.messageBytes)), '5', 'the two payments are different messages');
    expect(payment1.auth.length === 132 && payment2.auth.length === 132, '6', 'both AUTH payloads are 132 bytes');
    expect(
      (await offline(() => verifyAsMerchant(payment1.input.intent, payment1.auth))) &&
        (await offline(() => verifyAsMerchant(payment2.input.intent, payment2.auth))),
      '7',
      'both payments verify offline from (intent, AUTH) alone',
    );
    record('5–7', 'ok', `with the network guard armed: payments for ${AMOUNT_A} and ${AMOUNT_B} signed against one nonce value, both verified offline`);

    // 8–9 · ASSERT A
    const full1 = await partiallySignTransaction([merchant.keyPair], payment1.transaction);
    const merchantTokensBefore = await tokens(merchantAta);
    await sendAndConfirmDurableNonce(full1 as DurableNonceSendable, { commitment: 'confirmed' });
    const signature1 = getSignatureFromTransaction(full1);
    expect((await tokens(merchantAta)) === merchantTokensBefore + AMOUNT_A, '9', 'payment 1 landed and the merchant received amount A');
    expect((await sol(payer.address)) === 0n, '9', 'the payer still holds 0 SOL (SOL-12)');
    record('8–9', 'ok', 'ASSERT A — the offline-signed, offline-verified payment landed through the durable-nonce confirmer (SOL-15)', signature1);

    // 10–11 · ASSERT B (D35)
    const merchantLamportsBeforeB = await sol(merchant.address);
    const afterA = await readSlot(slot0);
    expect(afterA.exists, '10', 'slot 0 still exists');
    const full2 = await partiallySignTransaction([merchant.keyPair], payment2.transaction);
    const observedB = await observeValidationFailure(full2, true);
    const afterB = await readSlot(slot0);
    expect(!observedB.landed, '11', 'payment 2 never landed');
    expect((await sol(merchant.address)) === merchantLamportsBeforeB, '11', 'the merchant was charged nothing');
    expect(afterB.exists && afterB.value === afterA.value, '11', 'payment 2 did not move slot 0');
    const verdictB = classify(afterB, payer.address, before0.value);
    expect(verdictB === 'stale', '11', `slot 0 classifies as stale; got ${verdictB}`);
    record('11', 'ok', `ASSERT B — a different payment against the consumed nonce never landed, cost nothing, and classifies as stale. Simulation: ${observedB.simulationError}. Send: ${observedB.sendResponse}`);

    // 12 · control
    const replay = await observeValidationFailure(full1, false);
    expect((await sol(merchant.address)) === merchantLamportsBeforeB, '12', 'the identical replay charged nothing');
    record('12', 'control', `identical replay of payment 1 — rejected, as it would be without any nonce (D35). Simulation: ${replay.simulationError}. Send: ${replay.sendResponse}`);

    // 13 · SOL-8
    const { value: latest } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    expect(afterB.exists && afterB.value !== before0.value && afterB.value !== (latest.blockhash as string), '13',
      'slot 0 advanced to a value that is neither the old value nor the current blockhash (SOL-8)');
    record('13', 'ok', `slot 0 now holds ${afterB.value} — the value a NONCE_RETURN would carry`);

    // 14 · execution failure (SOL-7)
    const overdraft = await offline(() => signPayment(payer, merchant.address, mint.address, 1, before1.value, MINTED * 10n));
    const fullOverdraft = await partiallySignTransaction([merchant.keyPair], overdraft.transaction);
    const merchantLamportsBeforeOverdraft = await sol(merchant.address);
    const execution = await observeExecutionFailure(fullOverdraft);
    const charged = merchantLamportsBeforeOverdraft - (await sol(merchant.address));
    const after1 = await readSlot(slot1);
    expect(execution.err !== null, '14', 'the overdraft landed with an execution error');
    expect(charged > 0n && charged === BigInt(execution.fee), '14', `the merchant was charged the fee: ${charged} lamports, fee ${execution.fee}`);
    expect(after1.exists && after1.value !== before1.value, '14', 'slot 1 advanced despite the failure');
    record('14', 'observed', `execution failure — error ${show(execution.err)}; fee ${execution.fee} lamports charged to the merchant; slot 1 advanced. SUBMIT_EXECUTION_FAILED semantics confirmed`, execution.signature);

    // 15 · fabricated nonce (T6, D21)
    const invented = toBase58(crypto.getRandomValues(new Uint8Array(32))) as Nonce;
    const fabricated = await offline(() => signPayment(ghost, merchant.address, mint.address, 0, invented, AMOUNT_B));
    expect(await offline(() => verifyAsMerchant(fabricated.input.intent, fabricated.auth)), '15', 'the fabricated payment verifies offline (T6)');
    const fullFabricated = await partiallySignTransaction([merchant.keyPair], fabricated.transaction);
    const merchantLamportsBeforeFabricated = await sol(merchant.address);
    const observedFabricated = await observeValidationFailure(fullFabricated, true);
    const ghostSlot = await readSlot(await deriveNonceAddress(ghost.address, 0));
    expect(!observedFabricated.landed, '15', 'the fabricated payment never landed');
    expect((await sol(merchant.address)) === merchantLamportsBeforeFabricated, '15', 'the merchant was charged nothing');
    expect(classify(ghostSlot, ghost.address, invented) === 'absent', '15', 'the derived nonce account is absent');
    record('15', 'observed', `fabricated nonce — verified offline, never landed, cost nothing, account absent: SUBMIT_NONCE_ABSENT (D21). Simulation: ${observedFabricated.simulationError}. Send: ${observedFabricated.sendResponse}`);

    // 16 · create-ATA branch (D5)
    await sendSetup(merchant, [getTransferSolInstruction({ source: merchant, destination: merchant2.address, amount: MERCHANT2_FUNDING })]);
    const merchant2Ata = await deriveAta(merchant2.address, mint.address, 'spl-token');
    expect(!(await fetchMaybeToken(rpc, merchant2Ata, { commitment: 'confirmed' })).exists, '16', 'merchant 2 has no token account yet');
    const withAta = await offline(() => signPayment(payer, merchant2.address, mint.address, 0, afterB.value, AMOUNT_B, true));
    const fullWithAta = await partiallySignTransaction([merchant2.keyPair], withAta.transaction);
    await sendAndConfirmDurableNonce(fullWithAta as DurableNonceSendable, { commitment: 'confirmed' });
    expect((await tokens(merchant2Ata)) === AMOUNT_B, '16', 'merchant 2 received amount B into an ATA the payment itself created');
    expect((await sol(payer.address)) === 0n, '16', 'the payer still holds 0 SOL');
    record('16', 'ok', 'a payment with createAssociatedTokenAccountIdempotent landed; merchant 2 funded its own ATA (D5, D19)', getSignatureFromTransaction(fullWithAta));

    // 17 · close the pool; rent returns to the payer (D26)
    if (flag('--keep')) {
      record('17', 'control', 'skipped: --keep leaves both slots open');
    } else {
      const open0 = await readSlot(slot0);
      const open1 = await readSlot(slot1);
      expect(open0.exists && open1.exists, '17', 'both slots are still open');
      const closed = await sendSetup(merchant, [
        getWithdrawNonceAccountInstruction({ nonceAccount: slot0, recipientAccount: payer.address, nonceAuthority: payer, withdrawAmount: open0.lamports }),
        getWithdrawNonceAccountInstruction({ nonceAccount: slot1, recipientAccount: payer.address, nonceAuthority: payer, withdrawAmount: open1.lamports }),
      ]);
      expect((await sol(payer.address)) === open0.lamports + open1.lamports, '17', 'the full rent returned to the payer');
      record('17', 'ok', `both slots closed; ${open0.lamports + open1.lamports} lamports of rent returned to the payer (D26)`, closed.signature);
      await sendSetup(merchant, [
        getTransferSolInstruction({ source: payer, destination: merchant.address, amount: await sol(payer.address) }),
        getTransferSolInstruction({ source: merchant2, destination: merchant.address, amount: await sol(merchant2.address) }),
      ]);
    }

    await writeLog('PASSED', header);
    console.log(`\n  PHASE 0 PASSED — log written to ${LOG_PATH}\n`);
  } catch (error) {
    await writeLog('FAILED', header, error);
    console.error(`\n  PHASE 0 FAILED — log written to ${LOG_PATH}\n`);
    throw error;
  }
}

async function writeLog(status: 'PASSED' | 'FAILED', header: Record<string, string>, error?: unknown): Promise<void> {
  const cell = (text: string): string => text.replaceAll('|', '\\|');
  const lines = [
    '# Phase 0 — run log',
    '',
    `**${status}** · ${new Date().toISOString()} · written by \`tools/phase0/src/phase0.ts\` per \`plan/60-PHASE0-derisk.md\``,
    '',
    '| | |',
    '|---|---|',
    ...Object.entries(header).map(([key, value]) => `| ${key} | ${cell(value)} |`),
    '',
    '| Step | Outcome | Detail | Transaction |',
    '|---|---|---|---|',
    ...entries.map((entry) =>
      `| ${entry.step} | ${entry.outcome} | ${cell(entry.detail)} | ${entry.signature === undefined ? '' : `[${entry.signature.slice(0, 8)}…](${explorer(entry.signature)})`} |`),
    ...(error === undefined ? [] : ['', '## Failure', '', '```', describe(error), '```']),
    '',
  ];
  await mkdir(dirname(LOG_PATH), { recursive: true });
  await writeFile(LOG_PATH, lines.join('\n'));
}

const initPath = option('--init-key');
const merchantKeyPath = option('--merchant-key');
if (flag('--dry')) {
  await dryRun();
} else if (initPath !== undefined) {
  await initKey(initPath);
} else if (merchantKeyPath !== undefined) {
  await fullRun(merchantKeyPath);
  process.exit(process.exitCode ?? 0);
} else {
  console.log('usage: pnpm phase0 --dry | --init-key <path> | --merchant-key <path> [--yes] [--keep] [--rpc <url>] [--log <path>]');
  process.exitCode = 2;
}
