const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** FNV-1a, 64 bit, over the UTF-8 bytes of `text`; 16 lower-case hex digits. Pins option ids to option values. */
export function fnv1a64hex(text: string): string {
  let hash = OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/** The fORM- option id of a DMS option value (DESIGN section 1). */
export const optionIdOf = (value: string): string => `v${fnv1a64hex(value)}`;
