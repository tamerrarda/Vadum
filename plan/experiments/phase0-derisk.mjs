#!/usr/bin/env node
/**
 * Vadum — Phase 0 de-risk.
 *
 * Proves the primitive works against a live chain, and emits the golden fixtures every
 * stream depends on. See ../60-PHASE0-derisk.md.
 *
 * The two assertions that matter:
 *   ASSERT A — an offline-signed, offline-verified payment lands on devnet.
 *   ASSERT B — replaying it is rejected, and the merchant is charged nothing.
 *
 * If B fails, the at-most-once guarantee this project is built on does not hold and
 * nothing downstream is worth building.
 *
 * Usage:
 *   npm i @solana/kit@8.0.0 @solana-program/system@0.14.0 @solana-program/token@0.16.0
 *   node phase0-derisk.mjs [--rpc <url>] [--keep] [--fixtures ./fixtures.json]
 */

import {
  address, appendTransactionMessageInstructions, airdropFactory, compileTransaction,
  createAddressWithSeed, createKeyPairSignerFromBytes, createNoopSigner, createSolanaRpc,
  createSolanaRpcSubscriptions, generateKeyPairSigner, getAddressFromPublicKey,
  getBase58Decoder, getBase58Encoder, getBase64Decoder, getSignatureFromTransaction, getTransactionEncoder,
  lamports, partiallySignTransaction, pipe, sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayer, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, setTransactionMessageLifetimeUsingDurableNonce,
  signTransactionMessageWithSigners, createTransactionMessage, verifySignature,
} from '@solana/kit';
import {
  getCreateAccountInstruction, getCreateAccountWithSeedInstruction,
  getInitializeNonceAccountInstruction, getWithdrawNonceAccountInstruction,
  fetchNonce, getNonceSize, SYSTEM_PROGRAM_ADDRESS,
} from '@solana-program/system';
import {
  findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMintInstruction, getMintSize, getMintToInstruction,
  getTransferCheckedInstruction, fetchToken,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';

// ─── config ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const RPC_URL  = arg('--rpc', 'https://api.devnet.solana.com');
const WS_URL   = RPC_URL.replace(/^http/, 'ws');
const FIXTURES = arg('--fixtures', new URL('./fixtures.generated.json', import.meta.url).pathname);
const KEEP     = argv.includes('--keep');
const DRY      = argv.includes('--dry');          // offline half only, no chain, no SOL needed
const MERCHANT_KEY = arg('--merchant-key', null); // Solana CLI keypair JSON (64-number array)

const DECIMALS = 6;
const MINT_AMOUNT = 100_000_000n;   // 100 tokens
const PAY_AMOUNT  =   2_500_000n;   // 2.5 tokens
const SEED_0 = 'vadum-0';
const SEED_1 = 'vadum-1';

// ─── output helpers ──────────────────────────────────────────────────────────
const b58 = getBase58Decoder();
const b64 = getBase64Decoder();
let step = 0;
const section = (t) => console.log(`\n\x1b[1m${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}\x1b[0m`);
const log = (k, v) => console.log(`  ${String(k).padEnd(30)} ${v}`);
const ok  = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const findings = [];
const record = (id, answer) => { findings.push({ id, answer }); console.log(`  \x1b[36m▸ ${id}\x1b[0m  ${answer}`); };
function assert(cond, msg) {
  if (cond) { ok(msg); return; }
  bad(msg);
  throw new Error(`ASSERTION FAILED: ${msg}`);
}

// ─── network guard ───────────────────────────────────────────────────────────
// Wraps the RPC so that any call made while "offline" throws loudly. This is how the
// script proves the offline section really is offline, rather than asserting it.
let NETWORK = true;
function guard(rpcLike, label) {
  return new Proxy(rpcLike, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== 'function') return v;
      return (...args) => {
        if (!NETWORK) throw new Error(`NETWORK GUARD: ${label}.${String(prop)}() called while offline`);
        return v.apply(target, args);
      };
    },
  });
}
const offline = async (fn) => { NETWORK = false; try { return await fn(); } finally { NETWORK = true; } };

const rawRpc = createSolanaRpc(RPC_URL);
const rpc = guard(rawRpc, 'rpc');
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc: rawRpc, rpcSubscriptions });
const airdrop = airdropFactory({ rpc: rawRpc, rpcSubscriptions });

const latestBlockhash = async () => (await rpc.getLatestBlockhash().send()).value;
const solOf = async (a) => Number((await rpc.getBalance(a).send()).value) / 1e9;

async function submit(instructions, feePayerSigner, extraSigners = []) {
  const bh = await latestBlockhash();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayerSigner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(msg, { signers: extraSigners });
  await sendAndConfirm(signed, { commitment: 'confirmed' });
  return getSignatureFromTransaction(signed);
}

// ─── funding ─────────────────────────────────────────────────────────────────
// The public devnet faucet is heavily rate-limited (HTTP 429) and returns opaque
// internal errors under load. Never depend on it: prefer an already-funded key.
async function loadOrFundMerchant() {
  if (MERCHANT_KEY) {
    const fs = await import('node:fs/promises');
    const raw = JSON.parse(await fs.readFile(MERCHANT_KEY, 'utf8'));
    const signer = await createKeyPairSignerFromBytes(Uint8Array.from(raw));
    const bal = await solOf(signer.address);
    log('merchant (from --merchant-key)', signer.address);
    log('balance', `${bal} SOL`);
    if (bal < 0.5) throw new Error(`merchant ${signer.address} has ${bal} SOL; needs at least 0.5`);
    return signer;
  }
  const signer = await generateKeyPairSigner();
  log('merchant (generated)', signer.address);
  for (const sol of [2, 1, 0.5]) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await airdrop({ commitment: 'confirmed', lamports: lamports(BigInt(sol * 1e9)), recipientAddress: signer.address });
        ok(`airdropped ${sol} SOL`);
        return signer;
      } catch (e) {
        const m = e?.context?.__serverMessage ?? e?.message ?? String(e);
        log(`airdrop ${sol} SOL (try ${attempt})`, m.slice(0, 60));
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  throw new Error(
    `Devnet faucet refused (rate limit).\n\n` +
    `  Fund this address, then re-run with --merchant-key:\n` +
    `    ${signer.address}\n\n` +
    `  Options:\n` +
    `    • https://faucet.solana.com  (web faucet, captcha)\n` +
    `    • solana airdrop 2 <addr> --url devnet\n` +
    `    • node phase0-derisk.mjs --merchant-key ~/.config/solana/id.json\n\n` +
    `  Or verify the offline half with no SOL at all:  node phase0-derisk.mjs --dry`);
}

// ═════════════════════════════════════════════════════════════════════════════
// THE CANONICAL BUILDER — the one function both sides call.
// This is the reference implementation of `@vadum/core#buildMessage`
// (see ../22-SPEC-core-api.md). It is pure: no RPC, no clock, no storage.
// ═════════════════════════════════════════════════════════════════════════════
async function buildMessage({ merchant, mint, decimals, amount, payer, tokenProgram,
                              lifetime, nonceAccount, includeCreateAta }) {
  const [source]      = await findAssociatedTokenPda({ owner: payer,    mint, tokenProgram });
  const [destination] = await findAssociatedTokenPda({ owner: merchant, mint, tokenProgram });

  const ixs = [];
  if (includeCreateAta) {
    ixs.push(getCreateAssociatedTokenIdempotentInstruction({
      payer: createNoopSigner(merchant),   // merchant funds its own ATA — payer never spends SOL
      ata: destination, owner: merchant, mint, tokenProgram,
    }));
  }
  ixs.push(getTransferCheckedInstruction({
    source, mint, destination,
    // MUST be a signer, not a bare Address. On the fresh-blockhash path a bare Address
    // yields numRequiredSignatures = 1 and the payer is silently NOT marked as a signer:
    // the message verifies offline and is rejected on chain. See ../10-RESEARCH-solana.md.
    authority: createNoopSigner(payer),
    amount, decimals,
  }, { programAddress: tokenProgram }));

  let m = createTransactionMessage({ version: 0 });
  m = setTransactionMessageFeePayer(merchant, m);
  m = lifetime.kind === 'nonce'
    ? setTransactionMessageLifetimeUsingDurableNonce(
        { nonce: lifetime.value, nonceAccountAddress: nonceAccount, nonceAuthorityAddress: payer }, m)
    : setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight }, m);
  m = appendTransactionMessageInstructions(ixs, m);
  return compileTransaction(m);
}

// ─── AUTH payload codec (../21-SPEC-wire-format.md) ──────────────────────────
const FLAG_LIFETIME_FRESH = 1 << 0;
const FLAG_INCLUDE_CREATE_ATA = 1 << 1;
const FLAG_TOKEN_2022 = 1 << 2;

function encodeAuth({ flags, payer, nonceIndex, nonceValue, signature }) {
  const enc = (a) => new Uint8Array(getBase58Encoder().encode(a));
  const parts = [Uint8Array.from([0x01, 0x03, flags]), enc(payer)];
  if (!(flags & FLAG_LIFETIME_FRESH)) { parts.push(Uint8Array.from([nonceIndex]), enc(nonceValue)); }
  parts.push(signature);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// DRY RUN — everything that does not touch the chain. Proves the canonical builder,
// the byte-identical rebuild, offline verification and the AUTH codec, with no SOL.
// ═════════════════════════════════════════════════════════════════════════════
async function dryRun() {
  console.log(`\n\x1b[1mVadum Phase 0 — DRY RUN\x1b[0m   (offline half only, no chain)\n`);
  const rand32 = () => b58.decode(crypto.getRandomValues(new Uint8Array(32)));

  const merchant = await generateKeyPairSigner();
  const payer    = await generateKeyPairSigner();
  const MINT     = address(rand32());
  const nonceValue = rand32();
  const nonce0 = await createAddressWithSeed({ baseAddress: payer.address, programAddress: SYSTEM_PROGRAM_ADDRESS, seed: SEED_0 });

  section('Canonical builder + offline signing (network guard armed)');
  const intent = { merchant: merchant.address, mint: MINT, decimals: DECIMALS,
                   amount: PAY_AMOUNT, tokenProgram: TOKEN_PROGRAM_ADDRESS };

  for (const [label, lifetime, includeCreateAta, expectSigs] of [
    ['nonce path, no ATA',   { kind: 'nonce', value: nonceValue }, false, 2],
    ['nonce path, with ATA', { kind: 'nonce', value: nonceValue }, true,  2],
    ['fresh path, no ATA',   { kind: 'fresh', blockhash: rand32(), lastValidBlockHeight: 1n }, false, 2],
  ]) {
    const a = await offline(() => buildMessage({ ...intent, payer: payer.address, lifetime, nonceAccount: nonce0, includeCreateAta }));
    const b = await offline(() => buildMessage({ ...intent, payer: payer.address, lifetime, nonceAccount: nonce0, includeCreateAta }));
    const ab = new Uint8Array(a.messageBytes), bb = new Uint8Array(b.messageBytes);
    const identical = ab.length === bb.length && ab.every((v, i) => v === bb[i]);
    const signed = await offline(() => partiallySignTransaction([payer.keyPair], a));
    const sig = signed.signatures[payer.address];
    const verified = await offline(() => verifySignature(payer.keyPair.publicKey, sig, b.messageBytes));
    const requiredSigs = ab[1];

    console.log(`\n  \x1b[1m${label}\x1b[0m`);
    log('compiled message', `${ab.length} bytes`);
    log('numRequiredSignatures', requiredSigs);
    assert(identical, 'byte-identical rebuild');
    assert(verified, 'signature verifies offline against the rebuilt message');
    assert(requiredSigs === expectSigs, `payer IS marked as a signer (requiredSigs=${expectSigs}) — the createNoopSigner rule holds`);

    if (lifetime.kind === 'nonce') {
      const auth = encodeAuth({ flags: includeCreateAta ? FLAG_INCLUDE_CREATE_ATA : 0,
        payer: payer.address, nonceIndex: 0, nonceValue, signature: sig });
      log('AUTH payload', `${auth.length} bytes`);
      assert(auth.length === 132, 'AUTH is 132 bytes = 3 + 32 + 1 + 32 + 64');
      assert(auth[0] === 0x01 && auth[1] === 0x03, 'AUTH header: version 0x01, type 0x03');
    }
  }

  section('Network guard');
  let guarded = false;
  try { await offline(() => rpc.getLatestBlockhash().send()); } catch (e) { guarded = /NETWORK GUARD/.test(e.message); }
  assert(guarded, 'an RPC call made while offline throws instead of silently succeeding');

  console.log(`\n\x1b[32m\x1b[1m  DRY RUN PASSED\x1b[0m — the offline half is correct.`);
  console.log(`  Fund a devnet key and run the full pass to close SOL-5b, SOL-7, SOL-8, SOL-12 and emit fixtures.\n`);
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  if (DRY) return dryRun();
  console.log(`\n\x1b[1mVadum Phase 0 — de-risk\x1b[0m   ${RPC_URL}\n`);

  // ── 0 · actors ─────────────────────────────────────────────────────────────
  section('0 · Actors');
  const merchant = await loadOrFundMerchant();
  const payer    = await generateKeyPairSigner();
  const mintKp   = await generateKeyPairSigner();
  log('payer (holds ZERO SOL)', payer.address);
  log('merchant SOL', await solOf(merchant.address));
  assert((await solOf(payer.address)) === 0, 'payer starts with zero SOL');

  // ── 1 · mint + token accounts ──────────────────────────────────────────────
  section('1 · Reference mint (legacy SPL Token, 6 decimals, no extensions — USDC-shaped)');
  const mintRent = await rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize())).send();
  await submit([
    getCreateAccountInstruction({ payer: merchant, newAccount: mintKp, lamports: mintRent,
      space: BigInt(getMintSize()), programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMintInstruction({ mint: mintKp.address, decimals: DECIMALS,
      mintAuthority: merchant.address }),
  ], merchant, [mintKp]);
  const MINT = mintKp.address;
  log('mint', MINT);

  const [payerAta]    = await findAssociatedTokenPda({ owner: payer.address,    mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [merchantAta] = await findAssociatedTokenPda({ owner: merchant.address, mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await submit([
    getCreateAssociatedTokenIdempotentInstruction({ payer: merchant, ata: payerAta, owner: payer.address, mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: merchant, ata: merchantAta, owner: merchant.address, mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    getMintToInstruction({ mint: MINT, token: payerAta, mintAuthority: merchant, amount: MINT_AMOUNT }),
  ], merchant);
  log('payer token balance', (await fetchToken(rpc, payerAta)).data.amount);
  assert((await solOf(payer.address)) === 0, 'payer STILL holds zero SOL after being funded with tokens');

  // ── 2 · derive the nonce address ───────────────────────────────────────────
  section('2 · Nonce address derivation (SOL-5)');
  const nonce0 = await createAddressWithSeed({ baseAddress: payer.address, programAddress: SYSTEM_PROGRAM_ADDRESS, seed: SEED_0 });
  log(`seed "${SEED_0}"`, nonce0);
  const again = await createAddressWithSeed({ baseAddress: payer.address, programAddress: SYSTEM_PROGRAM_ADDRESS, seed: SEED_0 });
  assert(again === nonce0, 'derivation is deterministic — merchant can derive it from payer pubkey + index');

  // ── 3 · sponsored setup ceremony ───────────────────────────────────────────
  section('3 · Sponsored nonce creation (SOL-5b: who must sign?)');
  const nonceRent = await rpc.getMinimumBalanceForRentExemption(BigInt(getNonceSize())).send();
  log('nonce size', `${getNonceSize()} bytes`);
  log('rent-exempt minimum', `${nonceRent} lamports = ${Number(nonceRent) / 1e9} SOL`);

  let bothSigned = null;
  try {
    // base = payer, funder = merchant. Try WITHOUT the payer's signature first.
    await submit([
      getCreateAccountWithSeedInstruction({ payer: merchant, newAccount: nonce0,
        base: payer.address, seed: SEED_0, amount: nonceRent,
        space: BigInt(getNonceSize()), programAddress: SYSTEM_PROGRAM_ADDRESS }),
      getInitializeNonceAccountInstruction({ nonceAccount: nonce0, nonceAuthority: payer.address }),
    ], merchant);
    bothSigned = false;
  } catch {
    // Retry with the payer as baseAccount signer.
    await submit([
      getCreateAccountWithSeedInstruction({ payer: merchant, newAccount: nonce0,
        baseAccount: payer, base: payer.address, seed: SEED_0, amount: nonceRent,
        space: BigInt(getNonceSize()), programAddress: SYSTEM_PROGRAM_ADDRESS }),
      getInitializeNonceAccountInstruction({ nonceAccount: nonce0, nonceAuthority: payer.address }),
    ], merchant, [payer]);
    bothSigned = true;
  }
  record('SOL-5b', bothSigned
    ? 'base != funder ⇒ BOTH must sign. Pool setup is a two-party online ceremony (payer + sponsor).'
    : 'Funder signature alone was sufficient. Pool setup needs only the sponsor online.');
  assert((await solOf(payer.address)) === 0, 'payer paid no rent — the sponsor did');

  // ── 4 · read the nonce ─────────────────────────────────────────────────────
  section('4 · Read the nonce value (SOL-3)');
  const n0 = await fetchNonce(rpc, nonce0);
  log('version / state', `${n0.data.version} / ${n0.data.state}`);
  log('authority', n0.data.authority);
  log('nonce value', n0.data.blockhash);
  assert(n0.data.authority === payer.address, 'nonce authority is the payer');
  const nonceValue = n0.data.blockhash;

  // ── 5-6 · OFFLINE: build, sign, serialise ──────────────────────────────────
  section('5-6 · OFFLINE build + sign (network guard armed)');
  const intent = { merchant: merchant.address, mint: MINT, decimals: DECIMALS,
                   amount: PAY_AMOUNT, tokenProgram: TOKEN_PROGRAM_ADDRESS };
  const flags = 0;   // nonce path, no createATA, spl-token

  const { authPayload, payerSig, payerMessageBytes } = await offline(async () => {
    const tx = await buildMessage({ ...intent, payer: payer.address,
      lifetime: { kind: 'nonce', value: nonceValue }, nonceAccount: nonce0, includeCreateAta: false });
    const signed = await partiallySignTransaction([payer.keyPair], tx);
    const sig = signed.signatures[payer.address];
    return { authPayload: encodeAuth({ flags, payer: payer.address, nonceIndex: 0, nonceValue, signature: sig }),
             payerSig: sig, payerMessageBytes: new Uint8Array(tx.messageBytes) };
  });
  ok('no RPC call escaped the guard');
  log('compiled message', `${payerMessageBytes.length} bytes`);
  log('AUTH payload', `${authPayload.length} bytes`);
  assert(authPayload.length === 132,
    'AUTH payload is 132 bytes = 3 header + 32 payer + 1 index + 32 nonce + 64 signature');

  // ── 7 · OFFLINE merchant verification, then submit ─────────────────────────
  section('7 · Merchant rebuilds from (intent, auth) and verifies OFFLINE');
  const rebuilt = await offline(() => buildMessage({ ...intent, payer: payer.address,
    lifetime: { kind: 'nonce', value: nonceValue }, nonceAccount: nonce0, includeCreateAta: false }));
  const rb = new Uint8Array(rebuilt.messageBytes);
  assert(rb.length === payerMessageBytes.length && rb.every((v, i) => v === payerMessageBytes[i]),
    'rebuilt message is BYTE-IDENTICAL to what the payer signed');
  const sigOk = await offline(() => verifySignature(payer.keyPair.publicKey, payerSig, rebuilt.messageBytes));
  assert(sigOk, 'payer signature verifies offline against the REBUILT message');

  const full = await partiallySignTransaction([merchant.keyPair], { ...rebuilt, signatures: { ...rebuilt.signatures, [payer.address]: payerSig } });
  const wire = getTransactionEncoder().encode(full);
  log('full signed transaction', `${wire.length} bytes`);

  const merchantSolBefore = await solOf(merchant.address);
  await sendAndConfirm(full, { commitment: 'confirmed' });
  const txSig = getSignatureFromTransaction(full);

  // ── ASSERT A ───────────────────────────────────────────────────────────────
  section('ASSERT A · the payment landed');
  const merchantTokens = (await fetchToken(rpc, merchantAta)).data.amount;
  assert(merchantTokens === PAY_AMOUNT, `merchant received ${PAY_AMOUNT} base units`);
  log('signature', txSig);

  // ── ASSERT B ───────────────────────────────────────────────────────────────
  section('ASSERT B · replay is rejected, and costs the merchant nothing');
  const solBeforeReplay = await solOf(merchant.address);
  let replayError = null;
  try {
    await sendAndConfirm(full, { commitment: 'confirmed' });
  } catch (e) { replayError = e; }
  assert(replayError !== null, 'replaying the identical transaction was REJECTED');
  log('rejection', (replayError?.context?.__code ?? replayError?.name ?? String(replayError)).toString().slice(0, 90));
  const solAfterReplay = await solOf(merchant.address);
  assert(Math.abs(solAfterReplay - solBeforeReplay) < 1e-9,
    `merchant balance unchanged across the rejected replay (${solBeforeReplay} → ${solAfterReplay}) — NO FEE CHARGED`);
  record('SOL-7', 'Validation failure (spent nonce) is free: the transaction never lands and no fee is charged.');

  // ── 10 · the advanced nonce ────────────────────────────────────────────────
  section('10 · The nonce advanced (SOL-8)');
  const n1 = await fetchNonce(rpc, nonce0);
  log('old value', nonceValue);
  log('new value', n1.data.blockhash);
  assert(n1.data.blockhash !== nonceValue, 'nonce advanced to a new value');
  const currentBh = (await latestBlockhash()).blockhash;
  assert(n1.data.blockhash !== currentBh, 'new nonce is NOT the current blockhash — it is unpredictable offline');
  record('SOL-8', 'New value is hash(blockhash‖const): unpredictable offline, so NONCE_RETURN recovery is required, not optional.');
  record('SOL-12', 'A payer holding zero SOL signed as nonce authority and token owner, and the transaction landed.');

  // ── 11 · with createATAIdempotent ──────────────────────────────────────────
  section('11 · Second payment WITH createAssociatedTokenAccountIdempotent (D5)');
  const nonce1 = await createAddressWithSeed({ baseAddress: payer.address, programAddress: SYSTEM_PROGRAM_ADDRESS, seed: SEED_1 });
  await submit([
    getCreateAccountWithSeedInstruction({ payer: merchant, newAccount: nonce1,
      ...(bothSigned ? { baseAccount: payer } : {}), base: payer.address, seed: SEED_1,
      amount: nonceRent, space: BigInt(getNonceSize()), programAddress: SYSTEM_PROGRAM_ADDRESS }),
    getInitializeNonceAccountInstruction({ nonceAccount: nonce1, nonceAuthority: payer.address }),
  ], merchant, bothSigned ? [payer] : []);
  const nv1 = (await fetchNonce(rpc, nonce1)).data.blockhash;

  const tx2 = await offline(() => buildMessage({ ...intent, payer: payer.address,
    lifetime: { kind: 'nonce', value: nv1 }, nonceAccount: nonce1, includeCreateAta: true }));
  const tx2Rebuilt = await offline(() => buildMessage({ ...intent, payer: payer.address,
    lifetime: { kind: 'nonce', value: nv1 }, nonceAccount: nonce1, includeCreateAta: true }));
  const a2 = new Uint8Array(tx2.messageBytes), b2 = new Uint8Array(tx2Rebuilt.messageBytes);
  assert(a2.every((v, i) => v === b2[i]) && a2.length === b2.length, 'byte-identical rebuild holds with createATA included');
  log('compiled message', `${a2.length} bytes (vs ${payerMessageBytes.length} without)`);

  const signed2 = await partiallySignTransaction([payer.keyPair], tx2);
  const full2 = await partiallySignTransaction([merchant.keyPair], signed2);
  await sendAndConfirm(full2, { commitment: 'confirmed' });
  ok('second payment landed with createATAIdempotent in the message');
  record('TOK-6', 'createATAIdempotent funded by the merchant works; the payer still spends no SOL.');

  // ── 13 · close and refund ──────────────────────────────────────────────────
  if (!KEEP) {
    section('13 · Close nonce accounts, refund rent');
    const before = await solOf(merchant.address);
    await submit([
      getWithdrawNonceAccountInstruction({ nonceAccount: nonce0, recipientAccount: merchant.address, nonceAuthority: payer, withdrawAmount: nonceRent }),
      getWithdrawNonceAccountInstruction({ nonceAccount: nonce1, recipientAccount: merchant.address, nonceAuthority: payer, withdrawAmount: nonceRent }),
    ], merchant, [payer]);
    const after = await solOf(merchant.address);
    log('rent refunded', `${(after - before).toFixed(9)} SOL`);
    assert(after > before, 'rent was refunded on close');
  }

  // ── fixtures ───────────────────────────────────────────────────────────────
  section('Golden fixtures');
  const fixture = {
    _warning: 'DEVNET TEST KEYS. No value. Never reuse.',
    generatedAgainst: RPC_URL,
    packages: { kit: '8.0.0', system: '0.14.0', token: '0.16.0' },
    cases: [{
      name: 'nonce-dynamic-spl-no-ata',
      input: {
        intent: { merchant: merchant.address, mint: MINT, decimals: DECIMALS,
                  amount: PAY_AMOUNT.toString(), lifetime: { kind: 'nonce' },
                  includeCreateAta: false, tokenProgram: 'spl-token',
                  feePayer: merchant.address, isStatic: false },
        payer: payer.address,
        nonceRef: { index: 0, value: nonceValue },
        amount: PAY_AMOUNT.toString(),
      },
      derived: { nonceAddress: nonce0, sourceAta: payerAta, destinationAta: merchantAta },
      expected: {
        messageBytes: b64.decode(payerMessageBytes),
        messageByteLength: payerMessageBytes.length,
        wireAuth: b64.decode(authPayload),
        wireAuthLength: authPayload.length,
        signature: b64.decode(payerSig),
        fullTransactionLength: wire.length,
      },
    }, {
      name: 'nonce-dynamic-spl-with-ata',
      input: { nonceRef: { index: 1, value: nv1 }, includeCreateAta: true },
      expected: { messageBytes: b64.decode(a2), messageByteLength: a2.length },
    }],
  };
  const fs = await import('node:fs/promises');
  await fs.writeFile(FIXTURES, JSON.stringify(fixture, null, 2));
  log('written', FIXTURES);

  // ── summary ────────────────────────────────────────────────────────────────
  section('Findings for ../02-OPEN-QUESTIONS.md');
  for (const f of findings) console.log(`  ${f.id.padEnd(9)} ${f.answer}`);
  console.log(`\n\x1b[32m\x1b[1m  PHASE 0 PASSED — spec freeze is unblocked.\x1b[0m\n`);
}

main().catch((e) => { console.error(`\n\x1b[31m\x1b[1mPHASE 0 FAILED\x1b[0m\n`, e); process.exit(1); });
