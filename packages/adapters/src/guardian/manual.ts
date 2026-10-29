import { randomUUID } from 'node:crypto';
import { PortError, toIsoInstant, type GuardianVerifier } from '@form/ports';
import { checkStart, decide, orgRecord, type GuardianRecord, type GuardianStore } from './store.ts';

const METHOD = 'manual_document_review';

/** What a reviewer submits to `complete` after checking the guardian's documents. */
export interface ManualReviewPayload {
  decision: 'approve' | 'refuse';
  reviewerId: string;
  note?: string;
}

function parsePayload(p: unknown): ManualReviewPayload {
  if (typeof p !== 'object' || p === null) throw new PortError('invalid_argument', 'payload must be an object');
  const { decision, reviewerId, note } = p as Record<string, unknown>;
  if (decision !== 'approve' && decision !== 'refuse') throw new PortError('invalid_argument', "decision must be 'approve' or 'refuse'");
  if (typeof reviewerId !== 'string' || reviewerId.length === 0) throw new PortError('invalid_argument', 'reviewerId is required');
  if (note !== undefined && typeof note !== 'string') throw new PortError('invalid_argument', 'note must be a string');
  return note === undefined ? { decision, reviewerId } : { decision, reviewerId, note };
}

export interface ManualGuardianVerifier extends GuardianVerifier {
  /** The review queue for an org. */
  pending(orgId: string): Promise<GuardianRecord[]>;
}

/** CMP-13 `manual_document_review`: a trained reviewer checks the guardian's documents and decides. */
export function createManualGuardianVerifier(o: { store: GuardianStore; now?: () => Date }): ManualGuardianVerifier {
  const { store } = o;
  const now = o.now ?? (() => new Date());

  return {
    method: METHOD,

    async start(i) {
      checkStart(i);
      const verificationId = randomUUID();
      await store.insert({ verificationId, orgId: i.orgId, submissionId: i.submissionId, guardianEmail: i.guardianEmail, method: METHOD, state: 'pending', createdAt: toIsoInstant(now()) });
      return { verificationId, next: 'review_queue' };
    },

    async complete({ orgId, verificationId, payload }) {
      const review = await orgRecord(store, orgId, verificationId, METHOD);
      const p = parsePayload(payload);
      await decide(store, review, {
        state: p.decision === 'approve' ? 'approved' : 'refused',
        decidedBy: p.reviewerId,
        decidedAt: toIsoInstant(now()),
        ...(p.note !== undefined ? { note: p.note } : {}),
      });
      return { verified: p.decision === 'approve', evidenceRef: `${METHOD}:${verificationId}` };
    },

    pending: (orgId) => store.pending(orgId, METHOD),
  };
}
