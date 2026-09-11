import {
  address, createTransactionMessage, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingDurableNonce, setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions, compileTransaction,
  generateKeyPair, getAddressFromPublicKey, createAddressWithSeed,
  getBase58Decoder, getTransactionEncoder, partiallySignTransaction,
  verifySignature, getBase64Decoder,
} from '@solana/kit';
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

const b58 = getBase58Decoder();
const rand32 = () => b58.decode(crypto.getRandomValues(new Uint8Array(32)));

// ---- actors -------------------------------------------------------------
const payerKP    = await generateKeyPair();
const merchantKP = await generateKeyPair();
const PAYER    = await getAddressFromPublicKey(payerKP.publicKey);
const MERCHANT = await getAddressFromPublicKey(merchantKP.publicKey);
const MINT     = address(rand32());
const NONCE_VALUE = rand32();                       // opaque 32B, base58
const NONCE_ACCT  = await createAddressWithSeed({ baseAddress: PAYER, programAddress: address('11111111111111111111111111111111'), seed: 'vadum-0' });

// ---- THE canonical builder: identical code path on both sides -----------
async function buildMessage({ merchant, mint, amount, decimals, payer, nonceAccount, nonceValue }) {
  const [src] = await findAssociatedTokenPda({ owner: payer,    mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [dst] = await findAssociatedTokenPda({ owner: merchant, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  let m = createTransactionMessage({ version: 0 });
  m = setTransactionMessageFeePayer(merchant, m);
  m = setTransactionMessageLifetimeUsingDurableNonce(
        { nonce: nonceValue, nonceAccountAddress: nonceAccount, nonceAuthorityAddress: payer }, m);
  m = appendTransactionMessageInstructions([
        getTransferCheckedInstruction({
          source: src, mint, destination: dst,
          authority: payer,           // payer signs as token owner
          amount, decimals,
        }, { programAddress: TOKEN_PROGRAM_ADDRESS }),
      ], m);
  return compileTransaction(m);
}

const intent = { merchant: MERCHANT, mint: MINT, amount: 2_500_000n, decimals: 6 };
const nonceRef = { payer: PAYER, nonceAccount: NONCE_ACCT, nonceValue: NONCE_VALUE };

// ---- PAYER side (offline) ----------------------------------------------
const txPayer = await buildMessage({ ...intent, ...nonceRef });
const signed  = await partiallySignTransaction([payerKP], txPayer);
const sigBytes = signed.signatures[PAYER];

// ---- MERCHANT side: rebuilds from intent + 131-byte auth payload only ---
const txMerchant = await buildMessage({ ...intent, ...nonceRef });

const a = new Uint8Array(txPayer.messageBytes);
const b = new Uint8Array(txMerchant.messageBytes);
const identical = a.length === b.length && a.every((v,i)=>v===b[i]);

console.log('message bytes (payer)   :', a.length);
console.log('message bytes (merchant):', b.length);
console.log('BYTE-IDENTICAL REBUILD  :', identical ? 'YES ✅' : 'NO ❌');

const ok = await verifySignature(payerKP.publicKey, sigBytes, txMerchant.messageBytes);
console.log('offline sig verify      :', ok ? 'VALID ✅' : 'INVALID ❌');

// ---- sizes --------------------------------------------------------------
const full = await partiallySignTransaction([merchantKP], signed);
const wire = getTransactionEncoder().encode(full);
console.log('\nfull signed tx on wire  :', wire.length, 'bytes');
console.log('accounts in message     :', txPayer.messageBytes[3] !== undefined ? 'see below' : '');

// what actually has to cross the air gap
console.log('\n--- AIR-GAP PAYLOAD ---');
console.log('QR#2 nonce path  = 1+1+32+1+32+64 =', 1+1+32+1+32+64, 'bytes');
console.log('QR#2 fresh path  = 1+1+32+64       =', 1+1+32+64, 'bytes');
console.log('vs. full tx                        =', wire.length, 'bytes  → saving', (100*(1-131/wire.length)).toFixed(1)+'%');
