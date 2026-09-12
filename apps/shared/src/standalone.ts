// The standalone-mode gate (C3, T4). Only installed home-screen apps get WebKit's exemption from ITP
// storage deletion, so installation — not a permission prompt — is the real storage control. In a
// browser tab the payer app is read-only: it shows history and guides installation, and it never signs.

import type { LedgerState } from './store.ts';

/** The two platform signals, injected so the gate is testable without a browser (APP-6). */
export interface DisplayEnvironment {
  matchMedia?: (query: string) => { readonly matches: boolean };
  /** iOS Safari's own flag; absent everywhere else. */
  navigatorStandalone?: boolean | undefined;
}

export const isStandalone = (environment: DisplayEnvironment): boolean =>
  environment.navigatorStandalone === true ||
  environment.matchMedia?.('(display-mode: standalone)').matches === true ||
  environment.matchMedia?.('(display-mode: fullscreen)').matches === true ||
  environment.matchMedia?.('(display-mode: minimal-ui)').matches === true;

export const displayEnvironment = (): DisplayEnvironment => ({
  matchMedia: typeof window === 'undefined' ? undefined : (query: string) => window.matchMedia(query),
  navigatorStandalone: (navigator as { standalone?: boolean }).standalone,
});

export type SigningBlock = 'not-installed' | 'ledger-missing' | null;

/**
 * Why offline signing is refused, or null when it is allowed. Both reasons are hard stops: one is a
 * storage guarantee the platform will not give a tab, the other is a ledger that would let the app
 * sign against slots it cannot know are spent.
 */
export function signingBlock(input: { readonly standalone: boolean; readonly ledger: LedgerState }): SigningBlock {
  if (!input.standalone) return 'not-installed';
  return input.ledger === 'ready' ? null : 'ledger-missing';
}

export const canSignOffline = (input: { readonly standalone: boolean; readonly ledger: LedgerState }): boolean => signingBlock(input) === null;
