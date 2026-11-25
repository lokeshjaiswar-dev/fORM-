import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of server-side lookups: the public proxy (`POST /v1/p/:slug/lookups|fields/...`) and the author's test
 * route. A closed form is the core `FORM_CLOSED`/`LIMIT_REACHED`, a locked one `PASSWORD_REQUIRED`, a superseded version
 * `VERSION_SUPERSEDED`, a throttled caller `RATE_LIMITED`; a credential or form of another org is the core `NOT_FOUND`.
 *
 * Every upstream failure is the one `REMOTE_UPSTREAM_FAILED`, whatever the cause (egress denied, timeout, size, non-2xx,
 * unparsable, credential open failure, host mismatch), so the proxy is no DNS or host oracle. The host and the reason go to
 * the server log; the query, the value, the rows and the credential never do.
 */
export const REMOTE_PROBLEMS = {
  // The lookup, field or version holds no such enabled target (a disabled lookup, another form's id, a dms_master lookup).
  REMOTE_NOT_FOUND: { status: 404, title: 'No such lookup' },
  REMOTE_UPSTREAM_FAILED: { status: 502, title: 'The lookup source did not answer' },
  // Egress or the credential store is not wired in this process.
  REMOTE_UNAVAILABLE: { status: 503, title: 'Lookups are not available' },
  // More than 4 upstream calls in flight for one form in this process; Retry-After 1.
  REMOTE_BUSY: { status: 503, title: 'Too many lookups at once' },
} as const satisfies Record<string, ProblemSpec>;
