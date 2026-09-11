// DEVNET TEST KEYS. Zero value. Deterministic on purpose. Never reuse anywhere real.
//
// Seeds and pinned values for the fixture generator (plan/24-SPEC-fixtures.md). Every key below is
// public by construction and controls nothing of value on any cluster.

import type { Blockhash, Nonce } from '@solana/kit';

export const PAYER_SEED = new Uint8Array(32).fill(0x01);
export const MERCHANT_SEED = new Uint8Array(32).fill(0x02);
/** Legacy SPL Token test mint (D24). */
export const MINT_SEED = new Uint8Array(32).fill(0x03);
/** D28: the other payer. */
export const PAYER2_SEED = new Uint8Array(32).fill(0x04);
/** Token-2022 test mint, null transfer hook, zero transfer fee. */
export const MINT_T22_SEED = new Uint8Array(32).fill(0x05);

// Opaque 32-byte values, each base58(sha256(label)) for the label in its comment. Written out
// literally so the fixtures never depend on re-deriving them.

/** sha256("vadum-fixtures:nonce-value") — the value a slot is spent against. */
export const NONCE_VALUE = '2zezgkijhUjMoaRvfuDxTZ5bWjMjESKMnoPa3bBDssee' as Nonce;
/** sha256("vadum-fixtures:nonce-value-next") — the value after settlement, carried by NONCE_RETURN. */
export const NONCE_VALUE_NEXT = '4EUcifGtcxuNK2pVZCHjjGb6GEGW2WzQRsXcTpLfrx7Y' as Nonce;
/** sha256("vadum-fixtures:nonce-value-prev") — an earlier value of the same slot (D28 negative). */
export const NONCE_VALUE_PREV = 'wTxqYCnwhn49auE1Tzv5JabkGtUuNDdEekstWXhxmzx' as Nonce;
/** sha256("vadum-fixtures:blockhash") — the fresh-path case. */
export const BLOCKHASH = 'FkTqdP8BNfPGtH1NXMfnk2VHxu4PTWDkZ1ASoeHyNcwk' as Blockhash;
