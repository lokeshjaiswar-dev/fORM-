import { jsonPointer, type FormDefinition, type PlainTemplate } from '@form/schema';
import type { PipelineIssue } from './issues.ts';

/*
 * `form_access.redirect_allowlist` (WP-1.07, ACC-08): the hosts an org lets a form send its respondents to. Null means
 * no list was set and nothing is checked; an empty list means no redirect is allowed. The check is on the host the
 * address names in its fixed text, because that is all publish can know: a piped answer is filled in at run time.
 */

/** Characters that end the authority (user, host and port) of a URL; `\` counts because browsers read it as `/`. */
const AUTHORITY_END = /[/?#\\]/;
const SCHEME = /^https?:\/\//i;

/** The literal text a template starts with, and whether it is all literal (no pipe or variable anywhere). */
function literalPrefix(template: PlainTemplate): { prefix: string; fixed: boolean } {
  let prefix = '';
  for (const part of template) {
    if (typeof part !== 'string') return { prefix, fixed: false };
    prefix += part;
  }
  return { prefix, fixed: true };
}

/** The lower-case ASCII host of a URL authority (punycode for an international name), or null when it is not a host. */
function hostOf(authority: string): string | null {
  try {
    const host = new URL(`https://${authority}`).hostname.replace(/\.$/, '');
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/** An allowlist entry (`example.com`, `Example.COM.`, `https://example.com/`) as the host a URL would parse to. */
function allowedHost(entry: string): string {
  const trimmed = entry.trim().replace(SCHEME, '');
  return hostOf(trimmed.split(AUTHORITY_END)[0] ?? trimmed) ?? trimmed.toLowerCase();
}

/**
 * Why the template's address is not on `allowed`, or null when it is (or when the address is not for this check: an
 * empty template or one that is not http(s), which `validateStructure` already refuses as `invalid_url_scheme`).
 */
function problemWith(template: PlainTemplate, allowed: ReadonlySet<string>): string | null {
  const { prefix, fixed } = literalPrefix(template);
  if (!SCHEME.test(prefix)) return null;
  const rest = prefix.replace(SCHEME, '');
  const end = rest.search(AUTHORITY_END);
  // A pipe or variable before the host ends can put anything in it (`https://{answer}.example.com`, `https://example.com{answer}`).
  if (end === -1 && !fixed) return 'the address must name its host in fixed text, ending with / or ? before the first piped answer';
  const host = hostOf(end === -1 ? rest : rest.slice(0, end));
  if (host === null) return 'the address does not name a valid host';
  if (allowed.has(host)) return null;
  const shown = host.length > 80 ? `${host.slice(0, 80)}…` : host;
  return allowed.size === 0
    ? "this form's redirect allowlist is empty, so it may not send respondents anywhere"
    : `'${shown}' is not on this form's redirect allowlist`;
}

/**
 * `redirect_not_allowed` for every address a form can send a respondent to: a redirect ending, a `visit_url` button of
 * an ending, and the translations of an ending's URL (`ending:<id>:url`), which would otherwise be a way round the
 * list. Paths are the ones `validateStructure` uses for the same addresses.
 */
export function redirectIssues(def: FormDefinition, allowlist: readonly string[] | null): PipelineIssue[] {
  if (allowlist === null) return [];
  const allowed = new Set(allowlist.map(allowedHost));
  const issues: PipelineIssue[] = [];
  const check = (template: PlainTemplate, path: string) => {
    const message = problemWith(template, allowed);
    if (message !== null) issues.push({ severity: 'error', code: 'redirect_not_allowed', path, message });
  };
  def.endings.forEach((ending, i) => {
    if (ending.kind === 'redirect') check(ending.url, jsonPointer('endings', i, 'url'));
    else {
      ending.actions.forEach((action, j) => {
        if (action.kind === 'visit_url') check(action.url, jsonPointer('endings', i, 'actions', j, 'url'));
      });
    }
  });
  for (const [locale, entries] of Object.entries(def.i18n.messages)) {
    for (const [key, entry] of Object.entries(entries ?? {})) {
      if (!key.startsWith('ending:') || !key.endsWith(':url') || !entry) continue;
      const value: unknown = entry.value;
      const template = typeof value === 'string' ? [value] : Array.isArray(value) ? (value as PlainTemplate) : null;
      if (template) check(template, jsonPointer('i18n', 'messages', locale, key, 'value'));
    }
  }
  return issues;
}
