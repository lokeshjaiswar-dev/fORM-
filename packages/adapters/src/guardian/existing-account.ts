import { randomUUID } from 'node:crypto';
import { PortError, toIsoInstant, type GuardianVerifier, type IsoInstant } from '@form/ports';
import { checkStart, decide, orgRecord, type GuardianStore } from './store.ts';

const METHOD = 'existing_verified_adult_account';

/** What the platform knows about a signed-in account, from `users` (WP-1.01). */
export interface GuardianAccount {
  userId: string;
  email: string;
  emailVerifiedAt?: IsoInstant;
  /** When the account holder was verified as an adult (CMP-13); unset for accounts never verified. */
  adultVerifiedAt?: IsoInstant;
}

export interface GuardianAccountDirectory {
  account(userId: string): Promise<GuardianAccount | undefined>;
}

/** What the guardian's signed-in session submits to `complete` from the emailed link. */
export interface ExistingAccountPayload {
  decision: 'approve' | 'refuse';
  userId: string;
}

function parsePayload(p: unknown): ExistingAccountPayload {
  if (typeof p !== 'object' || p === null) throw new PortError('invalid_argument', 'payload must be an object');
  const { decision, userId } = p as Record<string, unknown>;
  if (decision !== 'approve' && decision !== 'refuse') throw new PortError('invalid_argument', "decision must be 'approve' or 'refuse'");
  if (typeof userId !== 'string' || userId.length === 0) throw new PortError('invalid_argument', 'userId is required');
  return { decision, userId };
}

const normalise = (email: string) => email.trim().normalize('NFC').toLowerCase();

/**
 * CMP-13 `existing_verified_adult_account`: the guardian follows the emailed link, signs in with an account whose
 * verified email is the guardian email and that was verified as an adult, and approves or refuses. Signing in with
 * any other account, or one whose email is not verified (for either decision), is refused without consuming the
 * verification, so the guardian can retry with the right one.
 */
export function createExistingAccountGuardianVerifier(o: { store: GuardianStore; accounts: GuardianAccountDirectory; now?: () => Date }): GuardianVerifier {
  const { store, accounts } = o;
  const now = o.now ?? (() => new Date());

  return {
    method: METHOD,

    async start(i) {
      checkStart(i);
      const verificationId = randomUUID();
      await store.insert({ verificationId, orgId: i.orgId, submissionId: i.submissionId, guardianEmail: i.guardianEmail, method: METHOD, state: 'pending', createdAt: toIsoInstant(now()) });
      return { verificationId, next: 'email_link' };
    },

    async complete({ orgId, verificationId, payload }) {
      const record = await orgRecord(store, orgId, verificationId, METHOD);
      const p = parsePayload(payload);
      const account = await accounts.account(p.userId);
      if (!account || normalise(account.email) !== normalise(record.guardianEmail)) {
        throw new PortError('invalid_argument', 'the signed-in account is not the guardian email’s account');
      }
      // Either decision settles the verification, so both need the guardian email proven; approving also needs an adult.
      if (account.emailVerifiedAt === undefined) throw new PortError('invalid_argument', 'the account’s email is not verified');
      if (p.decision === 'approve' && account.adultVerifiedAt === undefined) throw new PortError('invalid_argument', 'the account is not verified as an adult');
      await decide(store, record, { state: p.decision === 'approve' ? 'approved' : 'refused', decidedBy: account.userId, decidedAt: toIsoInstant(now()) });
      return { verified: p.decision === 'approve', evidenceRef: `${METHOD}:${verificationId}` };
    },
  };
}
