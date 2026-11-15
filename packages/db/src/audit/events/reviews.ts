import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of the approvals domain: review groups, review settings and the decisions on held responses (WP-2.33).
 * Spread into `AUDIT_EVENTS` by `../catalogue.ts`; add codes here, not there. List only codes something emits
 * (`catalogue.test.ts`), and none that another file already lists (`events.test.ts`).
 *
 * The setup writes are listed here (`review_group.*`, `review.settings_updated`); `review.opened`, `review.decided` and
 * `review.finalised` come with the tasks that emit them. The API appends them in the same transaction as the definer call;
 * the SQL definers append nothing.
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
} as const satisfies Record<string, AuditEventSpec>;
