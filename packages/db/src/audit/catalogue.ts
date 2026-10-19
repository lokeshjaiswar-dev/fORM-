import type { AuditOutcome } from '../schema/index.ts';

export interface AuditEventSpec {
  /** The outcomes this action is recorded with; `success` goes in the business transaction, the others detached. */
  outcomes: readonly AuditOutcome[];
  resourceType: string;
  description: string;
}

/**
 * Every audit action the platform emits (architecture §2.7). `audit.append()` accepts only these codes, and
 * `catalogue.test.ts` checks that each emitting call site names one and that each entry is emitted somewhere.
 * Later work packages add their codes here (auth, membership, publish, FormOps, DSR, templates, …).
 */
export const AUDIT_EVENTS = {
  'request.authorize': {
    outcomes: ['denied'],
    resourceType: 'route',
    description: 'An API request was refused with 403: the caller is not a member of the org, or lacks the permission.',
  },
  'request.failed': {
    outcomes: ['error'],
    resourceType: 'route',
    description: 'An API request failed with a 5xx; the problem code is the reason.',
  },
  'job.rejected': {
    outcomes: ['denied'],
    resourceType: 'job',
    description: 'A job envelope failed verification (signature, scope, org re-derivation) and was dead-lettered unrun.',
  },
  'system.heartbeat': {
    outcomes: ['success'],
    resourceType: 'org',
    description: 'The worker made one round trip inside the tenant.',
  },
  'audit.verified': {
    outcomes: ['success', 'error'],
    resourceType: 'audit_chain',
    description: 'audit.verify checked the chain (hashes, links, head, checkpoint signatures); error names the first problem.',
  },
  'audit.archived': {
    outcomes: ['success'],
    resourceType: 'audit_chain',
    description: 'audit.archive exported one month of the chain to the audit bucket before the partition is detached.',
  },
  'submission.viewed': {
    outcomes: ['success'],
    resourceType: 'submission',
    description: 'A submission detail view (C-M9: every read, for every form).',
  },
  'submission.page_viewed': {
    outcomes: ['success'],
    resourceType: 'form',
    description: 'One page of the submissions grid, coalesced: the ids shown, never the values.',
  },
  'submission.api_read': {
    outcomes: ['success'],
    resourceType: 'submission',
    description: 'Submissions read through the API.',
  },
  'submission.revealed': {
    outcomes: ['success'],
    resourceType: 'submission',
    description: 'Masked sensitive values revealed (reveal=1); the field ids, never the values.',
  },
  'submission.exported': {
    outcomes: ['success'],
    resourceType: 'export',
    description: 'A submissions export was requested; includeSensitive needs a reason.',
  },
  'file.downloaded': {
    outcomes: ['success'],
    resourceType: 'file',
    description: 'A file attached to a submission was downloaded.',
  },
} as const satisfies Record<string, AuditEventSpec>;

export type AuditAction = keyof typeof AUDIT_EVENTS;

export const AUDIT_ACTIONS = Object.keys(AUDIT_EVENTS) as AuditAction[];

export function isAuditAction(v: unknown): v is AuditAction {
  return typeof v === 'string' && Object.hasOwn(AUDIT_EVENTS, v);
}
