// The shared vocabulary of @vadum/core (plan/22-SPEC-core-api.md).

import type { Address, Blockhash, Nonce } from '@solana/kit';

/** kit's branded types, re-exported. A nonce value is never typed `Address` (D34). */
export type { Address, Blockhash, Nonce };

export type TokenProgram = 'spl-token' | 'token-2022';

export type Lifetime =
  | { readonly kind: 'nonce' }
  | {
      readonly kind: 'fresh';
      readonly blockhash: Blockhash;
      /** Required by kit, never serialised, and without effect on `messageBytes`. The payer passes 0n. */
      readonly lastValidBlockHeight: bigint;
    };

export interface NonceRef {
  /** 0..255, the pool slot. */
  readonly index: number;
  /** The value currently stored in the nonce account. */
  readonly value: Nonce;
}

export interface Intent {
  readonly merchant: Address;
  readonly mint: Address;
  readonly decimals: number;
  /** Null in static mode, where the payer supplies it. */
  readonly amount: bigint | null;
  readonly lifetime: Lifetime;
  readonly includeCreateAta: boolean;
  readonly tokenProgram: TokenProgram;
  /** Fee payer and ATA funder (D19). Equals `merchant` in v1, and must not equal the payer (D30). */
  readonly feePayer: Address;
  readonly isStatic: boolean;
}

export interface Auth {
  readonly payer: Address;
  /** Null on the fresh path. */
  readonly nonceRef: NonceRef | null;
  /** Set in static mode only. */
  readonly amount: bigint | null;
  /** 64 bytes. */
  readonly signature: Uint8Array;
}

/**
 * Everything needed to compile the canonical message; both sides construct it identically.
 * `intent.isStatic` must not influence the compiled bytes.
 */
export interface CanonicalInput {
  readonly intent: Intent;
  readonly payer: Address;
  readonly nonceRef: NonceRef | null;
  /** `intent.amount` in dynamic mode, `auth.amount` in static mode. */
  readonly amount: bigint;
}

/** T0: waits for confirmation. T1: hands over after the online pre-check. T2: offline, queued. */
export type PaymentTier = 'T0' | 'T1' | 'T2';

export interface CompiledMessage {
  readonly messageBytes: Uint8Array;
}

export interface VerifiedPayment {
  readonly input: CanonicalInput;
  readonly messageBytes: Uint8Array;
  readonly auth: Auth;
}

export type MintBlocker = 'transfer-hook-active' | 'transfer-fee-nonzero' | 'default-account-state-frozen';

export type MintWarning =
  | 'permanent-delegate'
  | 'pausable'
  | 'confidential-transfer'
  | 'freeze-authority'
  | 'mint-close-authority'
  | 'unknown-extension';

export interface MintRecord {
  readonly mint: Address;
  readonly tokenProgram: TokenProgram;
  readonly decimals: number;
  readonly compatible: boolean;
  readonly blockers: readonly MintBlocker[];
  readonly warnings: readonly MintWarning[];
  /** True when a transfer-relevant authority can change the verdict without warning (D22). */
  readonly mutable: boolean;
  /** Epoch ms of the check, supplied by the caller; core reads no clock. */
  readonly checkedAt: number;
}

/** The jsonParsed `parsed.info` projection of a mint account, as client/mint.ts produces it. */
export interface RawMintData {
  readonly mint: Address;
  readonly tokenProgram: TokenProgram;
  readonly decimals: number;
  readonly freezeAuthority: Address | null;
  readonly extensions: readonly RawMintExtension[];
}

export interface RawMintExtension {
  readonly extension: string;
  readonly state: Record<string, unknown>;
}
