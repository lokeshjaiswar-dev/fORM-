import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import canonicalize from 'canonicalize';
import type { Sha256Hex } from './v2/ids.ts';

/**
 * RFC 8785 (JCS) canonical JSON. Throws for anything JSON cannot carry exactly: a root that
 * serialises to nothing (undefined, a function), NaN or ±Infinity, cycles and lone surrogates.
 */
export function canonicalJson(value: unknown): string {
  const json = canonicalize(value);
  if (json === undefined) throw new TypeError('value has no JSON representation');
  return json;
}

/** sha256 over the UTF-8 bytes of the JCS form, lowercase hex. Isomorphic and synchronous. */
export function sha256Jcs(value: unknown): Sha256Hex {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(value)))) as Sha256Hex;
}

/** `contentHash(x) = sha256(JCS(x))`: FormVersion.contentHash, payload hashes, notice hashes. */
export const contentHash = sha256Jcs;
