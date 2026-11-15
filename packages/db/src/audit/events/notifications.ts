import type { AuditEventSpec } from './spec.ts';

/**
 * Audit actions of the notifications domain: org email senders and the notifications of a form (WP-1.16). Spread into
 * `AUDIT_EVENTS` by `../catalogue.ts`; add codes here, not there. List only codes something emits (`catalogue.test.ts`),
 * and none that another file already lists (`events.test.ts`).
 *
 * A record names ids, counts and the keys that changed. It never holds a recipient's address, a sender's SMTP URL or
 * credentials, a subject or a body, so the chain can be read by someone who may not read the answers.
 */
export const NOTIFICATIONS_EVENTS = {
  'notification.saved': {
    outcomes: ['success'],
    resourceType: 'notification',
    description:
      "A form's notification was created or saved (`change` is `created` or `updated`); the metadata names the keys of the notification that changed, its kind, trigger and revision, how many recipients and purposes it has and whether any recipient is outside the people who may read answers. Never an address, a subject or a body.",
  },
  'notification.deleted': {
    outcomes: ['success'],
    resourceType: 'notification',
    description: "A form's notification was deleted; the metadata holds its kind and trigger, never its recipients or text.",
  },
  'email_sender.saved': {
    outcomes: ['success'],
    resourceType: 'email_sender',
    description:
      'An org email sender was created or changed (`change` is `created` or `updated`); the metadata names the keys that changed (`name`, `fromAddress`, `fromName`, `smtpUrl`), never the address or the SMTP URL.',
  },
  'email_sender.deleted': {
    outcomes: ['success'],
    resourceType: 'email_sender',
    description: 'An org email sender and its sealed SMTP credentials were deleted.',
  },
  'email_sender.tested': {
    outcomes: ['success'],
    resourceType: 'email_sender',
    description:
      'A test message was sent through an org email sender to the caller\'s own address; `ok` says whether the server accepted it and `verified` whether the sender is now marked verified. The error text is stored on the sender, scrubbed, and is not in the record.',
  },
} as const satisfies Record<string, AuditEventSpec>;
