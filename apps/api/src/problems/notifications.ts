import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the notifications domain: org email senders and the notifications of a form (WP-1.16). Spread into
 * `PROBLEMS` by `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 */
export const NOTIFICATIONS_PROBLEMS = {
  // A sender that a notification still sends from cannot be deleted: the notification would silently change its From address.
  EMAIL_SENDER_IN_USE: { status: 409, title: 'A notification still uses that email sender' },
  // The test send finished after the sender was edited, so its result says nothing about the credentials now stored.
  EMAIL_SENDER_CHANGED: { status: 409, title: 'The email sender changed while it was being tested' },
} as const satisfies Record<string, ProblemSpec>;
