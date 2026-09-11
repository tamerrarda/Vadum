import { address, createTransactionMessage, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingDurableNonce, setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions, compileTransaction, generateKeyPair,
  getAddressFromPublicKey, createAddressWithSeed, getBase58Decoder, createNoopSigner,
} from '@solana/kit';
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

const b58 = getBase58Decoder();
const r32 = () => b58.decode(crypto.getRandomValues(new Uint8Array(32)));
const PAYER = await getAddressFromPublicKey((await generateKeyPair()).publicKey);
const MERCH = await getAddressFromPublicKey((await generateKeyPair()).publicKey);
const MINT  = address(r32());
const NONCE = await createAddressWithSeed({ baseAddress: PAYER, programAddress: address('11111111111111111111111111111111'), seed: 'vadum-0' });

async function build({ lifetime, authorityAsSigner }) {
  const [src] = await findAssociatedTokenPda({ owner: PAYER, mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [dst] = await findAssociatedTokenPda({ owner: MERCH, mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  let m = createTransactionMessage({ version: 0 });
  m = setTransactionMessageFeePayer(MERCH, m);
  m = lifetime === 'nonce'
    ? setTransactionMessageLifetimeUsingDurableNonce({ nonce: r32(), nonceAccountAddress: NONCE, nonceAuthorityAddress: PAYER }, m)
    : setTransactionMessageLifetimeUsingBlockhash({ blockhash: r32(), lastValidBlockHeight: 1n }, m);
  m = appendTransactionMessageInstructions([ getTransferCheckedInstruction({
        source: src, mint: MINT, destination: dst,
        authority: authorityAsSigner ? createNoopSigner(PAYER) : PAYER,
        amount: 1000n, decimals: 6,
      }, { programAddress: TOKEN_PROGRAM_ADDRESS }) ], m);
  const tx = compileTransaction(m);
  const bytes = new Uint8Array(tx.messageBytes);
  // v0 message: [0x80|version][numRequiredSignatures][numReadonlySigned][numReadonlyUnsigned]
  return { numRequiredSignatures: bytes[1], sigSlots: Object.keys(tx.signatures).length, len: bytes.length,
           payerIsSigner: Object.keys(tx.signatures).includes(PAYER) };
}

for (const lifetime of ['nonce','fresh'])
  for (const asSigner of [false,true]) {
    const r = await build({ lifetime, authorityAsSigner: asSigner });
    console.log(`${lifetime.padEnd(6)} authority=${asSigner?'noopSigner':'Address   '}  requiredSigs=${r.numRequiredSignatures}  payerIsSigner=${String(r.payerIsSigner).padEnd(5)}  msg=${r.len}B`);
  }
