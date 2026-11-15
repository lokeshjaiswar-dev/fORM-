import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of the approvals domain: review groups, review settings and the decisions on held responses (WP-2.33).
 * Spread into `AUDIT_EVENTS` by `../catalogue.ts`; add codes here, not there. List only codes something emits
 * (`catalogue.test.ts`), and none that another file already lists (`events.test.ts`).
 *
 * The setup writes are listed here (`review_group.*`, `review.settings_updated`) and so is `review.opened`, the first of the
 * three that follow a held response; `review.decided` and `review.finalised` come with the task that emits them. The API
 * appends them in the same transaction as the definer call; the SQL definers append nothing.
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
} as const satisfies Record<string, AuditEventSpec>;
