import type { FormDefinition } from '@form/schema';

/*
 * What a stored response says about how it was made: `submissions.meta` (architecture §2.4). Every value that comes from
 * the page view is advisory (the respondent types it) and is stored in a form that cannot be abused later: an address
 * without its query string (which can hold tokens and prefilled personal data), a referrer reduced to its host, a device
 * from a closed list, times the server checked. Nothing here reads the clock: the caller passes the moment the answers
 * arrived.
 */

export type Device = 'desktop' | 'tablet' | 'mobile';

/** The page-view details a submit body may carry (`client` of `SubmissionRequest`), after the route's shape check. */
export interface ClientDetails {
  startedAt?: string | undefined;
  urlParams?: Record<string, string> | undefined;
  pageUrl?: string | undefined;
  referrer?: string | undefined;
  device?: Device | undefined;
  embedOrigin?: string | undefined;
}

/** How far before the answers arrived a session may claim to have started: a longer-lived page is evaluated as of this limit. */
export const MAX_SESSION_MS = 24 * 60 * 60 * 1000;

/**
 * The instant the answers are evaluated at (`EvalMeta.now`): the client's session start, clamped to between a day before
 * `receivedAt` and `receivedAt` itself (schema §19), so a client can neither evaluate the form in the future nor in
 * a past of its choosing, and a date rule is judged as it was when the respondent filled the form in. Without a
 * (parseable) start it is `receivedAt`.
 */
export function evaluationInstant(receivedAt: Date, startedAt: string | undefined): Date {
  if (startedAt === undefined) return receivedAt;
  const claimed = Date.parse(startedAt);
  if (!Number.isFinite(claimed)) return receivedAt;
  return new Date(Math.min(receivedAt.getTime(), Math.max(receivedAt.getTime() - MAX_SESSION_MS, claimed)));
}

/** `scheme://host/path` of an http(s) address, with no credentials, query or fragment; undefined for anything else. */
export function addressWithoutQuery(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  return `${url.origin}${url.pathname}`;
}

/** The host (with its port, if any) of an http(s) address; undefined for anything else. */
export function hostOf(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  try {
    const url = new URL(address);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : undefined;
  } catch {
    return undefined;
  }
}

export interface MetaInput {
  locale: string;
  client: ClientDetails | undefined;
  /** `evaluationInstant` of the same request: the session start the evaluation used, when the client said one. */
  startedAt: Date | undefined;
  receivedAt: Date;
  versionNumber: number;
}

/**
 * `{ locale, pageUrl, referrer, device, startedAt, durationMs, versionNumber }`; a key is left out when its source is
 * missing or unusable. `referrer` is the host only. `durationMs` is the time from the session start to the answers
 * arriving, so it is never negative and never more than a day.
 */
export function buildMeta(input: MetaInput): Record<string, unknown> {
  const pageUrl = addressWithoutQuery(input.client?.pageUrl);
  const referrer = hostOf(input.client?.referrer);
  return {
    locale: input.locale,
    ...(pageUrl !== undefined ? { pageUrl } : {}),
    ...(referrer !== undefined ? { referrer } : {}),
    ...(input.client?.device !== undefined ? { device: input.client.device } : {}),
    ...(input.startedAt !== undefined
      ? { startedAt: input.startedAt.toISOString(), durationMs: Math.max(0, input.receivedAt.getTime() - input.startedAt.getTime()) }
      : {}),
    versionNumber: input.versionNumber,
  };
}

/** Block types whose value the server makes: a respondent's word for them is never taken (see `withoutServerOwned`). */
const SERVER_OWNED: ReadonlySet<string> = new Set(['hidden', 'calculation', 'context', 'unique_id']);

/**
 * The answers for the blocks the respondent may answer: those of blocks the form has, without the ones whose value comes
 * from the server's own evaluation: a calculation, a context (address, referrer, language, ...), a unique ID, and a
 * hidden field, which captures a URL parameter or a fixed value the form defines. The evaluator fills them again from
 * the form and from the page-view details the route passes it; without this a respondent could write any value into a
 * hidden field that the URL did not set, which the evaluator keeps (it only overwrites a hidden field when its source
 * has a value). An id that is not a block of this form is dropped as well: it was never kept, and this keeps odd keys
 * (`__proto__`) out of everything after.
 */
export function withoutServerOwned(definition: FormDefinition, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [blockId, answer] of Object.entries(raw)) {
    if (!Object.hasOwn(definition.blocks, blockId)) continue;
    const block = definition.blocks[blockId as keyof FormDefinition['blocks']];
    if (block === undefined || SERVER_OWNED.has(block.type)) continue;
    out[blockId] = answer;
  }
  return out;
}
