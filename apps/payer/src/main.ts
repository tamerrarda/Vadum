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
  needsRetype,
  parseAmount,
  PAYER_PER_PAYMENT_CAP,
  qrImage,
  readEpochMarker,
  render,
  requestPersistentStorage,
  row,
  shortAddress,
  signingBlock,
  STATE_COPY,
  text,
  withinPayerCap,
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
// Both from apps/shared/src/limits.ts: the retype threshold is a second look at the amount, and the
// cap is what actually bounds an unlocked stolen phone (T12, C-7).

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
    // `refresh` reads the ledger before it reads the chain, so with the ledger gone this is the only
    // outcome it can have — and it was the outcome of the RECOVERY screen's only button (REV-16).
    if (error instanceof VadumError && error.code === 'NONCE_LEDGER_MISSING') {
      await recoverFromChain(app);
      return;
    }
    failed(app, error);
  }
}

/**
 * The ledger is gone, so there is nothing to refresh: the slots are found on chain from their derived
 * addresses instead. What comes back is the **deposit**, not the ability to pay — a recovered slot has
 * unknown history, and nothing on chain can say whether a merchant still holds a payment signed
 * against it. The screen says that in those words rather than implying a full restore.
 */
async function recoverFromChain(app: App): Promise<void> {
  render(text('h1', 'Looking for your slots…'), text('p', 'Reading them from the network by their addresses.'));
  try {
    const status = await app.pool.recover();
    writeEpochMarker(localStorage, status.epoch);
    render(
      text('h1', 'Slots found — the deposit, not the payments'),
      card(
        row('Slots found', `${status.slots.length}`),
        text(
          'p',
          'These cannot be reused: with the record gone, nothing on the network says whether a merchant is still holding a payment signed against one. Closing them returns the whole deposit, and new slots start clean.',
          'warn',
        ),
      ),
      card(button('Close slots and get the deposit back', () => closePool(app), { primary: true })),
    );
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
    // Straight to the token screen, not home: this is the one moment the device is certainly online,
    // and a pool with no checked token cannot pay for anything.
    await tokens(app);
  } catch (error) {
    failed(app, error);
  }
}

async function home(app: App): Promise<void> {
  const status = await app.pool.load();
  const lowWater = status.belowLowWaterMark
    ? text('p', `${status.unspentCount} offline payments left — reconnect to refresh them.`, 'warn')
    : text('p', `${status.unspentCount} of ${status.size} offline payments ready.`, 'muted');
  // A payment can only be decoded against a mint this device has checked online (receive rules 4 and
  // 5). With none checked, scanning a request can end only in MINT_UNKNOWN, so the button says why
  // instead of leading the payer into a failure that looks like a broken app.
  const tokenCount = app.mints.entries().length;
  const tokenNotice =
    tokenCount === 0
      ? text('p', 'No tokens checked yet — a payment cannot be verified offline until you check one.', 'warn')
      : text('p', `${tokenCount} token${tokenCount === 1 ? '' : 's'} ready to pay with.`, 'muted');
  render(
    text('h1', 'Vadum'),
    card(
      row('This device', shortAddress(app.identity.address)),
      row('Key', app.identity.signingPath === 'native' ? 'device WebCrypto' : 'software fallback'),
      lowWater,
      tokenNotice,
    ),
    card(button('Scan a payment request', () => scan(app, 'payment'), { primary: true, disabled: status.unspentCount === 0 || tokenCount === 0 })),
    card(button('Scan a recovery code', () => scan(app, 'recovery'))),
    card(button(tokenCount === 0 ? 'Check a token' : `Tokens (${tokenCount})`, () => tokens(app))),
    // Every slot unknown means the pool was closed or recovered: without this the payer would sit on a
    // dead pool with no way back, because boot only offers onboarding when there is no pool record.
    status.slots.every((slot) => slot.state === 'unknown')
      ? card(button('Create new slots', () => onboarding(app), { primary: true }))
      : element('div', {}, []),
    card(button('Refresh from the network', () => restore(app)), button('Close slots and get the deposit back', () => closePool(app))),
  );
}

/**
 * The tokens this device can pay with (C4). Online, and the only writer of the mint cache on the payer
 * side — without it `decodeIntent` throws `MINT_UNKNOWN` for every request, which is exactly what it
 * did before this screen existed: a device could fund a pool, go offline, scan, and be stuck for good.
 */
async function tokens(app: App): Promise<void> {
  const input = element('input', { type: 'text', placeholder: 'Token mint address', 'aria-label': 'Mint address' }) as HTMLInputElement;
  const status = text('p', 'Checking a token needs a connection once. After that you can pay with it offline.', 'muted');
  const checked = app.mints.entries();
  render(
    text('h1', 'Tokens you can pay with'),
    checked.length === 0
      ? card(text('p', STATE_COPY['no-tokens'].body, 'warn'))
      : card(...checked.map((record) => row(shortAddress(record.mint), `${record.decimals} decimals · ${record.tokenProgram}`))),
    card(input, status),
    card(
      button(
        'Check this token',
        async () => {
          try {
            status.textContent = 'Checking…';
            status.className = 'muted';
            const record = await app.mints.refresh(input.value.trim() as Address);
            // A mint whose rules make an offline payment unverifiable is refused here rather than at
            // the confirmation screen, where the payer has a merchant waiting (D8).
            if (!record.compatible) {
              showCopy(copyFor('MINT_INCOMPATIBLE'), card(text('p', `Blocked by: ${record.blockers.join(', ')}`, 'bad')), card(button('Back', () => tokens(app))));
              return;
            }
            await tokens(app);
          } catch (error) {
            failed(app, error);
          }
        },
        { primary: true },
      ),
      button('Back', () => home(app)),
    ),
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

  // The payer's own cap: refused here, before anything is signed, because nothing else in the system
  // bounds what this device will pay (T12). A thief with an unlocked phone retypes an amount happily.
  if (!withinPayerCap(amount)) {
    showCopy(STATE_COPY['above-payer-cap'], card(row('This payment', formatAmount(amount, intent.decimals)), row('Offline limit', formatAmount(PAYER_PER_PAYMENT_CAP, intent.decimals))), card(button('Back', () => home(app))));
    return;
  }

  // The cap bounds one payment and says nothing about how many. The spend limit does, and nothing but
  // time refills it — "Refresh from the network" re-arms slots, which is how the old bound fell (REV-17).
  // `reserveSlot` enforces it; asking here tells the payer before the Sign button rather than after.
  const allowance = await app.pool.allowance(Date.now());
  if (amount > allowance.remaining) {
    showCopy(
      copyFor('LIMIT_PAYER_ALLOWANCE'),
      card(
        row('This payment', formatAmount(amount, intent.decimals)),
        row('Signed offline, last 24 hours', formatAmount(allowance.spent, intent.decimals)),
        row('Limit per 24 hours', formatAmount(allowance.limit, intent.decimals)),
        ...(allowance.nextRefillAt === null ? [] : [row('Frees up from', new Date(allowance.nextRefillAt).toLocaleString())]),
      ),
      card(button('Back', () => home(app))),
    );
    return;
  }

  const confirmed = (): void => void sign(app, intent, amount);
  const above = needsRetype(amount);
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
    const slot = await app.pool.reserveSlot(intent.merchant, Date.now(), amount);
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

const FIXED_BY_CHECKING_A_TOKEN = new Set(['MINT_UNKNOWN', 'MINT_DECIMALS_MISMATCH', 'MINT_TOKEN_PROGRAM_MISMATCH']);

function failed(app: App, error: unknown): void {
  const copy = error instanceof VadumError ? copyFor(error.code) : { title: 'That did not work', body: 'The step could not be completed. Nothing was signed or sent.', side: 'payer' as const };
  // `MINT_UNKNOWN` says "reconnect once to check it", so the screen has to offer the place that does
  // it. Pointing at a screen that did not exist was the whole of the defect.
  const next =
    error instanceof VadumError && FIXED_BY_CHECKING_A_TOKEN.has(error.code)
      ? card(button('Check this token', () => tokens(app), { primary: true }), button('Back', () => home(app)))
      : card(button('Back', () => home(app)));
  showCopy(copy, next);
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
