// @vadum/core — the public API specified in plan/22-SPEC-core-api.md.

export type * from './types.ts';
export { VADUM_ERROR_CODES, VadumError, type VadumErrorCode } from './errors.ts';
export { deriveAta, deriveNonceAddress, nonceSeed, tokenProgramAddress } from './derive.ts';
export { buildMessage } from './canonical.ts';
export { assertCanonical, assertMintCompatible, evaluateMint } from './validate.ts';
export { buildWireTransaction, signAsPayer, verifyAuth } from './sign.ts';
export {
  NONCE_RETURN_DOMAIN,
  nonceReturnSigningBytes,
  signNonceReturn,
  verifyNonceReturn,
  type NonceReturnStatement,
} from './nonce-return.ts';
export { durableNonceProvider, freshBlockhashProvider, type NonceProvider } from './nonce-provider.ts';
