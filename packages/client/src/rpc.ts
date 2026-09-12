// Where the network lives (26-SPEC). v1 is devnet only (D16): no compute-budget instruction is
// expressible in this design, so it cannot bid for blockspace on a congested mainnet.

import {
  appendTransactionMessageInstructions,
  createSignerFromKeyPair,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  sendAndConfirmDurableNonceTransactionFactory,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Blockhash,
  type Instruction,
  type Nonce,
  type Signature,
  type Transaction,
} from '@solana/kit';
import { fetchMaybeNonce, getNonceSize } from '@solana-program/system';
import { fetchMaybeToken } from '@solana-program/token';
import { VadumError, type RawMintData, type TokenProgram } from '@vadum/core';

export interface RawMintFetch {
  /** Fetched with encoding 'jsonParsed'; a base64 fetch produces a shape core.evaluateMint rejects. */
  readonly raw: RawMintData;
  readonly fetchedAt: number;
}

export type NonceAccountState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'uninitialized' }
  | {
      readonly kind: 'initialized';
      readonly authority: Address;
      readonly value: Nonce;
      readonly lamports: bigint;
    };

export type Cluster = 'devnet' | 'mainnet-beta' | 'testnet' | 'localnet';

export interface VadumRpc {
  readonly endpoint: string;
  readonly cluster: Cluster;
  /** Never hardcode rent (D7): it is falling on the live clusters (D39). */
  getNonceRentExemption(): Promise<bigint>;
  /** `0` gives a plain wallet's rent-exempt floor (D38). */
  getRentExemption(dataLength: number): Promise<bigint>;
  getMintAccount(mint: Address): Promise<RawMintFetch>;
  getNonceAccount(address: Address): Promise<NonceAccountState>;
  getTokenBalance(ata: Address): Promise<bigint | null>;
  isAtaFrozen(ata: Address): Promise<boolean | null>;
  getBalance(address: Address): Promise<bigint>;
  /**
   * Did the cluster process this signature? The only authority on whether a failed payment charged
   * the merchant: a transaction the cluster executed paid its fee even though it failed, and one the
   * cluster never saw paid nothing (SOL-7). An RPC's error prose is not evidence of either.
   */
  getSignatureOutcome(signature: string): Promise<SignatureOutcome>;

  // Beyond 26-SPEC's read surface. Pool setup, pool close and submission have to send something, and
  // the spec gives no other seam; see plan/questions/stream-b.md B-1.

  /**
   * Signs a blockhash-lifetime setup transaction with `feePayerKey` and confirms it. Any other
   * required signature comes from a signer embedded in an instruction, which is how kit collects
   * them — pool setup deliberately needs exactly one (D26).
   */
  sendSetup(instructions: readonly Instruction[], feePayerKey: CryptoKeyPair): Promise<string>;
  /**
   * Sends an already-signed payment and confirms it with the confirmer that matches its lifetime:
   * the durable-nonce factory on the nonce path, never the blockhash one (SOL-15).
   */
  sendPayment(wireTransaction: Uint8Array, lifetime: PaymentLifetime, options?: SendOptions): Promise<string>;
}

/** Whether the cluster processed a signature, and if so how it ended. */
export type SignatureOutcome = 'landed-ok' | 'landed-failed' | 'absent';

export interface SendOptions {
  /**
   * Skip the RPC's preflight simulation. **Not for product code.** Preflight rejects a payment that
   * would fail at execution, which is what keeps a merchant from paying a fee for nothing — so
   * skipping it exists only to observe the landed-and-charged failure deliberately, the way
   * `tools/devnet-b` does when it proves that class is classified correctly (SOL-7, D21).
   */
  readonly skipPreflight?: boolean;
}

/**
 * What kit's confirmers need and a decoded transaction cannot carry: wire bytes are a message plus
 * signatures, with no lifetime object attached. The caller already knows the lifetime — it built the
 * message — so it passes it in rather than having the RPC layer re-derive it from the instructions.
 */
export type PaymentLifetime =
  | { readonly kind: 'nonce'; readonly nonce: Nonce; readonly nonceAccountAddress: Address; readonly nonceAuthorityAddress: Address }
  | { readonly kind: 'fresh'; readonly blockhash: Blockhash; readonly lastValidBlockHeight: bigint };

const CONFIRM_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;
const RETRY_ATTEMPTS = 5;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryable = (error: unknown): boolean => {
  const status = (error as { context?: { statusCode?: unknown } }).context?.statusCode;
  if (typeof status === 'number') return RETRYABLE_STATUS.has(status);
  const message = error instanceof Error ? error.message : String(error);
  return /Too Many Requests|rate limit|fetch failed|ETIMEDOUT|ECONNRESET|socket hang up/i.test(message);
};

/** SOLANA_ERROR__RPC_SUBSCRIPTIONS__CHANNEL_FAILED_TO_CONNECT, or anything else that names the socket. */
const isSubscriptionFailure = (error: unknown): boolean => {
  if ((error as { context?: { __code?: unknown } }).context?.__code === 8190004) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /WebSocket|subscription/i.test(message);
};

/**
 * Public endpoints rate-limit hard — the first devnet run of `tools/devnet-b` died on a 429 — and a
 * payments client that gives up on one is unusable. Only transport failures are retried; a
 * VadumError, or anything the chain decided, is passed straight through.
 */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= RETRY_ATTEMPTS || !isRetryable(error)) throw error;
      await sleep(200 * 2 ** attempt + Math.floor(Math.random() * 100));
    }
  }
}

const CLUSTER_BY_HOST: readonly (readonly [RegExp, Cluster])[] = [
  [/devnet/, 'devnet'],
  [/testnet/, 'testnet'],
  [/localhost|127\.0\.0\.1/, 'localnet'],
];

export const clusterOf = (endpoint: string): Cluster => CLUSTER_BY_HOST.find(([pattern]) => pattern.test(endpoint))?.[1] ?? 'mainnet-beta';

const TOKEN_PROGRAM_BY_OWNER: Readonly<Record<string, TokenProgram>> = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'spl-token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'token-2022',
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `parsed.info` projection core.evaluateMint is specified against (22-SPEC, RawMintData). */
function projectMint(mint: Address, owner: Address, data: unknown): RawMintData {
  const tokenProgram = TOKEN_PROGRAM_BY_OWNER[owner];
  if (tokenProgram === undefined) throw new VadumError('MINT_INCOMPATIBLE', { blockers: [], reason: 'the account is not owned by a token program', owner });
  const parsed = isRecord(data) ? data.parsed : undefined;
  const info = isRecord(parsed) ? parsed.info : undefined;
  if (!isRecord(info) || typeof info.decimals !== 'number') {
    throw new VadumError('MINT_INCOMPATIBLE', { blockers: [], reason: 'the account was not fetched with encoding jsonParsed', mint });
  }
  const extensions = Array.isArray(info.extensions) ? info.extensions : [];
  return {
    mint,
    tokenProgram,
    decimals: info.decimals,
    freezeAuthority: (info.freezeAuthority as Address | null | undefined) ?? null,
    extensions: extensions.map((entry) => ({
      extension: isRecord(entry) && typeof entry.extension === 'string' ? entry.extension : 'unknown',
      state: isRecord(entry) && isRecord(entry.state) ? entry.state : {},
    })),
  };
}

export function createRpc(endpoint: string): VadumRpc {
  const client = createSolanaRpc(endpoint);
  const subscriptions = createSolanaRpcSubscriptions(endpoint.replace(/^http/, 'ws'));
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc: client, rpcSubscriptions: subscriptions });
  const sendAndConfirmDurableNonce = sendAndConfirmDurableNonceTransactionFactory({ rpc: client, rpcSubscriptions: subscriptions });
  const commitment = 'confirmed' as const;

  /** Broadcast over HTTP and confirm by polling. Used for setup, and when no socket can be opened. */
  const broadcastAndPoll = async (transaction: Transaction, options: SendOptions = {}): Promise<string> => {
    const signature = getSignatureFromTransaction(transaction as Parameters<typeof getSignatureFromTransaction>[0]);
    const wire = getBase64EncodedWireTransaction(transaction);
    await withRetry(() =>
      client.sendTransaction(wire, { encoding: 'base64', preflightCommitment: commitment, skipPreflight: options.skipPreflight === true }).send(),
    );

    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = (await withRetry(() => client.getSignatureStatuses([signature]).send())).value[0];
      if (status?.err != null) throw new VadumError('SUBMIT_EXECUTION_FAILED', { signature, err: status.err });
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new VadumError('SUBMIT_RPC_UNAVAILABLE', { reason: 'the transaction did not confirm in time', signature });
  };

  return {
    endpoint,
    cluster: clusterOf(endpoint),

    async getNonceRentExemption() {
      return withRetry(() => client.getMinimumBalanceForRentExemption(BigInt(getNonceSize())).send());
    },

    async getRentExemption(dataLength) {
      return withRetry(() => client.getMinimumBalanceForRentExemption(BigInt(dataLength)).send());
    },

    async getMintAccount(mint) {
      const fetchedAt = Date.now(); // the clock lives here, never in core (22-SPEC invariant 2)
      const { value } = await withRetry(() => client.getAccountInfo(mint, { encoding: 'jsonParsed', commitment }).send());
      if (value === null) throw new VadumError('MINT_INCOMPATIBLE', { blockers: [], reason: 'the mint account does not exist', mint });
      return { raw: projectMint(mint, value.owner, value.data), fetchedAt };
    },

    async getNonceAccount(address) {
      const account = await withRetry(() => fetchMaybeNonce(client, address, { commitment }));
      if (!account.exists) return { kind: 'absent' };
      if (Number(account.data.state) !== 1) return { kind: 'uninitialized' };
      return {
        kind: 'initialized',
        authority: account.data.authority,
        // D34: the one place a stored nonce typed as Address becomes a Nonce.
        value: account.data.blockhash as string as Nonce,
        lamports: account.lamports,
      };
    },

    async getTokenBalance(ata) {
      const account = await withRetry(() => fetchMaybeToken(client, ata, { commitment }));
      return account.exists ? account.data.amount : null;
    },

    async isAtaFrozen(ata) {
      const account = await withRetry(() => fetchMaybeToken(client, ata, { commitment }));
      return account.exists ? Number(account.data.state) === 2 : null;
    },

    async getBalance(address) {
      return (await withRetry(() => client.getBalance(address, { commitment }).send())).value;
    },

    async sendSetup(instructions, feePayerKey) {
      const feePayer = await createSignerFromKeyPair(feePayerKey);
      const { value: blockhash } = await withRetry(() => client.getLatestBlockhash({ commitment }).send());
      const message = appendTransactionMessageInstructions(
        instructions,
        setTransactionMessageLifetimeUsingBlockhash(blockhash, setTransactionMessageFeePayerSigner(feePayer, createTransactionMessage({ version: 0 }))),
      );
      const signed = await signTransactionMessageWithSigners(message as unknown as Parameters<typeof signTransactionMessageWithSigners>[0]);
      // Setup is confirmed by polling: a public endpoint rate-limits subscriptions hard, and a setup
      // transaction carries a blockhash lifetime, so SOL-15's rule about confirmers does not apply.
      return broadcastAndPoll(signed as unknown as Transaction);
    },

    async getSignatureOutcome(signature) {
      const status = (await withRetry(() => client.getSignatureStatuses([signature as Signature], { searchTransactionHistory: true }).send())).value[0];
      if (status == null) return 'absent';
      return status.err == null ? 'landed-ok' : 'landed-failed';
    },

    async sendPayment(wireTransaction, lifetime, options) {
      const transaction = getTransactionDecoder().decode(wireTransaction);
      // Skipping preflight means kit's confirmers cannot be used: they preflight by construction.
      if (options?.skipPreflight === true) return broadcastAndPoll(transaction, options);
      const { kind, ...lifetimeConstraint } = lifetime;
      // kit's confirmers read the lifetime off the transaction object, and a decoded one has none.
      const sendable = { ...transaction, lifetimeConstraint };
      try {
        // SOL-15: the blockhash confirmer demands lastValidBlockHeight, which a durable-nonce
        // transaction does not have, and fails immediately with BLOCK_HEIGHT_EXCEEDED.
        if (kind === 'nonce') {
          await sendAndConfirmDurableNonce(sendable as unknown as Parameters<typeof sendAndConfirmDurableNonce>[0], { commitment });
        } else {
          await sendAndConfirm(sendable as unknown as Parameters<typeof sendAndConfirm>[0], { commitment });
        }
        return getSignatureFromTransaction(transaction);
      } catch (error) {
        // Two transport failures, one answer. The confirmation channel may never have opened, or the
        // endpoint may have throttled the send (429) — kit's confirmer retries neither. The
        // transaction is fully signed, so its signature is fixed and broadcasting it again over HTTP
        // is either the first send or a no-op; `broadcastAndPoll` then retries with backoff. A payment
        // the merchant cannot confirm is a payment the merchant cannot hand over on.
        if (!isSubscriptionFailure(error) && !isRetryable(error)) throw error;
        return broadcastAndPoll(transaction);
      }
    },
  };
}
