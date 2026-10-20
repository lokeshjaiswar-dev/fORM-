import { describe, expect, it } from 'vitest';
import { expectPortError, runGuardianVerifierContract } from '@form/testkit';
import { createManualGuardianVerifier } from './manual.ts';
import { createMemoryGuardianStore } from './store.ts';

runGuardianVerifierContract('manual document review', () => ({
  impl: createManualGuardianVerifier({ store: createMemoryGuardianStore() }),
  approve: () => ({ decision: 'approve', reviewerId: 'user-reviewer' }),
  refuse: () => ({ decision: 'refuse', reviewerId: 'user-reviewer', note: 'document unreadable' }),
  invalidPayload: { decision: 'maybe', reviewerId: 'user-reviewer' },
}));

describe('manual guardian verifier', () => {
  const start = { orgId: 'org-1', submissionId: 'sub-1', guardianEmail: 'parent@example.in' };

  it('queues reviews per org and records the decision', async () => {
    const store = createMemoryGuardianStore();
    const now = () => new Date('2027-02-01T10:00:00Z');
    const v = createManualGuardianVerifier({ store, now });
    const s = await v.start(start);
    expect(s).toEqual({ verificationId: expect.any(String), next: 'review_queue' });
    await v.start({ ...start, orgId: 'org-2' });
    expect((await v.pending('org-1')).map((r) => r.verificationId)).toEqual([s.verificationId]);

    const payload = { decision: 'approve', reviewerId: 'u-9', note: 'PAN + Aadhaar (masked)' };
    expect(await v.complete({ orgId: 'org-1', verificationId: s.verificationId, payload })).toEqual({
      verified: true,
      evidenceRef: `manual_document_review:${s.verificationId}`,
    });
    expect(await store.get(s.verificationId)).toMatchObject({ state: 'approved', decidedBy: 'u-9', decidedAt: '2027-02-01T10:00:00.000Z', note: 'PAN + Aadhaar (masked)' });
    expect(await v.pending('org-1')).toEqual([]);
  });

  it('lets only one of two concurrent reviewers decide', async () => {
    const v = createManualGuardianVerifier({ store: createMemoryGuardianStore() });
    const s = await v.start(start);
    const results = await Promise.allSettled([
      v.complete({ orgId: 'org-1', verificationId: s.verificationId, payload: { decision: 'approve', reviewerId: 'a' } }),
      v.complete({ orgId: 'org-1', verificationId: s.verificationId, payload: { decision: 'refuse', reviewerId: 'b' } }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('validates payload fields', async () => {
    const v = createManualGuardianVerifier({ store: createMemoryGuardianStore() });
    const s = await v.start(start);
    for (const payload of [null, 'approve', { decision: 'approve' }, { decision: 'approve', reviewerId: '' }, { decision: 'approve', reviewerId: 'a', note: 1 }]) {
      await expectPortError(v.complete({ orgId: 'org-1', verificationId: s.verificationId, payload }), 'invalid_argument');
    }
  });

  it('does not decide verifications of another method kept in the same store', async () => {
    const store = createMemoryGuardianStore();
    const v = createManualGuardianVerifier({ store });
    await store.insert({ ...start, verificationId: 'v-other', method: 'existing_verified_adult_account', state: 'pending', createdAt: '2027-02-01T10:00:00.000Z' as never });
    await expectPortError(v.complete({ orgId: 'org-1', verificationId: 'v-other', payload: { decision: 'approve', reviewerId: 'a' } }), 'not_found');
    expect(await v.pending('org-1')).toEqual([]);
  });
});
