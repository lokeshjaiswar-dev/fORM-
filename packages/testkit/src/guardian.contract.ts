import { describe, expect, it } from 'vitest';
import { GUARDIAN_METHODS, type GuardianStart, type GuardianVerifier } from '@form/ports';
import { expectPortError, useSubject, type ContractSetup, type ContractSubject } from './contract.ts';

export interface GuardianContractSubject extends ContractSubject<GuardianVerifier> {
  /** Method-specific payloads that approve or refuse a started verification. */
  approve(start: GuardianStart): unknown;
  refuse(start: GuardianStart): unknown;
  invalidPayload: unknown;
}

const input = (n: number) => ({ orgId: 'org-1', submissionId: `sub-${n}`, guardianEmail: `parent${n}@example.in` });

export function runGuardianVerifierContract(label: string, setup: ContractSetup<GuardianContractSubject>): void {
  describe(`GuardianVerifier contract: ${label}`, () => {
    const subject = useSubject(setup);
    const v = () => subject().impl;

    it('declares a known method', () => {
      expect(GUARDIAN_METHODS).toContain(v().method);
    });

    it('starts verifications with distinct ids and a next step', async () => {
      const a = await v().start(input(1));
      const b = await v().start(input(1));
      expect(a.verificationId).not.toBe(b.verificationId);
      expect(['email_link', 'redirect', 'review_queue']).toContain(a.next);
      if (a.next === 'redirect') expect(new URL(a.url ?? '').protocol).toBe('https:');
    });

    it('rejects incomplete input', async () => {
      await expectPortError(v().start({ ...input(2), guardianEmail: '' }), 'invalid_argument');
      await expectPortError(v().start({ ...input(2), orgId: '' }), 'invalid_argument');
      await expectPortError(v().start({ ...input(2), submissionId: '' }), 'invalid_argument');
    });

    it('verifies an approved guardian with evidence', async () => {
      const s = await v().start(input(3));
      const r = await v().complete({ verificationId: s.verificationId, payload: subject().approve(s) });
      expect(r.verified).toBe(true);
      expect(r.evidenceRef.length).toBeGreaterThan(0);
    });

    it('records a refusal as unverified', async () => {
      const s = await v().start(input(4));
      const r = await v().complete({ verificationId: s.verificationId, payload: subject().refuse(s) });
      expect(r.verified).toBe(false);
      expect(r.evidenceRef.length).toBeGreaterThan(0);
    });

    it('cannot be completed twice', async () => {
      const s = await v().start(input(5));
      await v().complete({ verificationId: s.verificationId, payload: subject().approve(s) });
      await expectPortError(v().complete({ verificationId: s.verificationId, payload: subject().approve(s) }), 'conflict');
    });

    it('rejects unknown ids', async () => {
      await expectPortError(v().complete({ verificationId: 'does-not-exist', payload: {} }), 'not_found');
    });

    it('rejects an invalid payload without consuming the verification', async () => {
      const s = await v().start(input(6));
      await expectPortError(v().complete({ verificationId: s.verificationId, payload: subject().invalidPayload }), 'invalid_argument');
      expect((await v().complete({ verificationId: s.verificationId, payload: subject().approve(s) })).verified).toBe(true);
    });
  });
}
