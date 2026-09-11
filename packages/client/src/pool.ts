// The nonce pool, and the single owner of payer slot state (D32). No sponsor in v1 (D26): the payer
// funds its own refundable rent, and because from == base == payer the setup needs one signature.
//
// `reserveSlot` persists BEFORE it resolves. If signing then fails the slot stays spent, and
// `reconcile` releases it after the send window — the fail-safe ordering.

import { createSignerFromKeyPair, getAddressFromPublicKey, type Address, type Instruction, type Nonce } from '@solana/kit';
import {
  getCreateAccountWithSeedInstruction,
  getInitializeNonceAccountInstruction,
  getNonceSize,
  getWithdrawNonceAccountInstruction,
  SYSTEM_PROGRAM_ADDRESS,
} from '@solana-program/system';
import { deriveNonceAddress, nonceSeed, VadumError, verifyNonceReturn } from '@vadum/core';
import type { NonceReturnPayload } from '@vadum/wire';
import type { VadumRpc } from './rpc.ts';
import type { KeyValueStore } from './store.ts';

/** Phase 0, 2026-09-11: the fee is per signature, and pool setup carries exactly one (D26). */
export const LAMPORTS_PER_SIGNATURE = 5_000n;
/** The product send window (D23). It also gates the payer's reconciliation. */
export const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Default pool size N (D23). Not a security parameter — a usability and cost one. */
export const DEFAULT_POOL_SIZE = 5;
/** Prompt the payer to reconnect at or below this many unspent slots (D23). */
export const POOL_LOW_WATER_MARK = 2;

export interface PoolSlot {
  readonly index: number;
  readonly address: Address;
  /** null when not yet read. NOT unique across slots: slots initialised in one transaction share it. */
  readonly value: Nonce | null;
  readonly state: 'unspent' | 'spent' | 'unknown';
  /** Set when state === 'spent'. Needed by applyNonceReturn (rule 12, D28) and by reconciliation. */
  readonly spentAgainst?: { readonly value: Nonce; readonly merchant: Address; readonly at: number };
}

export interface PoolStatus {
  readonly payer: Address;
  readonly size: number;
  readonly slots: readonly PoolSlot[];
  readonly unspentCount: number;
  readonly belowLowWaterMark: boolean;
  readonly epoch: string;
}

export interface Pool {
  /**
   * What the payer's wallet needs before `create` (D38), each part read at call time (D7).
   *
   * `walletMinimum` is the rent-exempt floor a wallet that does not end at zero must keep. A wallet
   * left at exactly that floor cannot pay another fee — not even the one `close` needs — so a payer
   * app that intends to close the pool later funds `walletMinimum + fee`.
   */
  estimateSetupCost(size: number): Promise<{ readonly nonceRent: bigint; readonly fee: bigint; readonly walletMinimum: bigint }>;
  /** Online. One signer; the payer pays the fee and the rent (D26). Throws NONCE_POOL_UNDERFUNDED,
   *  sending nothing, if the wallet cannot end the transaction at zero or rent-exempt (D38). */
  create(size: number, payerKey: CryptoKeyPair): Promise<PoolStatus>;
  /** Offline. Lowest unspent slot with a known value, marked spent and PERSISTED before resolving. */
  reserveSlot(merchant: Address, now: number): Promise<{ readonly index: number; readonly value: Nonce }>;
  /** Offline. Receive rule 12: the ledger record, then core.verifyNonceReturn, then the re-arm (D28). */
  applyNonceReturn(payload: NonceReturnPayload): Promise<PoolStatus>;
  /** Online. Re-reads every slot's on-chain value. Never changes slot state. */
  refresh(): Promise<PoolStatus>;
  /** Online. Withdraws every slot; rent returns to the payer. */
  close(payerKey: CryptoKeyPair): Promise<{ refundedLamports: bigint }>;
  /** Online. The NONCE_DESYNC procedure over every slot recorded as spent. */
  reconcile(now: number): Promise<{ readonly released: readonly number[]; readonly settled: readonly number[]; readonly stillPending: readonly number[] }>;
  status(): PoolStatus;
  /** Hydrates from the store. `status` is synchronous, so something has to read first. */
  load(): Promise<PoolStatus>;
}

interface PoolState {
  readonly payer: Address;
  readonly size: number;
  readonly epoch: string;
  readonly slots: readonly PoolSlot[];
}

const statusOf = (state: PoolState): PoolStatus => {
  const unspentCount = state.slots.filter((slot) => slot.state === 'unspent').length;
  return { payer: state.payer, size: state.size, slots: state.slots, unspentCount, belowLowWaterMark: unspentCount <= POOL_LOW_WATER_MARK, epoch: state.epoch };
};

const withSlot = (state: PoolState, slot: PoolSlot): PoolState => ({
  ...state,
  slots: state.slots.map((candidate) => (candidate.index === slot.index ? slot : candidate)),
});

/** Drops `spentAgainst` rather than carrying a stale record on an unspent slot. */
const rearmed = (slot: PoolSlot, value: Nonce | null, state: PoolSlot['state'] = 'unspent'): PoolSlot => ({
  index: slot.index,
  address: slot.address,
  value,
  state,
});

export function createPool(rpc: VadumRpc, payer: Address, store: KeyValueStore, options?: { readonly sendWindowMs?: number }): Pool {
  const key = `pool:${payer}`;
  const sendWindowMs = options?.sendWindowMs ?? SEND_WINDOW_MS;
  let current: PoolState | undefined;

  const persist = async (state: PoolState): Promise<PoolStatus> => {
    current = state;
    await store.set(key, state);
    return statusOf(state);
  };

  const loaded = async (): Promise<PoolState> => {
    current ??= await store.get<PoolState>(key);
    if (current === undefined) throw new VadumError('NONCE_LEDGER_MISSING', { payer });
    return current;
  };

  const assertPayerKey = async (payerKey: CryptoKeyPair): Promise<void> => {
    const address = await getAddressFromPublicKey(payerKey.publicKey);
    if (address !== payer) throw new VadumError('CANON_ACCOUNT_MISMATCH', { reason: 'the key is not this pool’s payer', payer, key: address });
  };

  const readValue = async (slot: PoolSlot): Promise<{ readonly value: Nonce | null; readonly lamports: bigint }> => {
    const state = await rpc.getNonceAccount(slot.address);
    return state.kind === 'initialized' ? { value: state.value, lamports: state.lamports } : { value: null, lamports: 0n };
  };

  return {
    async estimateSetupCost(size) {
      const [nonceRent, walletMinimum] = await Promise.all([rpc.getNonceRentExemption(), rpc.getRentExemption(0)]);
      return { nonceRent: nonceRent * BigInt(size), fee: LAMPORTS_PER_SIGNATURE, walletMinimum };
    },

    async create(size, payerKey) {
      if (!Number.isInteger(size) || size < 1 || size > 256) throw new VadumError('NONCE_INDEX_OUT_OF_RANGE', { index: size - 1 });
      await assertPayerKey(payerKey);
      const { nonceRent, fee, walletMinimum } = await this.estimateSetupCost(size);
      const balance = await rpc.getBalance(payer);
      // D38: a system account must end every transaction at zero or rent-exempt, so anything between
      // those two is unspendable. Checked before sending, because a failed setup still costs a fee.
      if (balance < nonceRent + fee || (balance > nonceRent + fee && balance < nonceRent + fee + walletMinimum)) {
        throw new VadumError('NONCE_POOL_UNDERFUNDED', { balance, nonceRent, fee, walletMinimum });
      }

      const signer = await createSignerFromKeyPair(payerKey);
      const perSlot = nonceRent / BigInt(size);
      const instructions: Instruction[] = [];
      const slots: PoolSlot[] = [];
      for (let index = 0; index < size; index++) {
        const address = await deriveNonceAddress(payer, index);
        instructions.push(
          getCreateAccountWithSeedInstruction({
            payer: signer,
            newAccount: address,
            base: payer,
            seed: nonceSeed(index),
            amount: perSlot,
            space: BigInt(getNonceSize()),
            programAddress: SYSTEM_PROGRAM_ADDRESS,
          }),
          getInitializeNonceAccountInstruction({ nonceAccount: address, nonceAuthority: payer }),
        );
        slots.push({ index, address, value: null, state: 'unspent' });
      }
      await rpc.sendSetup(instructions, payerKey);
      await persist({ payer, size, epoch: crypto.randomUUID(), slots });
      return this.refresh();
    },

    async reserveSlot(merchant, now) {
      const state = await loaded();
      const slot = state.slots.find((candidate) => candidate.state === 'unspent' && candidate.value !== null);
      if (slot?.value == null) throw new VadumError('NONCE_POOL_EXHAUSTED', { payer, size: state.size });
      // Persisted before this resolves: the app signs only afterwards (D32).
      await persist(withSlot(state, { ...slot, state: 'spent', spentAgainst: { value: slot.value, merchant, at: now } }));
      return { index: slot.index, value: slot.value };
    },

    async applyNonceReturn(payload) {
      const state = await loaded();
      const slot = state.slots.find((candidate) => candidate.index === payload.nonceIndex);
      const record = slot?.spentAgainst;
      if (slot === undefined || slot.state !== 'spent' || record === undefined) {
        throw new VadumError('NONCE_RETURN_UNTRUSTED', { reason: 'the ledger holds no spent record for this slot', nonceIndex: payload.nonceIndex });
      }
      // Only the payload's index, new value and signature are trusted input; the rest is the ledger's.
      await verifyNonceReturn(
        { nonceIndex: payload.nonceIndex, newNonceValue: payload.newNonceValue, signature: payload.signature },
        { payer, merchant: record.merchant, spentAgainstValue: record.value },
      );
      return persist(withSlot(state, rearmed(slot, payload.newNonceValue)));
    },

    async refresh() {
      const state = await loaded();
      const slots: PoolSlot[] = [];
      for (const slot of state.slots) slots.push({ ...slot, value: (await readValue(slot)).value });
      return persist({ ...state, slots });
    },

    async close(payerKey) {
      const state = await loaded();
      await assertPayerKey(payerKey);
      // The payer pays the close fee, and a fee payer must still be rent-exempt AFTER the fee is
      // deducted — the credit from the withdrawal does not count (D38, observed again on devnet
      // 2026-09-12). A wallet parked exactly at the rent floor therefore cannot close its own pool.
      const [balance, walletMinimum] = await Promise.all([rpc.getBalance(payer), rpc.getRentExemption(0)]);
      if (balance !== 0n && balance < LAMPORTS_PER_SIGNATURE + walletMinimum) {
        throw new VadumError('NONCE_POOL_UNDERFUNDED', { reason: 'the payer cannot pay the close fee and stay rent-exempt', balance, fee: LAMPORTS_PER_SIGNATURE, walletMinimum });
      }
      const signer = await createSignerFromKeyPair(payerKey);
      const instructions: Instruction[] = [];
      let refundedLamports = 0n;
      for (const slot of state.slots) {
        const { lamports } = await readValue(slot);
        if (lamports === 0n) continue;
        refundedLamports += lamports;
        instructions.push(
          getWithdrawNonceAccountInstruction({ nonceAccount: slot.address, recipientAccount: payer, nonceAuthority: signer, withdrawAmount: lamports }),
        );
      }
      if (instructions.length > 0) await rpc.sendSetup(instructions, payerKey);
      // The record stays, with every slot unknown: a closed pool is not a missing ledger (T7).
      await persist({ ...state, slots: state.slots.map((slot) => rearmed(slot, null, 'unknown')) });
      return { refundedLamports };
    },

    async reconcile(now) {
      let state = await loaded();
      const released: number[] = [];
      const settled: number[] = [];
      const stillPending: number[] = [];
      for (const slot of state.slots) {
        const record = slot.spentAgainst;
        if (slot.state !== 'spent' || record === undefined) continue;
        const { value } = await readValue(slot);
        if (value === null) {
          // The account is gone — closed by the payer (T7). The payment can never settle.
          state = withSlot(state, rearmed(slot, null, 'unknown'));
          released.push(slot.index);
        } else if (value !== record.value) {
          // A settled nonce always advances (SOL-8): the payment landed, and the slot comes back (D32).
          state = withSlot(state, rearmed(slot, value));
          settled.push(slot.index);
        } else if (now - record.at >= sendWindowMs) {
          state = withSlot(state, rearmed(slot, value));
          released.push(slot.index);
        } else {
          stillPending.push(slot.index);
        }
      }
      await persist(state);
      return { released, settled, stillPending };
    },

    status() {
      if (current === undefined) throw new VadumError('NONCE_LEDGER_MISSING', { payer });
      return statusOf(current);
    },

    async load() {
      return statusOf(await loaded());
    },
  };
}
