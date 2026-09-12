// @vadum/client — the public API specified in plan/26-SPEC-client-api.md.

export { clusterOf, createRpc, type Cluster, type NonceAccountState, type PaymentLifetime, type RawMintFetch, type VadumRpc } from './rpc.ts';
export { createMintCache, MINT_CACHE_TTL_MS, type MintCache, type MintStaleness } from './mint.ts';
export { precheckNonce, type NonceVerdict } from './nonce-check.ts';
export {
  createPool,
  DEFAULT_POOL_SIZE,
  DEFAULT_SPEND_LIMIT,
  LAMPORTS_PER_SIGNATURE,
  POOL_LOW_WATER_MARK,
  SEND_WINDOW_MS,
  SPEND_LIMIT_WINDOW_MS,
  type Pool,
  type PoolSlot,
  type PoolStatus,
  type SpendAllowance,
} from './pool.ts';
export { createQueue, DEFAULT_QUEUE_LIMITS, paymentId, remainingExposure, type QueuedPayment, type QueueLimits, type Queue } from './queue.ts';
export { submit, type SubmitOutcome } from './submit.ts';
export { createMemoryStore, type KeyValueStore } from './store.ts';
