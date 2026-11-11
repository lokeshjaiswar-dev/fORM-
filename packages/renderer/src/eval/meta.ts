import type { EvalMeta, IsoDate, IsoInstant, Locale, RuntimeFormVersion } from '@form/schema';
import type { RendererSession } from '../types.ts';

/** The calendar date of `now` in `timeZone` (validation's `today`); the UTC date when the zone is unknown. */
export function todayIn(now: IsoInstant, timeZone: string): IsoDate {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date as IsoDate;
  } catch {
    /* An unknown zone falls through to UTC. */
  }
  return now.slice(0, 10) as IsoDate;
}

/**
 * EvalMeta for one session: `now` is the session start, frozen until the session ends (schema §19). The shuffle seed
 * is per session (PROP-11): the version and the session start, so server and client agree whenever `startedAt` is passed.
 */
function fromWindow(): { pageUrl?: string; referrer?: string; userAgent?: string; embedOrigin?: string; urlParams: Record<string, string> } {
  if (typeof window === 'undefined' || typeof document === 'undefined') return { urlParams: {} };
  const urlParams: Record<string, string> = {};
  new URLSearchParams(window.location.search).forEach((value, key) => {
    urlParams[key] = value;
  });
  const env: { pageUrl?: string; referrer?: string; userAgent?: string; embedOrigin?: string; urlParams: Record<string, string> } = {
    urlParams,
    pageUrl: window.location.href,
  };
  if (document.referrer) env.referrer = document.referrer;
  if (typeof navigator !== 'undefined' && navigator.userAgent) env.userAgent = navigator.userAgent;
  const ancestors = window.location.ancestorOrigins;
  if (window.parent !== window && ancestors && ancestors.length > 0) env.embedOrigin = ancestors[0];
  return env;
}

export function sessionMeta(version: RuntimeFormVersion, locale: Locale, mode: 'live' | 'preview', session: RendererSession, now: IsoInstant): EvalMeta {
  const env = fromWindow();
  const meta: EvalMeta = {
    now,
    timeZone: version.definition.behavior.timeZone,
    locale,
    urlParams: { ...env.urlParams, ...session.urlParams },
    isPreview: mode === 'preview',
    shuffleSeed: session.shuffleSeed ?? `${version.versionId}:${now}`,
  };
  if (session.device) meta.device = session.device;
  const pageUrl = session.pageUrl ?? env.pageUrl;
  const referrer = session.referrer ?? env.referrer;
  const embedOrigin = session.embedOrigin ?? env.embedOrigin;
  const userAgent = session.userAgent ?? env.userAgent;
  if (pageUrl !== undefined) meta.pageUrl = pageUrl;
  if (referrer !== undefined) meta.referrer = referrer;
  if (embedOrigin !== undefined) meta.embedOrigin = embedOrigin;
  if (userAgent !== undefined) meta.userAgent = userAgent;
  return meta;
}
