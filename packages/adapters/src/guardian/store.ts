import { PortError, type GuardianMethod, type IsoInstant } from '@form/ports';

export interface GuardianRecord {
  verificationId: string;
  orgId: string;
  submissionId: string;
  guardianEmail: string;
  method: GuardianMethod;
  state: 'pending' | 'approved' | 'refused';
  createdAt: IsoInstant;
  decidedAt?: IsoInstant;
  /** The reviewer (manual review) or the guardian's account (existing account) that decided. */
  decidedBy?: string;
  note?: string;
}

export type GuardianDecision = Required<Pick<GuardianRecord, 'decidedAt' | 'decidedBy'>> & {
  state: 'approved' | 'refused';
  note?: string;
};

/**
 * Where verifications live. The `guardian_verifications` table (architecture §2.4) backs it in the guardian-consent
 * flow (CMP-13); the memory store is for tests and single-process demos, and every verifier takes its store explicitly.
 */
export interface GuardianStore {
  insert(r: GuardianRecord): Promise<void>;
  get(verificationId: string): Promise<GuardianRecord | undefined>;
  /** Applies the decision only while the verification is pending; false when another decision got there first. */
  decide(verificationId: string, d: GuardianDecision): Promise<boolean>;
  pending(orgId: string, method: GuardianMethod): Promise<GuardianRecord[]>;
}

export function createMemoryGuardianStore(): GuardianStore {
  const records = new Map<string, GuardianRecord>();
  return {
    async insert(r) {
      records.set(r.verificationId, { ...r });
    },
    async get(id) {
      const r = records.get(id);
      return r && { ...r };
    },
    async decide(id, d) {
      const r = records.get(id);
      if (r?.state !== 'pending') return false;
      records.set(id, { ...r, ...d });
      return true;
    },
    async pending(orgId, method) {
      return [...records.values()].filter((r) => r.orgId === orgId && r.method === method && r.state === 'pending').map((r) => ({ ...r }));
    },
  };
}

/** The checks every verifier runs on `start`. */
export function checkStart(i: { orgId: string; submissionId: string; guardianEmail: string }): void {
  if (i.orgId.length === 0 || i.submissionId.length === 0) throw new PortError('invalid_argument', 'orgId and submissionId are required');
  if (!/^[^\s@]+@[^\s@]+$/.test(i.guardianEmail)) throw new PortError('invalid_argument', 'a guardian email is required');
}

/**
 * The record `complete` decides: unknown ids and other orgs' ids are `not_found` alike, so an id
 * leaks nothing across orgs; a decided one is `conflict`.
 */
export async function orgRecord(store: GuardianStore, orgId: string, verificationId: string, method: GuardianMethod): Promise<GuardianRecord> {
  const r = await store.get(verificationId);
  if (!r || r.orgId !== orgId || r.method !== method) throw new PortError('not_found', `no verification ${verificationId}`);
  return r;
}

export async function decide(store: GuardianStore, r: GuardianRecord, d: GuardianDecision): Promise<void> {
  if (r.state !== 'pending') throw new PortError('conflict', `verification ${r.verificationId} is already ${r.state}`);
  if (!(await store.decide(r.verificationId, d))) throw new PortError('conflict', `verification ${r.verificationId} was decided concurrently`);
}
