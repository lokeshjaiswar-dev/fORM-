import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the exports domain: requesting, polling and downloading a submissions export (WP-1.17). Spread into
 * `PROBLEMS` by `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 *
 * A missing `Idempotency-Key` is the generic 400 `VALIDATION_FAILED` (it is a header the route's schema requires), and a
 * form or export of another org is the generic 404 `NOT_FOUND`.
 */
export const EXPORTS_PROBLEMS = {
  /** `includeSensitive` was asked for without a reason that says why: the reason is what the audit record and the exports row keep. */
  EXPORT_REASON_REQUIRED: { status: 422, title: 'Say why sensitive fields are included' },
  /** The `Idempotency-Key` already belongs to another export (other form, format, scope, options or requester): a retry sends the same body, so this is a mistake. */
  EXPORT_KEY_REUSED: { status: 422, title: 'That Idempotency-Key was used for a different export' },
  /** Ten exports are queued or running for the org, or a hundred were asked for in the last day. `Retry-After` says when to ask again. */
  EXPORT_QUOTA_REACHED: { status: 429, title: 'Too many exports at once or today' },
  /** The file is not built yet (`queued` or `running`): poll `GET /v1/exports/:id` and download when it is `ready`. */
  EXPORT_NOT_READY: { status: 409, title: 'The export is not ready yet' },
  /** The build failed: there is no file to download, and a new export is a new request. */
  EXPORT_FAILED: { status: 409, title: 'The export failed, so there is no file' },
  /** The file was kept for 24 hours and is gone (or the object store no longer has it): ask for a new export. */
  EXPORT_EXPIRED: { status: 410, title: 'The export has expired' },
} as const satisfies Record<string, ProblemSpec>;
