import { createEvaluator, type EvaluableVersion } from '@form/logic';
import type { Answers, EvalMeta, EvalState, FieldError, IsoDate, IsoInstant, Locale } from '@form/schema';
import { normalizeAnswers, validateAnswers, type RawAnswers } from '@form/validation';

/** The calendar date of `now` in `timeZone` (what relative date bounds and age limits are measured from); UTC if the zone is unknown. */
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

export interface Checked {
  errors: FieldError[];
  /** The answers as the server evaluated them: defaults and calculations in, hidden, disabled and off-path answers out. */
  values: Answers;
  /** The whole server-scope evaluation: what is visible and required, the page path and the ending the answers reach. */
  state: EvalState;
}

/**
 * What the respondent's browser says about the page view, as the evaluator takes it (`EvalMeta`): the URL parameters a
 * hidden field captures, the address and referrer a context field records, the device a rule can test. All of it is
 * advisory, typed by the respondent, and used only to re-run what the browser ran.
 */
export interface ClientMeta {
  urlParams?: Readonly<Record<string, string>>;
  pageUrl?: string;
  referrer?: string;
  device?: 'desktop' | 'tablet' | 'mobile';
  embedOrigin?: string;
  userAgent?: string;
}

/**
 * Runs a respondent's answers through the same evaluation and validation the renderer ran (`@form/logic`,
 * `@form/validation`), against the stored version, at the instant `now` and with the page view's `client` details:
 * whatever the client claims, a required field that is shown must be there and every answer must fit its field. The
 * submit pipeline (`submit/pipeline.ts`) picks `now` (the session start, clamped to the day before the answers arrived)
 * and strips the answers the server owns; this is the part that keeps invalid or forged answers out of the store.
 */
export function checkAnswers(version: EvaluableVersion, versionId: string, raw: Record<string, unknown>, locale: string, now: Date, client: ClientMeta = {}): Checked {
  const instant = now.toISOString() as IsoInstant;
  const timeZone = version.definition.behavior.timeZone;
  const answers = normalizeAnswers(raw as RawAnswers);
  const meta: EvalMeta = {
    now: instant,
    timeZone,
    locale: locale as Locale,
    urlParams: client.urlParams ?? {},
    isPreview: false,
    shuffleSeed: `${versionId}:server`,
    ...(client.device !== undefined ? { device: client.device } : {}),
    ...(client.pageUrl !== undefined ? { pageUrl: client.pageUrl } : {}),
    ...(client.referrer !== undefined ? { referrer: client.referrer } : {}),
    ...(client.embedOrigin !== undefined ? { embedOrigin: client.embedOrigin } : {}),
    ...(client.userAgent !== undefined ? { userAgent: client.userAgent } : {}),
  };
  const state = createEvaluator(version, meta, 'server').evaluate(answers);
  const errors = validateAnswers(version, state, answers, { scope: 'submit', locale: locale as Locale, today: todayIn(instant, timeZone) });
  return { errors, values: state.values, state };
}

/** Every file reference (`fileId`) in a set of answers: uploads, and the PNG of a signature. */
export function fileRefsIn(answers: unknown): Array<{ fileId: string; sizeBytes?: unknown; sha256?: unknown }> {
  const refs: Array<{ fileId: string; sizeBytes?: unknown; sha256?: unknown }> = [];
  const walk = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > 12) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const rec = value as Record<string, unknown>;
    if (typeof rec['fileId'] === 'string') refs.push({ fileId: rec['fileId'], sizeBytes: rec['sizeBytes'], sha256: rec['sha256'] });
    for (const nested of Object.values(rec)) walk(nested, depth + 1);
  };
  walk(answers, 0);
  return refs;
}
