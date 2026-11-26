import type { HandoffEnv } from './handoff';

/*
 * The one reader of this build's launch configuration (`import.meta.env`) and of this page's origin. Everything else takes a
 * `HandoffEnv` so tests can pass their own.
 */

const list = (raw: unknown): string[] =>
  typeof raw === 'string'
    ? raw
        .split(',')
        .map((s) => s.trim().replace(/\/+$/, ''))
        .filter(Boolean)
    : [];

/** An http(s) URL with no credentials, or null. A root-relative path resolves against `origin` (the dev rewrite on the DMS host). */
export function absoluteUrl(raw: string, origin: string): URL | null {
  try {
    const full = /^\/(?!\/)/.test(raw) ? new URL(raw, origin).toString() : raw;
    const url = new URL(full);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username !== '' || url.password !== '') return null;
    return url;
  } catch {
    return null;
  }
}

/** `origin + path`, no trailing slash: the form API bases are compared in. */
export const normalBase = (url: URL): string => `${url.origin}${url.pathname}`.replace(/\/+$/, '');

export function readHandoffEnv(): HandoffEnv {
  const env = import.meta.env as Record<string, string | undefined>;
  const origin = globalThis.location?.origin ?? '';
  return {
    origin,
    returnOrigins: list(env.VITE_FP_RETURN_ORIGINS),
    apiBases: list(env.VITE_FP_DMS_API_BASE).flatMap((b) => {
      const url = absoluteUrl(b, origin);
      return url && url.search === '' && url.hash === '' ? [normalBase(url)] : [];
    }),
    devOverrides: env.VITE_FP_DEV_OVERRIDES === '1',
    legacyDescriptor: env.VITE_FP_LEGACY_DESCRIPTOR === '1',
  };
}
