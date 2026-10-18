import type { SignatureAlg } from './common.ts';

export interface KeyContext {
  orgId: string;
}

/**
 * Wraps data-encryption keys and signs (architecture §2.6, §2.7). `ctx` is bound into the wrap, so
 * unwrapping under another org fails with PortError('integrity').
 *
 * Wire formats: `ed25519` public keys are 32 raw bytes, signatures 64 bytes; `es256` public keys are
 * 65-byte uncompressed SEC1 points, signatures 64-byte IEEE P1363 (r ‖ s).
 */
export interface KeyProvider {
  wrap(plaintextKey: Uint8Array, ctx: KeyContext): Promise<{ wrapped: Uint8Array; kekRef: string }>;
  unwrap(wrapped: Uint8Array, kekRef: string, ctx: KeyContext): Promise<Uint8Array>;
  /** Signing keys are app-held and KMS-wrapped by default (Ed25519); 'kms-native' keys use what the KMS supports (ES256 on Azure Key Vault). */
  sign(keyId: string, data: Uint8Array): Promise<{ alg: SignatureAlg; signature: Uint8Array }>;
  publicKey(keyId: string): Promise<{ alg: SignatureAlg; key: Uint8Array }>;
}
