import { randomUUID } from 'node:crypto';
import { PortError, toIsoInstant, type GuardianVerifier, type IsoInstant } from '@form/ports';

export interface ManualReview {
  verificationId: string;
  orgId: string;
  submissionId: string;
  guardianEmail: string;
  state: 'pending' | 'approved' | 'refused';
  createdAt: IsoInstant;
  decidedAt?: IsoInstant;
  reviewerId?: string;
  note?: string;
}

export type ManualReviewDecision = Required<Pick<ManualReview, 'decidedAt' | 'reviewerId'>> & {
  state: 'approved' | 'refused';
  note?: string;
};

/** Where reviews live; the database-backed store arrives with the guardian-consent flow (CMP-13). */
export interface ManualReviewStore {
  insert(r: ManualReview): Promise<void>;
  get(verificationId: string): Promise<ManualReview | undefined>;
  /** Applies the decision only while the review is pending; false when another reviewer got there first. */
  decide(verificationId: string, d: ManualReviewDecision): Promise<boolean>;
  pending(orgId: string): Promise<ManualReview[]>;
}

export function createMemoryReviewStore(): ManualReviewStore {
  const reviews = new Map<string, ManualReview>();
  return {
    async insert(r) {
      reviews.set(r.verificationId, { ...r });
    },
    async get(id) {
      const r = reviews.get(id);
      return r && { ...r };
    },
    async decide(id, d) {
      const r = reviews.get(id);
      if (r?.state !== 'pending') return false;
      reviews.set(id, { ...r, ...d });
      return true;
    },
    async pending(orgId) {
      return [...reviews.values()].filter((r) => r.orgId === orgId && r.state === 'pending').map((r) => ({ ...r }));
    },
  };
}

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
  pending(orgId: string): Promise<ManualReview[]>;
}

/** CMP-13 `manual_document_review`: a trained reviewer checks the guardian's documents and decides. */
export function createManualGuardianVerifier(o: { store?: ManualReviewStore; now?: () => Date } = {}): ManualGuardianVerifier {
  const store = o.store ?? createMemoryReviewStore();
  const now = o.now ?? (() => new Date());

  return {
    method: 'manual_document_review',

    async start(i) {
      if (i.orgId.length === 0 || i.submissionId.length === 0) throw new PortError('invalid_argument', 'orgId and submissionId are required');
      if (!/^[^\s@]+@[^\s@]+$/.test(i.guardianEmail)) throw new PortError('invalid_argument', 'a guardian email is required');
      const verificationId = randomUUID();
      await store.insert({ verificationId, orgId: i.orgId, submissionId: i.submissionId, guardianEmail: i.guardianEmail, state: 'pending', createdAt: toIsoInstant(now()) });
      return { verificationId, next: 'review_queue' };
    },

    async complete({ verificationId, payload }) {
      const review = await store.get(verificationId);
      if (!review) throw new PortError('not_found', `no verification ${verificationId}`);
      const p = parsePayload(payload);
      if (review.state !== 'pending') throw new PortError('conflict', `verification ${verificationId} is already ${review.state}`);
      const decided = await store.decide(verificationId, {
        state: p.decision === 'approve' ? 'approved' : 'refused',
        reviewerId: p.reviewerId,
        decidedAt: toIsoInstant(now()),
        ...(p.note !== undefined ? { note: p.note } : {}),
      });
      if (!decided) throw new PortError('conflict', `verification ${verificationId} was decided concurrently`);
      return { verified: p.decision === 'approve', evidenceRef: `manual_document_review:${verificationId}` };
    },

    pending: (orgId) => store.pending(orgId),
  };
}
