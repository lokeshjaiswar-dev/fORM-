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
export function sessionMeta(version: RuntimeFormVersion, locale: Locale, mode: 'live' | 'preview', session: RendererSession, now: IsoInstant): EvalMeta {
  const meta: EvalMeta = {
    now,
    timeZone: version.definition.behavior.timeZone,
    locale,
    urlParams: session.urlParams ?? {},
    isPreview: mode === 'preview',
    shuffleSeed: session.shuffleSeed ?? `${version.versionId}:${now}`,
  };
  if (session.device) meta.device = session.device;
  if (session.pageUrl !== undefined) meta.pageUrl = session.pageUrl;
  if (session.referrer !== undefined) meta.referrer = session.referrer;
  if (session.embedOrigin !== undefined) meta.embedOrigin = session.embedOrigin;
  return meta;
}
