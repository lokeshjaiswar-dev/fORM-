import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the access domain: a form's access settings and the password unlock (WP-1.07). Spread into
 * `PROBLEMS` by `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 */
export const ACCESS_PROBLEMS = {
  /** `PUT .../access` named a revision that is no longer the stored one: someone else saved first, so reload and merge. */
  ACCESS_REV_CONFLICT: { status: 409, title: 'The access settings changed since they were read' },
  /** `PUT .../access` without `If-Match`: a save that does not say which revision it read would overwrite blindly. */
  ACCESS_REV_REQUIRED: { status: 428, title: 'Send the revision you read in If-Match' },
  /** The slug is held by another form (its address or one it used to have), in this org or another. */
  FORM_SLUG_TAKEN: { status: 409, title: 'That address is already used by another form' },
  /**
   * The respondent's password was not accepted. One answer for a wrong password and for a form that has none, so the
   * answer does not say which forms are protected.
   */
  FORM_UNLOCK_FAILED: { status: 401, title: 'The password is not right' },
} as const satisfies Record<string, ProblemSpec>;
