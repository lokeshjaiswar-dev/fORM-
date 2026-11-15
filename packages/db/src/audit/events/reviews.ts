import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of the approvals domain: review groups, review settings and the decisions on held responses (WP-2.33).
 * Spread into `AUDIT_EVENTS` by `../catalogue.ts`; add codes here, not there. List only codes something emits
 * (`catalogue.test.ts`), and none that another file already lists (`events.test.ts`).
 *
 * The setup writes are listed here (`review_group.*`, `review.settings_updated`) and the three that follow a held response:
 * `review.opened` (at submit), `review.decided` (a checker's decision, or a refusal of one) and `review.finalised` (the
 * decision that made the response `complete` or `rejected`). The API appends the successes in the same transaction as the
 * definer call and writes each refusal as a denied `review.decided` on the separate audit connection; the SQL definers
 * append nothing.
 */
export const REVIEWS_EVENTS = {
  'review_group.created': {
    outcomes: ['success'],
    resourceType: 'review_group',
    description: 'A review group (a named set of checkers) was created; the metadata holds its name.',
  },
  'review_group.updated': {
    outcomes: ['success'],
    resourceType: 'review_group',
    description: 'A review group was renamed, archived or brought back; the metadata names the keys that changed (`name`, `archived`) and the name it has now.',
  },
  'review_group.member_added': {
    outcomes: ['success'],
    resourceType: 'review_group',
    description: 'A member was added to a review group (the member is the `userId` in the metadata), which lets them check the units assigned to that group.',
  },
  'review_group.member_removed': {
    outcomes: ['success'],
    resourceType: 'review_group',
    description: 'A member was taken out of a review group (the member is the `userId` in the metadata); units assigned to the group are no longer theirs to check.',
  },
  'review.settings_updated': {
    outcomes: ['success'],
    resourceType: 'form',
    description: "A form's review settings were saved (which units are reviewed, by which group, in which order); the metadata names the keys that changed and the new revision, never an answer.",
  },
  'review.opened': {
    outcomes: ['success'],
    resourceType: 'submission',
    description:
      'A response was held for review when it was submitted (status pending_review) and its review units were opened; the metadata counts the units, how many wait for a checker and how many members the respondent’s own address kept from checking it, never an answer or an address.',
  },
  'review.decided': {
    outcomes: ['success', 'denied'],
    resourceType: 'submission',
    description:
      'A checker approved or rejected one review unit of a held response (success: the metadata holds the unit id, the decision, the reason code from the fixed catalogue, the round and the decision id, never an answer), or a decision was refused (denied: the reason is the refusal, such as four_eyes_violation, not_in_review_group, mfa_required, review_stale, review_order_blocked, review_closed or idempotency_key_reused).',
  },
  'review.finalised': {
    outcomes: ['success'],
    resourceType: 'submission',
    description:
      'A decision settled a held response: every required unit was approved (status complete, and the response is released to its notifications and webhooks) or a required unit was rejected (status rejected); the metadata holds the status, the unit and the decision that settled it.',
  },
} as const satisfies Record<string, AuditEventSpec>;
