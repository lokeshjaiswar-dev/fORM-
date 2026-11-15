import { eq } from 'drizzle-orm';
import { formCounters, type Tx } from '@form/db';
import { ACCESS_DEFAULTS, loadAccess, type AccessSettings } from '../runtime/access-config.ts';
import { verifyAccessToken } from '../runtime/access-token.ts';

/*
 * What both public routes read to say what a form may do right now (WP-1.07's `runtimeStatus`): the stored access rules
 * and the counter of responses taken. `GET /v1/p/:slug` shows the status to the page, `POST .../submissions` enforces it
 * at the moment the answers arrive, and both must read it the same way.
 */

export interface AccessView {
  /** The stored rules, or the defaults of a form that has none (open, no limit, no password). */
  access: AccessSettings;
  /** `form_counters.submitted_total`: the responses counted against the limit. */
  submittedTotal: number;
}

/** Reads the rules and the counter of a form, in the caller's (respondent) tenant transaction. */
export async function readAccess(tx: Tx, formId: string): Promise<AccessView> {
  const access = (await loadAccess(tx, formId)) ?? ACCESS_DEFAULTS;
  const [counter] = await tx.select({ total: formCounters.submittedTotal }).from(formCounters).where(eq(formCounters.formId, formId)).limit(1);
  return { access, submittedTotal: counter?.total ?? 0 };
}

/**
 * Whether the caller's `X-FR-Access` token unlocks this form's password for `versionScope`. A form without a password
 * is never "unlocked" (there is nothing to unlock), and a token that is absent, forged, expired, for another form or
 * version, or older than the form's last password change is just not valid, without saying which.
 *
 * The last rule is what makes changing the password take effect: a token is good for two hours, so without it an owner
 * who rotates a leaked password would leave everyone who had already unlocked the form in (to read it and to submit).
 * `iat` is whole seconds and `passwordUpdatedAt` an instant, so both are compared in seconds: a token issued in the same
 * second as the change counts as issued after it. The password routes set and clear `passwordUpdatedAt` together with
 * the hash, so a form with a password always has one; a form without one has nothing to unlock anyway.
 */
export function isUnlocked(
  secret: Uint8Array,
  access: Pick<AccessSettings, 'hasPassword' | 'passwordUpdatedAt'>,
  token: string | undefined,
  scope: { formId: string; versionScope: string },
  now: Date,
): boolean {
  if (!access.hasPassword || access.passwordUpdatedAt === null || token === undefined) return false;
  const claims = verifyAccessToken(secret, token, scope, now);
  return claims !== null && claims.iat >= Math.floor(access.passwordUpdatedAt.getTime() / 1000);
}
