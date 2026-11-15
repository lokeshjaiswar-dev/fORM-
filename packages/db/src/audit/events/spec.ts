import type { AuditOutcome } from '../../schema/index.ts';

export interface AuditEventSpec {
  /** The outcomes this action is recorded with; `success` goes in the business transaction, the others detached. */
  outcomes: readonly AuditOutcome[];
  resourceType: string;
  description: string;
}
