import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the notifications domain: org email senders and the notifications of a form (WP-1.16). Spread into
 * `PROBLEMS` by `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 *
 * A caller who lacks `data.route` for a recipient gets `DATA_ROUTE_FORBIDDEN` (a core code, 403): it is the same refusal
 * every route that routes answers to outside people makes, so it lives in `errors.ts`.
 */
export const NOTIFICATIONS_PROBLEMS = {
  // The body is not a NotificationConfig (the strict twin refused it): the field issues carry the paths, like DRAFT_INVALID.
  NOTIFICATION_INVALID: { status: 422, title: 'The notification is not valid' },
  // purposeIds is empty, or names a purpose the form's draft does not declare in privacy.purposes. A notification with no
  // purpose would send every field, which the purpose filter exists to stop, so nothing is written.
  MISSING_PURPOSE: { status: 422, title: 'Name at least one purpose that this form declares' },
  // `senderId` is not one of this org's email senders (RLS makes another org's sender look exactly like one that never existed).
  SENDER_NOT_FOUND: { status: 422, title: 'That email sender is not in this organisation' },
  // A `member` recipient is not an active member of this org (or not a member id at all).
  RECIPIENT_NOT_FOUND: { status: 422, title: 'A recipient is not a member of this organisation' },
  // PUT without If-Match: a save that does not say which revision it read would overwrite blindly.
  NOTIFICATION_REV_REQUIRED: { status: 428, title: 'Send the revision you read in If-Match' },
  // PUT named a revision that is no longer the stored one: someone else saved first, so reload and apply the change again.
  NOTIFICATION_REV_CONFLICT: { status: 409, title: 'The notification changed since it was read' },
  // A sender that a notification still sends from cannot be deleted: the notification would silently change its From address.
  EMAIL_SENDER_IN_USE: { status: 409, title: 'A notification still uses that email sender' },
  // The test send finished after the sender was edited, so its result says nothing about the credentials now stored.
  EMAIL_SENDER_CHANGED: { status: 409, title: 'The email sender changed while it was being tested' },
} as const satisfies Record<string, ProblemSpec>;
