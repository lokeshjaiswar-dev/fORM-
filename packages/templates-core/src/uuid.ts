import { sha1 } from '@noble/hashes/legacy.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = '0123456789abcdef';

/** The namespace that turns a seed which is not itself a UUID (any `Idempotency-Key`) into one. */
export const SEED_NAMESPACE = '5d0f3c2e-8a41-4b6d-9c27-1e4f7a903b58';

export const isUuid = (value: string): boolean => UUID.test(value);

/** ASCII-only lower-casing of a UUID (no host case tables). */
const lowerHex = (value: string): string => value.replace(/[A-F]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

function parse(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = HEX.indexOf(hex[2 * i] ?? '') * 16 + HEX.indexOf(hex[2 * i + 1] ?? '');
  return bytes;
}

function format(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
    const byte = bytes[i] ?? 0;
    out += (HEX[byte >> 4] ?? '') + (HEX[byte & 15] ?? '');
  }
  return out;
}

/** RFC 9562 version-5 UUID: SHA-1 over the namespace bytes and the UTF-8 name. Same bytes in every engine. */
export function uuidv5(namespace: string, name: string): string {
  const ns = lowerHex(namespace);
  if (!isUuid(ns)) throw new TypeError(`uuidv5 namespace '${namespace}' is not a UUID`);
  const nameBytes = utf8ToBytes(name);
  const input = new Uint8Array(16 + nameBytes.length);
  input.set(parse(ns));
  input.set(nameBytes, 16);
  const hash = sha1(input).slice(0, 16);
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  return format(hash);
}

/** A seed as a UUID namespace: a UUID seed is used as is, any other string is hashed into one. */
export const seedNamespace = (seed: string): string => (isUuid(lowerHex(seed)) ? lowerHex(seed) : uuidv5(SEED_NAMESPACE, seed));
