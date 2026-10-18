/* PII patterns of the save-as-template sanitiser (templates spec §5.3): email, Indian phone, PAN, Aadhaar, GSTIN. ASCII only. */

export const PII_KINDS = ['email', 'phone_in', 'pan', 'aadhaar', 'gstin'] as const;
export type PiiKind = (typeof PII_KINDS)[number];
export interface PiiMatch { kind: PiiKind; start: number; end: number }

const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

/** Verhoeff check (every Aadhaar number carries one), so random 12-digit numbers are not reported. */
export function verhoeffValid(digits: string): boolean {
  let c = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    c = D[c]?.[P[i % 8]?.[digit] ?? 0] ?? 0;
  }
  return c === 0;
}

const DETECTORS: ReadonlyArray<{ kind: PiiKind; pattern: RegExp; accept?: (match: string) => boolean }> = [
  /* Anchored on the left and bounded (RFC 5321 lengths), so a long run without '@' costs linear time, not quadratic. */
  { kind: 'email', pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,8}[A-Za-z]{2,63}/g },
  { kind: 'gstin', pattern: /(?<![0-9A-Za-z])[0-9]{2}[A-Za-z]{3}[ABCFGHLJPTabcfghljpt][A-Za-z][0-9]{4}[A-Za-z][1-9A-Za-z][Zz][0-9A-Za-z](?![0-9A-Za-z])/g },
  { kind: 'pan', pattern: /(?<![0-9A-Za-z])[A-Za-z]{3}[ABCFGHLJPTabcfghljpt][A-Za-z][0-9]{4}[A-Za-z](?![0-9A-Za-z])/g },
  {
    kind: 'aadhaar',
    pattern: /(?<![0-9])[2-9][0-9]{3}[ -]?[0-9]{4}[ -]?[0-9]{4}(?![0-9])/g,
    accept: (match) => verhoeffValid(match.replace(/[ -]/g, '')),
  },
  { kind: 'phone_in', pattern: /(?<![0-9+])(?:\(?(?:\+|00)?91\)?[ -]?|0)?[6-9][0-9]{4}[ -]?[0-9]{5}(?![0-9])/g },
];

/** PII in `text`, in order. A span found by an earlier detector (an email, a GSTIN) is not reported again (as a phone, a PAN). */
export function scanPii(text: string): PiiMatch[] {
  const found: PiiMatch[] = [];
  let rest = text;
  for (const { kind, pattern, accept } of DETECTORS) {
    const fresh: PiiMatch[] = [];
    for (const m of rest.matchAll(pattern)) {
      if (accept && !accept(m[0])) continue;
      fresh.push({ kind, start: m.index, end: m.index + m[0].length });
    }
    if (!fresh.length) continue;
    let masked = '';
    let at = 0;
    for (const f of fresh) {
      masked += rest.slice(at, f.start) + '\u0000'.repeat(f.end - f.start);
      at = f.end;
    }
    rest = masked + rest.slice(at);
    found.push(...fresh);
  }
  return found.sort((a, b) => a.start - b.start);
}
