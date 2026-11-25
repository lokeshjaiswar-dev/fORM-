import type { ProblemSpec } from './spec.ts';

/**
 * Problem codes of the webhooks domain: a form's webhook settings and its delivery log (WP-1.18). Spread into `PROBLEMS`
 * by `../errors.ts`; add codes here, not there. A code appears in one file only (`problems.test.ts`).
 *
 * A request without `data.route` is the core `FORBIDDEN` (the route's `perm` check, audited as `request.authorize`); a
 * webhook, a form or a delivery of another org is the core `NOT_FOUND`, because row-level security makes them not exist.
 */
export const WEBHOOKS_PROBLEMS = {
  // `MISSING_PURPOSE` (422) is answered here too: sending answers to an outside address is a disclosure (CONTRIBUTING §5,
  // rule 6), so a webhook must name the purposes it serves, each one the form's draft declares. The code is listed once, in
  // `notifications.ts`, because a code appears in one file only; the route's own message says which purpose is the problem.
  // The URL fails the edition's egress policy: a scheme the deployment does not allow, a host that is not on the
  // allowlist, or an address that is private, loopback or link-local (the cloud metadata address among them).
  EGRESS_DENIED: { status: 422, title: 'That address cannot be reached from this installation' },
  // The custom body is not usable: a path that is not names, dots and [], a path that is both a value and a parent, a bad XML root.
  INVALID_PAYLOAD_MAPPING: { status: 422, title: 'The payload mapping is not valid' },
  // PUT .../webhooks/:id without If-Match: a save that does not say which revision it read would overwrite blindly.
  WEBHOOK_REV_REQUIRED: { status: 428, title: 'Send the revision you read in If-Match' },
  // PUT .../webhooks/:id named a revision that is no longer the stored one: someone else saved first, so reload and merge.
  WEBHOOK_REV_CONFLICT: { status: 409, title: 'The webhook changed since it was read' },
  // A replay sends to the webhook, so it needs a webhook that is switched on (a webhook the worker switched off after
  // repeated failures is switched on again by saving it).
  WEBHOOK_DISABLED: { status: 409, title: 'The webhook is switched off' },
  // A replay of a delivery whose response is in the trash: a trashed response is not sent to anyone. Restore it first.
  WEBHOOK_RESPONSE_TRASHED: { status: 409, title: 'The response is in the trash' },
} as const satisfies Record<string, ProblemSpec>;
