import { describe, expect, it } from 'vitest';
import { expectPortError, runGuardianVerifierContract } from '@form/testkit';
import type { IsoInstant } from '@form/ports';
import { createExistingAccountGuardianVerifier, type GuardianAccount } from './existing-account.ts';
import { createMemoryGuardianStore } from './store.ts';

const AT = '2027-01-15T09:00:00.000Z' as IsoInstant;

function directory(accounts: GuardianAccount[]) {
  const byId = new Map(accounts.map((a) => [a.userId, a]));
  return { account: async (id: string) => byId.get(id) };
}

/** Every guardian email of the contract has a verified adult account whose id is the email itself. */
runGuardianVerifierContract('existing verified adult account', () => {
  const store = createMemoryGuardianStore();
  const accounts = { account: async (userId: string): Promise<GuardianAccount> => ({ userId, email: userId.toUpperCase(), emailVerifiedAt: AT, adultVerifiedAt: AT }) };
  const guardianOf = async (verificationId: string) => (await store.get(verificationId))?.guardianEmail ?? 'unknown@example.in';
  return {
    impl: createExistingAccountGuardianVerifier({ store, accounts }),
    approve: async (s) => ({ decision: 'approve', userId: await guardianOf(s.verificationId) }),
    refuse: async (s) => ({ decision: 'refuse', userId: await guardianOf(s.verificationId) }),
    invalidPayload: { decision: 'approve' },
  };
});

describe('existing-account guardian verifier', () => {
  const start = { orgId: 'org-1', submissionId: 'sub-1', guardianEmail: 'Parent@Example.in' };
  const parent: GuardianAccount = { userId: 'u-parent', email: 'parent@example.in', emailVerifiedAt: AT, adultVerifiedAt: AT };

  it('asks for an email link and records which account decided', async () => {
    const store = createMemoryGuardianStore();
    const v = createExistingAccountGuardianVerifier({ store, accounts: directory([parent]), now: () => new Date('2027-02-01T10:00:00Z') });
    const s = await v.start(start);
    expect(s.next).toBe('email_link');
    expect(await v.complete({ orgId: 'org-1', verificationId: s.verificationId, payload: { decision: 'approve', userId: 'u-parent' } })).toEqual({
      verified: true,
      evidenceRef: `existing_verified_adult_account:${s.verificationId}`,
    });
    expect(await store.get(s.verificationId)).toMatchObject({ state: 'approved', decidedBy: 'u-parent', decidedAt: '2027-02-01T10:00:00.000Z' });
  });

  it('refuses other accounts, unverified emails and accounts never verified as adults, without consuming the verification', async () => {
    const accounts = directory([
      parent,
      { userId: 'u-stranger', email: 'stranger@example.in', emailVerifiedAt: AT, adultVerifiedAt: AT },
      { userId: 'u-unverified', email: 'parent@example.in', adultVerifiedAt: AT },
      { userId: 'u-minor', email: 'parent@example.in', emailVerifiedAt: AT },
    ]);
    const v = createExistingAccountGuardianVerifier({ store: createMemoryGuardianStore(), accounts });
    const s = await v.start(start);
    for (const userId of ['u-stranger', 'u-unverified', 'u-minor', 'u-missing']) {
      await expectPortError(v.complete({ orgId: 'org-1', verificationId: s.verificationId, payload: { decision: 'approve', userId } }), 'invalid_argument');
    }
    for (const userId of ['u-stranger', 'u-unverified']) {
      await expectPortError(v.complete({ orgId: 'org-1', verificationId: s.verificationId, payload: { decision: 'refuse', userId } }), 'invalid_argument');
    }
    expect((await v.complete({ orgId: 'org-1', verificationId: s.verificationId, payload: { decision: 'approve', userId: 'u-parent' } })).verified).toBe(true);
  });

  it('lets the guardian refuse with an account that is not adult-verified', async () => {
    const v = createExistingAccountGuardianVerifier({ store: createMemoryGuardianStore(), accounts: directory([{ userId: 'u-p', email: 'parent@example.in', emailVerifiedAt: AT }]) });
    const s = await v.start(start);
    expect((await v.complete({ orgId: 'org-1', verificationId: s.verificationId, payload: { decision: 'refuse', userId: 'u-p' } })).verified).toBe(false);
  });
});
