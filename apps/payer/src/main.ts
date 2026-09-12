// The payer app: onboarding (C0), the standalone gate and RECOVERY (C3), the sign flow (C4), and
// nonce recovery over QR (C8).
//
// Two rules shape this file. It keeps no record of which slots are spent — `client/pool.ts` owns that
// (D32) — and it never signs unless the gate says it may: installed, with a ledger (T4).

import type { Address, Nonce } from '@solana/kit';
import {
  button,
  card,
  copyFor,
  createIndexedDbStore,
  displayEnvironment,
  element,
  formatAmount,
  formatSol,
  hasPoolState,
  isStandalone,
  loadOrCreateIdentity,
  mount,
  parseAmount,
  qrImage,
  readEpochMarker,
  render,
  requestPersistentStorage,
  row,
  shortAddress,
  signingBlock,
  STATE_COPY,
  text,
  writeEpochMarker,
  assessLedger,
  type FailureCopy,
  type Identity,
} from '@vadum/app-shared';
import { createMintCache, createPool, createRpc, type MintCache, type Pool } from '@vadum/client';
import { signAsPayer, VadumError, type Intent, type MintRecord } from '@vadum/core';
import {
  createScanner,
  decodeIntent,
  decodeNonceReturn,
  decodeStaticIntent,
  encodeAuth,
  flagsFromByte,
  peekPayloadType,
  preloadScannerEngine,
  renderQr,
  type Scanner,
} from '@vadum/wire';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

/** v1 is devnet only (D16). */
const RPC_ENDPOINT = 'https://api.devnet.solana.com';
const POOL_SIZE = 5;
/** Above this the payer re-confirms the amount by typing it (31-PARAMETERS; see stream-c.md C-7). */
const CONFIRM_THRESHOLD = 10_000_000n;

interface App {
  readonly identity: Identity;
  readonly pool: Pool;
  readonly mints: MintCache;
  readonly store: ReturnType<typeof createIndexedDbStore>;
  readonly standalone: boolean;
}

const mintMap = (mints: MintCache): ReadonlyMap<Address, MintRecord> => new Map(mints.entries().map((record) => [record.mint, record]));

// ─── screens ────────────────────────────────────────────────────────────────────────────────────────

function showCopy(copy: FailureCopy, ...extra: readonly Node[]): void {
  render(text('h1', copy.title), text('p', copy.body), ...extra);
}

function blockedScreen(app: App, reason: 'not-installed' | 'ledger-missing'): void {
  if (reason === 'not-installed') {
    showCopy(STATE_COPY['not-installed'], card(row('This device', shortAddress(app.identity.address)), text('p', 'History and settings still work here.', 'muted')));
    return;
  }
  showCopy(STATE_COPY.recovery, card(button('Restore from the network', () => restore(app), { primary: true })));
}

async function restore(app: App): Promise<void> {
  render(text('h1', 'Restoring…'), text('p', 'Reading your offline payment slots from the network.'));
  try {
    const status = await app.pool.refresh();
    await app.pool.reconcile(Date.now());
    writeEpochMarker(localStorage, status.epoch);
    await home(app);
  } catch (error) {
    failed(app, error);
  }
}

async function onboarding(app: App): Promise<void> {
  render(text('h1', 'Set up offline payments'), text('p', 'Reading the current deposit from the network…'));
  try {
    const cost = await app.pool.estimateSetupCost(POOL_SIZE);
    const total = cost.nonceRent + cost.fee + cost.walletMinimum;
    render(
      text('h1', 'Set up offline payments'),
      card(
        text('h2', `${POOL_SIZE} offline payments`),
        text(
          'p',
          'Each offline payment needs a slot on Solana. Creating them takes a one-time deposit that comes back in full when you close them — you are not spending it.',
        ),
        row('Refundable deposit', `${formatSol(cost.nonceRent)} SOL`),
        row('Network fee', `${formatSol(cost.fee)} SOL`),
        row('Wallet minimum', `${formatSol(cost.walletMinimum)} SOL`),
        row('Send to this device', `${formatSol(total)} SOL`),
        text('code', app.identity.address),
        text('p', 'You do not need SOL to pay — the merchant pays the fee. This deposit is only to create the slots.', 'muted'),
      ),
      card(button(`Create ${POOL_SIZE} slots`, () => createPoolNow(app), { primary: true })),
    );
  } catch (error) {
    failed(app, error);
  }
}

async function createPoolNow(app: App): Promise<void> {
  render(text('h1', 'Creating slots…'), text('p', 'One transaction, signed by this device.'));
  try {
    const status = await app.pool.create(POOL_SIZE, app.identity.keyPair);
    writeEpochMarker(localStorage, status.epoch);
    await home(app);
  } catch (error) {
    failed(app, error);
  }
}

async function home(app: App): Promise<void> {
  const status = await app.pool.load();
  const lowWater = status.belowLowWaterMark
    ? text('p', `${status.unspentCount} offline payments left — reconnect to refresh them.`, 'warn')
    : text('p', `${status.unspentCount} of ${status.size} offline payments ready.`, 'muted');
  render(
    text('h1', 'Vadum'),
    card(row('This device', shortAddress(app.identity.address)), row('Key', app.identity.signingPath === 'native' ? 'device WebCrypto' : 'software fallback'), lowWater),
    card(button('Scan a payment request', () => scan(app, 'payment'), { primary: true, disabled: status.unspentCount === 0 })),
    card(button('Scan a recovery code', () => scan(app, 'recovery'))),
    card(button('Refresh from the network', () => restore(app)), button('Close slots and get the deposit back', () => closePool(app))),
  );
}

async function closePool(app: App): Promise<void> {
  render(text('h1', 'Closing slots…'));
  try {
    const { refundedLamports } = await app.pool.close(app.identity.keyPair);
    render(
      text('h1', 'Slots closed'),
      card(row('Refunded', `${formatSol(refundedLamports)} SOL`), text('p', 'Offline payments are off until you create slots again.', 'muted')),
      card(button('Back', () => home(app))),
    );
  } catch (error) {
    failed(app, error);
  }
}

// ─── scanning ───────────────────────────────────────────────────────────────────────────────────────

async function scan(app: App, purpose: 'payment' | 'recovery'): Promise<void> {
  const video = element('video', { autoplay: 'true', muted: 'true', playsinline: 'true' }) as HTMLVideoElement;
  let scanner: Scanner | undefined;
  const stop = async (): Promise<void> => {
    await scanner?.stop();
  };
  render(
    text('h1', purpose === 'payment' ? 'Scan the request' : 'Scan the recovery code'),
    card(video, text('p', 'Point the camera at the merchant’s code.', 'muted')),
    card(
      button('Cancel', async () => {
        await stop();
        await home(app);
      }),
    ),
  );

  try {
    // The engine was warmed at boot (APP-3), so this only opens the camera.
    scanner = await createScanner({ wasmUrl });
    await scanner.start(video);
    const result = await scanner.next();
    await stop();
    await routeScan(app, result.bytes, purpose);
  } catch (error) {
    await stop();
    failed(app, error);
  }
}

async function routeScan(app: App, bytes: Uint8Array, purpose: 'payment' | 'recovery'): Promise<void> {
  const type = peekPayloadType(bytes);
  const mintCache = mintMap(app.mints);
  if (purpose === 'recovery' || type === 'NONCE_RETURN') {
    if (type !== 'NONCE_RETURN') throw new VadumError('WIRE_UNEXPECTED_TYPE', { expected: 'NONCE_RETURN', actual: type });
    const status = await app.pool.applyNonceReturn(decodeNonceReturn(bytes));
    render(
      text('h1', 'Slot restored'),
      card(text('p', `An offline payment slot is available again. ${status.unspentCount} of ${status.size} ready.`, 'ok')),
      card(button('Back', () => home(app))),
    );
    return;
  }
  if (type === 'INTENT') {
    const intent = decodeIntent(bytes, { mintCache });
    await confirm(app, intent, intent.amount ?? 0n);
    return;
  }
  if (type === 'STATIC_INTENT') {
    await enterAmount(app, decodeStaticIntent(bytes, { mintCache }));
    return;
  }
  throw new VadumError('WIRE_UNEXPECTED_TYPE', { expected: 'INTENT', actual: type });
}

// ─── the sign flow (C4) ─────────────────────────────────────────────────────────────────────────────

function enterAmount(app: App, intent: Intent): void {
  const input = element('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00', 'aria-label': 'Amount' }) as HTMLInputElement;
  const error = text('p', '', 'bad');
  render(
    text('h1', 'Enter the amount'),
    card(row('Pay', shortAddress(intent.merchant)), row('Token', shortAddress(intent.mint)), input, error),
    card(
      button(
        'Continue',
        () => {
          const amount = parseAmount(input.value, intent.decimals);
          if (amount === null || amount === 0n) {
            error.textContent = `Enter an amount with at most ${intent.decimals} decimal places.`;
            return;
          }
          void confirm(app, intent, amount);
        },
        { primary: true },
      ),
      button('Cancel', () => home(app)),
    ),
  );
}

async function confirm(app: App, intent: Intent, amount: bigint): Promise<void> {
  const staleness = app.mints.staleness(intent.mint, Date.now());
  const warning =
    staleness === 'stale-mutable'
      ? text('p', copyFor('MINT_RECORD_STALE').body, 'warn')
      : intent.isStatic
        ? text('p', 'This came from a printed code. Anyone can cover a sticker with their own — check you are paying the right merchant.', 'warn')
        : text('p', 'Nothing here touches the network. You are signing what is shown.', 'muted');

  const confirmed = (): void => void sign(app, intent, amount);
  const above = amount > CONFIRM_THRESHOLD;
  const check = element('input', { type: 'text', inputmode: 'decimal', 'aria-label': 'Re-enter the amount' }) as HTMLInputElement;
  const error = text('p', '', 'bad');

  render(
    text('h1', 'Confirm payment'),
    card(
      text('div', `${formatAmount(amount, intent.decimals)}`, 'amount'),
      row('To', shortAddress(intent.merchant)),
      row('Token', shortAddress(intent.mint)),
      row('Fee', 'paid by the merchant'),
      warning,
    ),
    above
      ? card(text('p', 'This is a large payment. Type the amount again to confirm.', 'warn'), check, error)
      : element('div', {}, []),
    card(
      button(
        above ? 'Confirm and sign' : 'Sign',
        () => {
          if (above && parseAmount(check.value, intent.decimals) !== amount) {
            error.textContent = 'The amounts do not match.';
            return;
          }
          confirmed();
        },
        { primary: true },
      ),
      button('Cancel', () => home(app)),
    ),
  );
}

async function sign(app: App, intent: Intent, amount: bigint): Promise<void> {
  render(text('h1', 'Signing…'));
  try {
    const block = signingBlock({ standalone: app.standalone, ledger: assessLedger({ epoch: readEpochMarker(localStorage), hasPoolState: await hasPoolState(app.store, app.identity.address) }) });
    if (block !== null) {
      blockedScreen(app, block);
      return;
    }
    // The fail-safe order (D32): the slot is persisted as spent before a signature exists, so a crash
    // here costs a slot until reconciliation, never a double-spend.
    const slot = await app.pool.reserveSlot(intent.merchant, Date.now());
    const auth = await signAsPayer({ intent, payer: app.identity.address, nonceRef: slot, amount }, app.identity.keyPair);
    const payload = encodeAuth(auth, flagsFromByte((intent.isStatic ? 0b0001_0000 : 0) | (intent.includeCreateAta ? 0b0000_0010 : 0) | (intent.tokenProgram === 'token-2022' ? 0b0000_0100 : 0) | (intent.lifetime.kind === 'fresh' ? 0b0000_0001 : 0)));
    const qr = await renderQr(payload);
    render(
      text('h1', 'Show this to the merchant'),
      qrImage(qr.dataUrl, `${payload.length} bytes · QR v${qr.version} · slot ${slot.index}`),
      card(row('Paid', formatAmount(amount, intent.decimals)), row('To', shortAddress(intent.merchant)), text('p', 'Signed with no network. The merchant sends it when they reconnect.', 'ok')),
      card(button('Done', () => home(app))),
    );
  } catch (error) {
    failed(app, error);
  }
}

function failed(app: App, error: unknown): void {
  const copy = error instanceof VadumError ? copyFor(error.code) : { title: 'That did not work', body: 'The step could not be completed. Nothing was signed or sent.', side: 'payer' as const };
  showCopy(copy, card(button('Back', () => home(app))));
  if (!(error instanceof VadumError)) console.error(error);
}

// ─── boot ───────────────────────────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  mount();
  render(text('h1', 'Vadum'), text('p', 'Starting…'));

  if ('serviceWorker' in navigator) {
    // Registered, never awaited: a first run with no network must still reach a screen.
    void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((error: unknown) => console.warn('service worker', error));
  }
  void requestPersistentStorage();
  void preloadScannerEngine(wasmUrl).catch(() => undefined);

  const store = createIndexedDbStore();
  const identity = await loadOrCreateIdentity(store);
  const rpc = createRpc(RPC_ENDPOINT);
  const mints = createMintCache(rpc, store);
  await mints.load();
  const app: App = { identity, pool: createPool(rpc, identity.address, store), mints, store, standalone: isStandalone(displayEnvironment()) };

  const ledger = assessLedger({ epoch: readEpochMarker(localStorage), hasPoolState: await hasPoolState(store, identity.address) });
  if (!app.standalone) {
    blockedScreen(app, 'not-installed');
    return;
  }
  if (ledger === 'empty') {
    await onboarding(app);
    return;
  }
  if (ledger === 'recovery') {
    blockedScreen(app, 'ledger-missing');
    return;
  }
  await home(app);
}

void boot().catch((error: unknown) => {
  mount();
  render(text('h1', 'Vadum could not start'), text('p', String(error)));
});
