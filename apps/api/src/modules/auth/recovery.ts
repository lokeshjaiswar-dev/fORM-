import { randomBytes } from 'node:crypto';
import { hex, sha256 } from './crypto.ts';

/** Crockford base32 without the look-alikes I, L, O and U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_CODE_COUNT = 10;

/** `XXXX-XXXX-XXXX-XXXX`: 80 random bits, so a plain SHA-256 is enough to store it. */
function newCode(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += ALPHABET[bytes[i]! & 31];
  }
  return out;
}

/** Upper case, no separators or spaces, look-alikes mapped (O → 0, I and L → 1). */
export function normaliseRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export const RECOVERY_CODE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

export function hashRecoveryCode(code: string): string {
  return hex(sha256(`fr:recovery:v1:${normaliseRecoveryCode(code)}`));
}

/** Ten new codes, shown once, and the hashes that are stored. */
export function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newCode);
  return { codes, hashes: codes.map(hashRecoveryCode) };
}
