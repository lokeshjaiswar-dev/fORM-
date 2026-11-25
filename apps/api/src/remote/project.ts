import type { ChoiceOption } from '@form/schema';

/** Caps of the options route's answer: at most 500 options, ids and codes of 200 characters, labels of 500. */
export const OPTION_LIMITS = { count: 500, id: 200, label: 500 } as const;

export interface PublicOption {
  id: string;
  label: string;
  code?: string;
}

/**
 * An upstream option list as the respondent gets it: at most 500 options, each id, code and label clipped, so one call costs
 * at most about 0.4 MB however long the upstream's strings are. An option whose id is empty after clipping is dropped.
 */
export function publicOptions(options: readonly ChoiceOption[]): PublicOption[] {
  const out: PublicOption[] = [];
  for (const o of options) {
    if (out.length >= OPTION_LIMITS.count) break;
    const id = String(o.id).slice(0, OPTION_LIMITS.id);
    if (id === '') continue;
    const label = typeof o.label === 'string' ? o.label.slice(0, OPTION_LIMITS.label) : '';
    const code = (o as { code?: unknown }).code;
    out.push({ id, label, ...(typeof code === 'string' ? { code: code.slice(0, OPTION_LIMITS.id) } : {}) });
  }
  return out;
}

/**
 * The cache key of a lookup answer. Without `searchParam` the server filters the list itself, case-insensitively, so casing
 * does not change the answer and is folded; with it the upstream does the search and may be case-sensitive, so 'MAYA' and
 * 'maya' are different answers.
 */
export function lookupCacheKey(versionId: string, lookupId: string, q: string, searchParam: string | undefined): string {
  const term = q.normalize('NFC').trim();
  return `${versionId}|${lookupId}|${searchParam === undefined ? term.toLowerCase() : term}`;
}
