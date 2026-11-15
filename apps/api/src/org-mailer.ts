import { randomUUID } from 'node:crypto';
import { isUuid, secretEnc, withTenant, type Db } from '@form/db';
import type { EgressGuard, Mailer, OrgSecrets } from '@form/ports';

/**
 * The per-org sender seam of the SMTP mailer (WP-1.16), shaped like `SmtpSenders` of `@form/adapters/mailer`. It is
 * declared here and not imported because only a composition root may import an adapter (the
 * `adapters-only-from-composition-roots` rule): `main.ts` passes a `makeSmtpMailer` that hands these to `createSmtpMailer`.
 */
export interface OrgSmtpSenders {
  /** The SMTP URL (with credentials) of a sender secret of this org, or undefined when there is no such secret. */
  resolve(senderSecretRef: string): Promise<string | undefined>;
  /** An org's own relay is a tenant destination: it always passes the EGRESS_POLICY guard, with no trusted hosts (SSRF). */
  egress: EgressGuard;
}

export interface OrgMailerDeps {
  /** The request pool. The one read of a sealed secret runs through `withTenant` on it, as a system context of the org. */
  db: Db;
  /** Opens a stored secret under the org's key context; `main.ts` builds it with `createOrgSecrets(keys)`. */
  orgSecrets: OrgSecrets;
  /** Guards the org's own SMTP relay (`createTenantEgressGuard`). */
  tenantEgress: EgressGuard;
  /** `main.ts` builds the platform mailer around these senders (`createSmtpMailer({ url, egress, senders })`). */
  makeSmtpMailer: (senders: OrgSmtpSenders) => Mailer;
}

/**
 * The SMTP URL behind one sender secret of one org, or undefined when this org has no such secret.
 *
 * Why it cannot open another org's secret: the org is fixed when the mailer is made, by the caller's own membership and
 * never by a request field; the read runs as a `system` context of that org, and `secret_enc()` answers only for the
 * context's own org (null for any other); and the KMS unwraps the data key only under that same org's context, with the org,
 * the secret id and the kind in the cipher text's associated data. So a ref that names another org's secret (or no secret,
 * or a webhook secret) never reaches a key: the answer is undefined, which the mailer turns into `not_found`.
 *
 * The URL carries credentials, so it is returned to the mailer only. It is never logged, and an error here names no value.
 */
async function resolveSenderUrl(deps: OrgMailerDeps, orgId: string, senderSecretRef: string): Promise<string | undefined> {
  // `secret_enc(...::uuid)` would raise on anything else; a ref that is no uuid is no sender of this org.
  if (!isUuid(senderSecretRef)) return undefined;
  const enc = await withTenant(deps.db, { orgId, actor: 'system', requestId: `org-mailer:${randomUUID()}`, readOnly: true }, (tx) => secretEnc(tx, senderSecretRef));
  if (!enc) return undefined;
  const bytes = await deps.orgSecrets.open({ orgId, secretId: senderSecretRef, kind: 'smtp' }, enc);
  return new TextDecoder().decode(bytes);
}

/**
 * The `orgMailer` of `AppDeps`: a mailer for one org, whose `senderSecretRef` (an `email_senders.smtp_secret_id` the route
 * read under RLS) is opened as that org's secret. A message with no `senderSecretRef` goes out through the platform relay.
 */
export function createOrgMailer(deps: OrgMailerDeps): (orgId: string) => Mailer {
  return (orgId) => {
    if (!isUuid(orgId)) throw new TypeError('orgMailer: orgId must be a uuid');
    return deps.makeSmtpMailer({ resolve: (ref) => resolveSenderUrl(deps, orgId, ref), egress: deps.tenantEgress });
  };
}
