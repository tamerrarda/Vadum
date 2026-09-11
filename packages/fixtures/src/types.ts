// JSON shapes of fixtures.json (plan/24-SPEC-fixtures.md). Conventions: addresses, nonce values and
// blockhashes are base58 strings; byte arrays are base64; u64 amounts are decimal strings; every
// base45 string is stored verbatim, spaces included.

export type Base58 = string;
export type Base64 = string;
export type DecimalString = string;
export type TokenProgramName = 'spl-token' | 'token-2022';

export type LifetimeJson =
  | { readonly kind: 'nonce' }
  | { readonly kind: 'fresh'; readonly blockhash: Base58; readonly lastValidBlockHeight: DecimalString };

export interface IntentJson {
  readonly merchant: Base58;
  readonly mint: Base58;
  readonly decimals: number;
  readonly amount: DecimalString | null;
  readonly lifetime: LifetimeJson;
  readonly includeCreateAta: boolean;
  readonly tokenProgram: TokenProgramName;
  readonly feePayer: Base58;
  readonly isStatic: boolean;
}

export interface NonceRefJson {
  readonly index: number;
  readonly value: Base58;
}

export interface AuthJson {
  readonly payer: Base58;
  readonly nonceRef: NonceRefJson | null;
  readonly amount: DecimalString | null;
  readonly signature: Base64;
}

export interface CanonicalInputJson {
  readonly intent: IntentJson;
  readonly payer: Base58;
  readonly nonceRef: NonceRefJson | null;
  readonly amount: DecimalString;
}

export interface VerifiedPaymentJson {
  readonly input: CanonicalInputJson;
  readonly messageBytes: Base64;
  readonly auth: AuthJson;
}

export interface MintRecordJson {
  readonly mint: Base58;
  readonly tokenProgram: TokenProgramName;
  readonly decimals: number;
  readonly compatible: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly mutable: boolean;
  readonly checkedAt: number;
}

export interface QrVersions {
  readonly M: number;
  readonly Q: number;
}

export interface PositiveCase {
  readonly name: string;
  readonly input: CanonicalInputJson;
  /** The payer's side of the payment, as `core.signAsPayer` returns it and `wire.decodeAuth` reads it. */
  readonly auth: AuthJson;
  /** Passed to `core.verifyAuth`; set in static cases only. */
  readonly expectedAmount: DecimalString | null;
  readonly derived: {
    readonly nonceAddress: Base58 | null;
    readonly sourceAta: Base58;
    readonly destinationAta: Base58;
  };
  readonly expected: {
    readonly messageVersion: 0;
    readonly messageBytes: Base64;
    readonly messageByteLength: number;
    readonly wireFlags: number;
    readonly wireIntent: Base64;
    readonly wireIntentBase45: string;
    readonly wireAuth: Base64;
    readonly wireAuthBase45: string;
    readonly wireAuthBase45Length: number;
    readonly qrVersions: { readonly intent: QrVersions; readonly auth: QrVersions };
    readonly signatureValid: true;
    readonly fullTransactionLength: number;
  };
}

export interface NonceReturnCase {
  readonly name: string;
  /** Whose fee-payer key signed. */
  readonly merchant: Base58;
  readonly statement: {
    readonly payer: Base58;
    readonly nonceIndex: number;
    readonly spentAgainstValue: Base58;
    readonly newNonceValue: Base58;
  };
  readonly expected: {
    readonly signingBytes: Base64;
    readonly wireNonceReturn: Base64;
    readonly wireNonceReturnBase45: string;
    readonly qrVersions: QrVersions;
    readonly signatureValid: true;
  };
}

export type NegativeTarget =
  | 'wire.peekPayloadType'
  | 'wire.decodeIntent'
  | 'wire.decodeStaticIntent'
  | 'wire.decodeAuth'
  | 'wire.decodeNonceReturn'
  | 'wire.fromBase45'
  | 'wire.fromBase45 → wire.decodeAuth'
  | 'core.verifyAuth'
  | 'core.signAsPayer'
  | 'core.evaluateMint → core.assertMintCompatible'
  | 'core.verifyNonceReturn'
  | 'client.queue.accept';

export interface NegativeCase {
  readonly name: string;
  /** One entry point, a pipeline written `a → b`, or several entry points that must each throw. */
  readonly target: NegativeTarget | readonly NegativeTarget[];
  /** Keyed by entry point when `target` is an array. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly expectedError: string;
  /** Asserted as a subset of `VadumError.detail`. */
  readonly expectedDetail?: Readonly<Record<string, unknown>>;
  /** How the case was built. */
  readonly note: string;
}

export interface FixtureFile {
  readonly _warning: string;
  readonly generator: string;
  readonly packages: Readonly<Record<string, string>>;
  readonly mints: {
    readonly spl: { readonly address: Base58; readonly description: string };
    readonly t22: { readonly address: Base58; readonly description: string };
  };
  /** The mint compatibility cache every positive case decodes against. */
  readonly mintRecords: readonly MintRecordJson[];
  readonly cases: readonly PositiveCase[];
  readonly nonceReturn: readonly NonceReturnCase[];
  readonly negative: readonly NegativeCase[];
}
