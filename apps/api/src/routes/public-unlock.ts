import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, formAccessPasswordHash, resolveFormSlug, withTenant, type Db } from '@form/db';
import { clientInfo } from '../auth.ts';
import type { ApiConfig } from '../config.ts';
import { ProblemError } from '../errors.ts';
import { hex } from '../modules/auth/crypto.ts';
import { verifyPassword } from '../modules/auth/passwords.ts';
import type { Throttle, ThrottleKey } from '../modules/auth/throttle.ts';
import { issueAccessToken } from '../runtime/access-token.ts';

/** What the unlock route needs; `app.ts` already passes all of it, so filling this module touched no shared file. */
export interface PublicUnlockDeps {
  db: Db;
  /** The separate audit pool, for denied records written outside the business transaction. */
  auditDb: Db;
  config: ApiConfig;
  throttle: Throttle;
  now: () => Date;
}

/** The shape `publish` and the slug route make; what the public routes accept as a slug. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

/**
 * The respondent's password unlock for a protected form, `POST /v1/p/:slug/unlock` (WP-1.07, ACC-05).
 *
 * Public, with no session: a respondent has no account, and the password is the credential. What a stranger with `curl`
 * and a form address can do here is guess passwords, so the route is built for that:
 *
 * - Every attempt counts against the address's budget for this form (`auth_unlock_form`, a keyed hash of address and form,
 *   never the address) before any password work is done; past it, 429 with `Retry-After`.
 * - The hash is read through `form_access_password_hash()`, the one reader the database allows, in a respondent context
 *   of the form's own org (the org comes from the slug, never from the caller).
 * - A wrong password and a form that has no password take the same path, the same argon2id work (`verifyPassword` checks
 *   a dummy hash when there is none) and give the same answer, so neither timing nor the message says which forms are
 *   protected. A form that is not published, archived or trashed is a 404, as for every public route.
 * - A refusal is audited as `form.unlock_failed` with the keyed address hash and nothing else about the caller.
 *
 * A success returns a two-hour access token for the form's live version (see `runtime/access-token.ts`); the password is
 * never echoed, logged or stored.
 */
export function publicUnlockRoutes(app: FastifyInstance, deps: PublicUnlockDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Per address and form: the address hash joined with the form id, hashed again, so the key holds neither. */
  const budgetKey = (ipHash: Uint8Array, formId: string): ThrottleKey => ({
    bucket: 'auth_unlock_form',
    key: new Uint8Array(createHash('sha256').update(ipHash).update(formId).digest().subarray(0, 16)),
  });

  async function refuse(request: FastifyRequest, o: { orgId: string; formId: string; ipHash: Uint8Array; reason: 'wrong_password' | 'no_password' }): Promise<never> {
    try {
      await audit.appendDetached(deps.auditDb, o.orgId, {
        actorKind: 'respondent',
        actorIpHash: hex(o.ipHash),
        action: 'form.unlock_failed',
        resourceType: 'form',
        resourceId: o.formId,
        formId: o.formId,
        outcome: 'denied',
        reason: o.reason,
        requestId: request.id,
      });
    } catch (err) {
      // The refusal stands whether or not the record could be written; the failure is logged (no password, no address).
      request.log.error({ err }, 'audit record of a refused unlock was not written');
    }
    throw new ProblemError('FORM_UNLOCK_FAILED', 'That password is not right.');
  }

  r.post(
    '/v1/p/:slug/unlock',
    {
      config: { auth: 'none' },
      // A password and nothing else: a body of any size beyond this is not one.
      bodyLimit: 4096,
      schema: {
        tags: ['runtime'],
        summary: 'Unlock a password-protected form',
        description:
          'Respondents are anonymous, so this is public. Checks the password against the form\'s argon2id hash and, if it is right, returns an access token for the live version, good for two hours. A wrong password and a form without one both answer 401 `FORM_UNLOCK_FAILED`; attempts are limited per address and form (429 with `Retry-After`) and refusals are audited.',
        params: z.object({ slug: z.string().regex(SLUG) }),
        // The same bound as when a password is set: the length rule counts characters (at most 128), this only bounds the work.
        body: z.object({ password: z.string().min(1).max(512) }).strict(),
        response: { 200: z.object({ accessToken: z.string(), expiresAt: z.iso.datetime() }) },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const found = await resolveFormSlug(deps.db, request.params.slug);
      if (!found) throw new ProblemError('NOT_FOUND', 'This form is not published.');
      const now = deps.now();
      const { ipHash } = clientInfo(request, deps.config.auth.secret, now);
      await deps.throttle.hit(request, reply, [budgetKey(ipHash, found.formId)], { ipHash }, 'Too many attempts. Try again later.');

      const stored = await withTenant(deps.db, { orgId: found.orgId, actor: 'respondent', requestId: request.id, readOnly: true }, (tx) => formAccessPasswordHash(tx, found.formId));
      const accepted = await verifyPassword(stored, request.body.password);
      if (!accepted) return refuse(request, { orgId: found.orgId, formId: found.formId, ipHash, reason: stored === null ? 'no_password' : 'wrong_password' });

      const { accessToken, expiresAt } = issueAccessToken(deps.config.auth.secret, { formId: found.formId, versionScope: found.liveVersionId }, now);
      return { accessToken, expiresAt: expiresAt.toISOString() };
    },
  );
}
