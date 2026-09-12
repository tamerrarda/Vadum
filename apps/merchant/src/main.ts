// The merchant app: the accept flow and the three tiers (C5), static printed codes (C6), failure copy
// (C7), and the nonce return the payer scans (C8).
//
// The rule this file exists to hold: offline verification proves the payer signed this exact message,
// and nothing else. No screen may present it as proof that an account exists behind the payment — that
// is what the pre-check is for, and T2 cannot do it (D21, T6).

import type { Address, Nonce } from '@solana/kit';
import {
  button,
  card,
  copyFor,
  createIndexedDbStore,
  displayEnvironment,
  element,
  formatAmount,
  isStandalone,
  loadOrCreateIdentity,
  mount,
  parseAmount,
  qrImage,
  render,
  requestPersistentStorage,
  row,
  shortAddress,
  text,
  type FailureCopy,
  type Identity,
} from '@vadum/app-shared';
import {
  createMintCache,
  createQueue,
  createRpc,
  DEFAULT_QUEUE_LIMITS,
  precheckNonce,
  type MintCache,
  type NonceVerdict,
  type Queue,
  type QueuedPayment,
  type SubmitOutcome,
  type VadumRpc,
} from '@vadum/client';
import { signNonceReturn, VadumError, verifyAuth, type Intent, type MintRecord, type PaymentTier, type VerifiedPayment } from '@vadum/core';
import {
  createScanner,
  decodeAuth,
  encodeIntent,
  encodeNonceReturn,
  encodeStaticIntent,
  flagsFromByte,
  peekPayloadType,
  preloadScannerEngine,
  renderQr,
  type Scanner,
} from '@vadum/wire';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

/** v1 is devnet only (D16). */
const RPC_ENDPOINT = 'https://api.devnet.solana.com';
const SETTINGS_KEY = 'settings:merchant';

interface Settings {
  readonly mint: string | null;
  readonly tier: PaymentTier;
  /** D5: pay the rent for the merchant's token account inside the payment, once. */
  readonly includeCreateAta: boolean;
}

const DEFAULT_SETTINGS: Settings = { mint: null, tier: 'T0', includeCreateAta: true };

interface App {
  readonly identity: Identity;
  readonly rpc: VadumRpc;
  readonly mints: MintCache;
  readonly queue: Queue;
  readonly store: ReturnType<typeof createIndexedDbStore>;
  settings: Settings;
}

const TIER_COPY: Readonly<Record<PaymentTier, { readonly label: string; readonly detail: string; readonly cap: bigint }>> = {
  T0: {
    label: 'Wait for confirmation',
    detail: 'Submit and hand over only once the network confirms. About a second online, and no risk at all.',
    cap: DEFAULT_QUEUE_LIMITS.receiptCapByTier.T0,
  },
  T1: {
    label: 'Accept immediately (online)',
    detail: 'Check the payment’s account online, then hand over before confirmation. Seconds of exposure, and the check is mandatory.',
    cap: DEFAULT_QUEUE_LIMITS.receiptCapByTier.T1,
  },
  T2: {
    label: 'Accept offline',
    detail:
      'No connection, so the payment cannot be checked at all. A valid-looking code can be produced by someone with no account behind it — you would lose the goods and be charged nothing. Keep the amounts small.',
    cap: DEFAULT_QUEUE_LIMITS.receiptCapByTier.T2,
  },
};

// ─── helpers ────────────────────────────────────────────────────────────────────────────────────────

const mintMap = (mints: MintCache): ReadonlyMap<Address, MintRecord> => new Map(mints.entries().map((record) => [record.mint, record]));

const currentMint = (app: App): MintRecord | undefined => (app.settings.mint === null ? undefined : app.mints.get(app.settings.mint as Address));

async function saveSettings(app: App, changes: Partial<Settings>): Promise<void> {
  app.settings = { ...app.settings, ...changes };
  await app.store.set(SETTINGS_KEY, app.settings);
}

function showCopy(app: App, copy: FailureCopy, ...extra: readonly Node[]): void {
  render(text('h1', copy.title), text('p', copy.body), ...extra, card(button('Back', () => home(app))));
}

function failed(app: App, error: unknown): void {
  if (error instanceof VadumError) {
    showCopy(app, copyFor(error.code));
    return;
  }
  console.error(error);
  showCopy(app, { title: 'That did not work', body: 'The step could not be completed. Nothing was accepted or sent.', side: 'merchant' });
}

// ─── settings and setup ─────────────────────────────────────────────────────────────────────────────

async function chooseMint(app: App): Promise<void> {
  const input = element('input', { type: 'text', placeholder: 'Token mint address', 'aria-label': 'Mint address' }) as HTMLInputElement;
  const status = text('p', 'Checking a token needs a connection once. After that it works offline.', 'muted');
  render(
    text('h1', 'Which token do you accept?'),
    card(input, status),
    card(
      button(
        'Check this token',
        async () => {
          try {
            status.textContent = 'Checking…';
            status.className = 'muted';
            const record = await app.mints.refresh(input.value.trim() as Address);
            if (!record.compatible) {
              showCopy(app, copyFor('MINT_INCOMPATIBLE'), card(text('p', `Blocked by: ${record.blockers.join(', ')}`, 'bad')));
              return;
            }
            await saveSettings(app, { mint: record.mint });
            await home(app);
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

function settings(app: App): void {
  const tierButtons = (Object.keys(TIER_COPY) as PaymentTier[]).map((tier) =>
    card(
      text('h2', `${TIER_COPY[tier].label}${app.settings.tier === tier ? ' — on' : ''}`),
      text('p', TIER_COPY[tier].detail, tier === 'T2' ? 'warn' : 'muted'),
      text('p', tier === 'T0' ? 'No cap needed.' : `Per-sale cap ${formatAmount(TIER_COPY[tier].cap, currentMint(app)?.decimals ?? 6)}`, 'muted'),
      button(app.settings.tier === tier ? 'Selected' : `Use ${TIER_COPY[tier].label.toLowerCase()}`, async () => {
        await saveSettings(app, { tier });
        settings(app);
      }, { disabled: app.settings.tier === tier }),
    ),
  );
  render(
    text('h1', 'Settings'),
    card(
      row('This till', shortAddress(app.identity.address)),
      row('Token', app.settings.mint === null ? 'not set' : shortAddress(app.settings.mint)),
      row('Fees and rent', 'paid by this till'),
      button('Change token', () => chooseMint(app)),
    ),
    ...tierButtons,
    card(
      text('p', 'Create the token account inside the first payment if it does not exist yet. Costs this till a one-time rent deposit.', 'muted'),
      button(app.settings.includeCreateAta ? 'Creating account: on' : 'Creating account: off', async () => {
        await saveSettings(app, { includeCreateAta: !app.settings.includeCreateAta });
        settings(app);
      }),
    ),
    card(button('Back', () => home(app))),
  );
}

// ─── home and the amount keypad ─────────────────────────────────────────────────────────────────────

async function home(app: App): Promise<void> {
  const mint = currentMint(app);
  if (mint === undefined) {
    await chooseMint(app);
    return;
  }
  const queued = app.queue.list().filter((payment) => payment.state === 'queued' || payment.state === 'failed' || payment.state === 'submitting');
  const input = element('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00', 'aria-label': 'Amount' }) as HTMLInputElement;
  const error = text('p', '', 'bad');

  render(
    text('h1', 'Take a payment'),
    card(
      row('Mode', TIER_COPY[app.settings.tier].label),
      row('Token', shortAddress(mint.mint)),
      app.settings.tier === 'T2' ? text('p', TIER_COPY.T2.detail, 'warn') : text('p', TIER_COPY[app.settings.tier].detail, 'muted'),
    ),
    card(
      input,
      error,
      button(
        'Show the request',
        () => {
          const amount = parseAmount(input.value, mint.decimals);
          if (amount === null || amount === 0n) {
            error.textContent = `Enter an amount with at most ${mint.decimals} decimal places.`;
            return;
          }
          const cap = TIER_COPY[app.settings.tier].cap;
          if (amount > cap) {
            // The cap is enforced here as well as in client/queue.ts: a merchant should not get as far
            // as a signed payment they cannot accept (C5).
            error.textContent = `${TIER_COPY[app.settings.tier].label} allows at most ${formatAmount(cap, mint.decimals)}.`;
            return;
          }
          void showIntent(app, mint, amount);
        },
        { primary: true },
      ),
    ),
    card(button('Printed code for this till', () => showStatic(app, mint)), button(`Queue (${queued.length} waiting)`, () => queueScreen(app)), button('Settings', () => settings(app))),
  );
}

const intentFor = (app: App, mint: MintRecord, amount: bigint | null): Intent => ({
  merchant: app.identity.address,
  mint: mint.mint,
  decimals: mint.decimals,
  amount,
  lifetime: { kind: 'nonce' },
  includeCreateAta: app.settings.includeCreateAta,
  tokenProgram: mint.tokenProgram,
  feePayer: app.identity.address,
  isStatic: amount === null,
});

async function showIntent(app: App, mint: MintRecord, amount: bigint): Promise<void> {
  const intent = intentFor(app, mint, amount);
  const bytes = encodeIntent(intent);
  const qr = await renderQr(bytes);
  render(
    text('h1', formatAmount(amount, mint.decimals)),
    qrImage(qr.dataUrl, `${bytes.length} bytes · QR v${qr.version}`),
    card(text('p', 'The customer scans this, confirms, and shows you a code back.', 'muted')),
    card(button('Scan the payment', () => scanAuth(app, intent, bytes, amount), { primary: true }), button('Cancel', () => home(app))),
  );
}

async function showStatic(app: App, mint: MintRecord): Promise<void> {
  const intent = intentFor(app, mint, null);
  const bytes = encodeStaticIntent(intent);
  const qr = await renderQr(bytes);
  render(
    text('h1', 'Printed code'),
    qrImage(qr.dataUrl, `${bytes.length} bytes · QR v${qr.version}`),
    card(
      text('p', 'Print this and the customer can pay any amount without your phone showing anything.', 'muted'),
      text('p', 'A printed code is exactly what someone can cover with their own. Check the code on your counter now and then, and the amount before you accept.', 'warn'),
    ),
    card(button('Accept a payment for this code', () => enterExpected(app, intent, bytes), { primary: true }), button('Back', () => home(app))),
  );
}

/** C6: in static mode the expected amount is entered BEFORE the scan, and `verifyAuth` requires it. */
function enterExpected(app: App, intent: Intent, intentBytes: Uint8Array): void {
  const input = element('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00', 'aria-label': 'Price of this sale' }) as HTMLInputElement;
  const error = text('p', '', 'bad');
  render(
    text('h1', 'What is this sale?'),
    card(text('p', 'Enter the price before scanning. Without it, a customer could sign any amount and this screen would still say verified.', 'warn'), input, error),
    card(
      button(
        'Scan the payment',
        () => {
          const amount = parseAmount(input.value, intent.decimals);
          if (amount === null || amount === 0n) {
            error.textContent = `Enter an amount with at most ${intent.decimals} decimal places.`;
            return;
          }
          void scanAuth(app, intent, intentBytes, amount);
        },
        { primary: true },
      ),
      button('Back', () => home(app)),
    ),
  );
}

// ─── the accept flow (C5) ───────────────────────────────────────────────────────────────────────────

async function scanAuth(app: App, intent: Intent, intentBytes: Uint8Array, expectedAmount: bigint): Promise<void> {
  const video = element('video', { autoplay: 'true', muted: 'true', playsinline: 'true' }) as HTMLVideoElement;
  let scanner: Scanner | undefined;
  const stop = async (): Promise<void> => {
    await scanner?.stop();
  };
  render(
    text('h1', 'Scan the payment'),
    card(video, text('p', `Expecting ${formatAmount(expectedAmount, intent.decimals)}.`, 'muted')),
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
    const scanned = await scanner.next();
    await stop();
    const type = peekPayloadType(scanned.bytes);
    if (type !== 'AUTH') throw new VadumError('WIRE_UNEXPECTED_TYPE', { expected: 'AUTH', actual: type });
    const auth = decodeAuth(scanned.bytes, { mintCache: mintMap(app.mints), intentFlags: flagsFromByte(intentBytes[2]!) });
    // Offline, against a message rebuilt here: nothing received over the air is verified directly.
    const payment = await verifyAuth(intent, auth, expectedAmount);
    await accept(app, payment, expectedAmount);
  } catch (error) {
    await stop();
    failed(app, error);
  }
}

async function accept(app: App, payment: VerifiedPayment, amount: bigint): Promise<void> {
  const decimals = payment.input.intent.decimals;
  const tier = app.settings.tier;
  try {
    if (tier === 'T0') {
      render(text('h1', 'Verified — confirming on the network'), text('p', 'Do not hand over yet.'));
      await app.queue.accept(payment, 'T0', amount);
      const outcomes = await app.queue.drain(app.identity.keyPair);
      await settlementScreen(app, payment, amount, outcomes.at(-1));
      return;
    }

    let verdict: NonceVerdict | undefined;
    if (tier === 'T1') {
      render(text('h1', 'Verified — checking the account'), text('p', 'One lookup before you hand over.'));
      verdict = await precheckNonce(app.rpc, payment);
    }
    const queued = await app.queue.accept(payment, tier, amount, verdict);

    render(
      text('h1', 'Verified offline'),
      card(
        text('div', formatAmount(amount, decimals), 'amount'),
        row('From', shortAddress(payment.input.payer)),
        row('Mode', TIER_COPY[tier].label),
        tier === 'T1'
          ? text('p', 'The payment’s account was checked just now and holds the value it claims. It still has to settle when you submit.', 'ok')
          : text('p', 'This code is signed by the customer, and that is all this check can prove: there may be no account behind it. Hand over at your own risk.', 'warn'),
      ),
      card(row('Waiting to settle', formatAmount(app.queue.exposure(), decimals)), row('Reference', queued.id.slice(0, 28))),
      card(button('Next customer', () => home(app), { primary: true }), button('Queue', () => queueScreen(app))),
    );
  } catch (error) {
    failed(app, error);
  }
}

async function settlementScreen(app: App, payment: VerifiedPayment, amount: bigint, outcome: SubmitOutcome | undefined): Promise<void> {
  if (outcome === undefined) {
    await home(app);
    return;
  }
  if (outcome.kind === 'failed') {
    showCopy(app, copyFor(outcome.code), card(row('Amount', formatAmount(amount, payment.input.intent.decimals)), row('From', shortAddress(payment.input.payer))));
    return;
  }
  const nonceRef = payment.input.nonceRef;
  const recovery =
    nonceRef !== null && outcome.newNonceValue !== null
      ? card(button('Show the customer their recovery code', () => showNonceReturn(app, payment, outcome.newNonceValue as Nonce), { primary: true }))
      : element('div', {}, []);
  render(
    text('h1', 'Settled'),
    card(
      text('div', formatAmount(amount, payment.input.intent.decimals), 'amount'),
      row('From', shortAddress(payment.input.payer)),
      row('Signature', `${outcome.signature.slice(0, 12)}…`),
      text('p', 'Confirmed on the network. Safe to hand over.', 'ok'),
    ),
    recovery,
    card(button('Next customer', () => home(app))),
  );
}

/** C8: the payer scans this and gets the slot back without ever reconnecting (D20, D28). */
async function showNonceReturn(app: App, payment: VerifiedPayment, newNonceValue: Nonce): Promise<void> {
  const nonceRef = payment.input.nonceRef;
  if (nonceRef === null) {
    await home(app);
    return;
  }
  try {
    const signature = await signNonceReturn(
      { payer: payment.input.payer, nonceIndex: nonceRef.index, spentAgainstValue: nonceRef.value, newNonceValue },
      app.identity.keyPair,
    );
    const bytes = encodeNonceReturn({ nonceIndex: nonceRef.index, newNonceValue, signature });
    const qr = await renderQr(bytes);
    render(
      text('h1', 'Recovery code'),
      qrImage(qr.dataUrl, `${bytes.length} bytes · QR v${qr.version}`),
      card(text('p', 'The customer scans this to free the offline payment slot they just used. It works with their phone still offline, and it is useless to anybody else.', 'muted')),
      card(button('Done', () => home(app))),
    );
  } catch (error) {
    failed(app, error);
  }
}

// ─── the queue (C5) ─────────────────────────────────────────────────────────────────────────────────

function queueLine(payment: QueuedPayment, decimals: number): HTMLElement {
  const state = payment.state === 'failed' && payment.lastError !== undefined ? copyFor(payment.lastError).title : payment.state;
  return card(row(formatAmount(payment.amount, decimals), state), row(shortAddress(payment.payment.input.payer), `${payment.tier} · attempts ${payment.attempts}`));
}

async function queueScreen(app: App): Promise<void> {
  const decimals = currentMint(app)?.decimals ?? 6;
  const payments = app.queue.list();
  const expired = app.queue.expire(Date.now());
  render(
    text('h1', 'Queue'),
    card(
      row('Waiting to settle', formatAmount(app.queue.exposure(), decimals)),
      row('Failed sends in a row', String(app.queue.consecutiveFailedSends())),
      expired.length > 0 ? text('p', `${expired.length} payment(s) passed the 24-hour window and were voided.`, 'warn') : text('p', 'Nothing has expired.', 'muted'),
    ),
    ...payments.slice(-12).reverse().map((payment) => queueLine(payment, decimals)),
    card(
      button(
        'Send everything now',
        async () => {
          render(text('h1', 'Sending…'));
          try {
            const outcomes = await app.queue.drain(app.identity.keyPair);
            const failures = outcomes.filter((outcome) => outcome.kind === 'failed');
            render(
              text('h1', failures.length === 0 ? 'All sent' : 'Some did not settle'),
              ...outcomes.map((outcome) =>
                outcome.kind === 'settled'
                  ? card(row('Settled', `${outcome.signature.slice(0, 12)}…`))
                  : card(text('h2', copyFor(outcome.code).title), text('p', copyFor(outcome.code).body, outcome.code === 'SUBMIT_NONCE_ABSENT' ? 'bad' : 'muted')),
              ),
              card(button('Back', () => queueScreen(app))),
            );
          } catch (error) {
            failed(app, error);
          }
        },
        { primary: true, disabled: payments.every((payment) => payment.state !== 'queued' && payment.state !== 'failed') },
      ),
      button('Back', () => home(app)),
    ),
  );
}

// ─── boot ───────────────────────────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  mount();
  render(text('h1', 'Vadum'), text('p', 'Starting…'));

  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((error: unknown) => console.warn('service worker', error));
  }
  void requestPersistentStorage();
  void preloadScannerEngine(wasmUrl).catch(() => undefined);

  const store = createIndexedDbStore();
  const identity = await loadOrCreateIdentity(store);
  const rpc = createRpc(RPC_ENDPOINT);
  const mints = createMintCache(rpc, store);
  await mints.load();
  const queue = createQueue(rpc, store, DEFAULT_QUEUE_LIMITS);
  await queue.load();
  const app: App = { identity, rpc, mints, queue, store, settings: (await store.get<Settings>(SETTINGS_KEY)) ?? DEFAULT_SETTINGS };

  // The merchant never signs a payment, so the standalone gate does not apply to it (T4) — but a till
  // running in a browser tab can still lose its queue, and it should know that.
  if (!isStandalone(displayEnvironment())) {
    render(
      text('h1', 'Add this till to your home screen'),
      text('p', 'In a browser tab the phone can delete the queue of payments waiting to settle. Installed, it cannot.'),
      card(button('Continue anyway', () => home(app))),
    );
    return;
  }
  await home(app);
}

void boot().catch((error: unknown) => {
  mount();
  render(text('h1', 'Vadum could not start'), text('p', String(error)));
});
