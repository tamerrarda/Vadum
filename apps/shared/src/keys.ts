// C2 · Key management. Ed25519 as a non-extractable CryptoKey in IndexedDB, with the polyfill loaded
// only where native WebCrypto Ed25519 is missing (D9).
//
// Honest limits, which the README repeats: non-extractable is not a secure element, and on the
// polyfill path it is not even non-extractable — the key lives in the JS heap (APP-2).

import { getAddressFromPublicKey, type Address } from '@solana/kit';
import type { KeyValueStore } from '@vadum/client';

export type SigningPath = 'native' | 'polyfill';

const KEY_STORE_KEY = 'identity:keypair';

/** Does this browser sign Ed25519 itself? Chrome has since 137; the polyfill is for the long tail. */
export async function detectSigningPath(): Promise<SigningPath> {
  try {
    const pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
    return 'keyPair' in (pair as object) || 'privateKey' in (pair as object) ? 'native' : 'polyfill';
  } catch {
    return 'polyfill';
  }
}

/** Installs the polyfill only if needed, and reports which path the app is actually on. */
export async function ensureSigningPath(): Promise<SigningPath> {
  const path = await detectSigningPath();
  if (path === 'native') return 'native';
  const { install } = await import('@solana/webcrypto-ed25519-polyfill');
  install();
  return 'polyfill';
}

export interface Identity {
  readonly keyPair: CryptoKeyPair;
  readonly address: Address;
  /** Which path signed it, so the app can state the honest limit rather than implying a guarantee. */
  readonly signingPath: SigningPath;
}

/**
 * Loads the device identity, generating it on first run. The private key is generated
 * `extractable: false` and stored as a `CryptoKey`, so it never becomes readable bytes — on the
 * native path. There is deliberately no export and no backup: a seed phrase would reopen exactly the
 * exposure non-extractability closes (APP-2).
 */
export async function loadOrCreateIdentity(store: KeyValueStore): Promise<Identity> {
  const signingPath = await ensureSigningPath();
  const stored = await store.get<CryptoKeyPair>(KEY_STORE_KEY);
  if (stored?.publicKey !== undefined) {
    return { keyPair: stored, address: await getAddressFromPublicKey(stored.publicKey), signingPath };
  }
  const keyPair = (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])) as CryptoKeyPair;
  await store.set(KEY_STORE_KEY, keyPair);
  return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey), signingPath };
}

/** True once an identity exists on this device. */
export const hasIdentity = async (store: KeyValueStore): Promise<boolean> => (await store.get<CryptoKeyPair>(KEY_STORE_KEY)) !== undefined;
