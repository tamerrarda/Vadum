// @vadum/app-shared — the browser runtime both apps share. Not a package we publish: it exists so the
// payer and merchant apps cannot drift on storage, keys, the standalone gate, or failure copy.

export { copyFor, FAILURE_COPY, STATE_COPY, USER_FACING_CODES, type FailureCopy, type UserFacingCode } from './errors.ts';
export { button, card, element, mount, qrImage, render, row, STYLES, text } from './ui.ts';
export { formatAmount, formatSol, parseAmount, shortAddress } from './format.ts';
export { needsRetype, PAYER_PER_PAYMENT_CAP, PAYER_RETYPE_THRESHOLD, theftExposure, withinPayerCap } from './limits.ts';
export { detectSigningPath, ensureSigningPath, hasIdentity, loadOrCreateIdentity, type Identity, type SigningPath } from './keys.ts';
export { canSignOffline, displayEnvironment, isStandalone, signingBlock, type DisplayEnvironment, type SigningBlock } from './standalone.ts';
export {
  assessLedger,
  clearEpochMarker,
  createIndexedDbStore,
  hasPoolState,
  POOL_EPOCH_KEY,
  POOL_STATE_PREFIX,
  readEpochMarker,
  requestPersistentStorage,
  writeEpochMarker,
  type LedgerState,
  type MarkerStorage,
} from './store.ts';
