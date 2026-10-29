import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { hash, verify } from '@node-rs/argon2';
import { DENYLIST_GZIP } from './denylist.data.ts';

/** argon2id, m = 64 MiB, t = 3, p = 1 (architecture §2.4). */
const ARGON2 = { memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const;

export const PASSWORD_MIN_LENGTH = 8;
/** Long enough for any passphrase, short enough that hashing stays bounded. */
export const PASSWORD_MAX_LENGTH = 128;

export function hashPassword(password: string): Promise<string> {
  return hash(password.normalize('NFC'), ARGON2);
}

/** Verified against when there is no stored hash, so an unknown address costs the same as a wrong password. */
let dummyHash: Promise<string> | undefined;

/** False for a missing hash too, after the same amount of work. */
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  const target = stored ?? (await (dummyHash ??= hashPassword('fr-dummy-password-for-timing')));
  try {
    const ok = await verify(target, password.normalize('NFC'));
    return stored !== null && ok;
  } catch {
    return false;
  }
}

let denylist: Set<string> | undefined;

/** The local common-password list (NCSC top 100k), checked in every edition. */
export function isCommonPassword(password: string): boolean {
  denylist ??= new Set(gunzipSync(Buffer.from(DENYLIST_GZIP, 'base64')).toString('utf8').split('\n'));
  return denylist.has(password.normalize('NFC').toLowerCase());
}

/** Have I Been Pwned range lookup (k-anonymity): true when the password appeared in a breach. */
export type BreachCheck = (password: string) => Promise<boolean>;

export type PasswordProblem = 'too_short' | 'too_long' | 'common' | 'personal' | 'breached';

export const PASSWORD_PROBLEMS: Record<PasswordProblem, string> = {
  too_short: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  too_long: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
  common: 'This password is too common. Choose one that is harder to guess.',
  personal: 'The password must not be your email address.',
  breached: 'This password has appeared in a data breach. Choose a different one.',
};

/** NIST SP 800-63B style: length, a common-password list and, on SaaS, known breaches. No composition rules. */
export async function passwordProblem(password: string, o: { email: string; breached?: BreachCheck | undefined }): Promise<PasswordProblem | null> {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (length > PASSWORD_MAX_LENGTH) return 'too_long';
  const lower = password.toLowerCase();
  const email = o.email.toLowerCase();
  if (lower === email || lower === email.slice(0, email.lastIndexOf('@'))) return 'personal';
  if (isCommonPassword(password)) return 'common';
  if (o.breached && (await o.breached(password))) return 'breached';
  return null;
}

/**
 * HIBP Pwned Passwords over k-anonymity: only the first 5 hex characters of the SHA-1 leave the server, with
 * response padding. SaaS only (it needs egress); a failed lookup does not block the user, it is logged.
 */
export function hibpBreachCheck(o: { fetch?: typeof fetch; timeoutMs?: number; onError?: (err: unknown) => void } = {}): BreachCheck {
  const fetcher = o.fetch ?? fetch;
  return async (password) => {
    const sha1 = createHash('sha1').update(password.normalize('NFC')).digest('hex').toUpperCase();
    try {
      const res = await fetcher(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, {
        headers: { 'add-padding': 'true', 'user-agent': 'fORM-' },
        signal: AbortSignal.timeout(o.timeoutMs ?? 2000),
      });
      if (!res.ok) throw new Error(`HIBP answered ${res.status}`);
      const suffix = sha1.slice(5);
      for (const line of (await res.text()).split('\n')) {
        const [s, count] = line.trim().split(':');
        if (s === suffix && Number(count) > 0) return true;
      }
      return false;
    } catch (err) {
      o.onError?.(err);
      return false;
    }
  };
}
