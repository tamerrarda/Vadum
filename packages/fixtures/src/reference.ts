// The reference implementations behind the fixtures, exported for tooling that must agree with them
// byte for byte (tools/phase0). Not an SDK: Streams A, B and C build from the specs and must never
// import this — code tested against a copy of its own reference proves nothing (D33).

export {
  buildMessage,
  deriveAta,
  deriveNonceAddress,
  tokenProgramAddress,
  type CanonicalInput,
  type Intent,
  type Lifetime,
  type NonceRef,
  type TokenProgram,
} from './canonical.ts';
export { check, encodeAuth, encodeIntent, encodeNonceReturn, encodeStaticIntent, FLAG, Reject, TYPE } from './wire.ts';
export { Base45Error, fromBase45, toBase45 } from './base45.ts';
export { bytesEqual, toBase58, toBase64 } from './bytes.ts';
export { nonceReturnSigningBytes, signNonceReturn } from './nonce-return.ts';
