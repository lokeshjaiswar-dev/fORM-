import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, auditActor, formAccess, formSlugs, forms, withTenant, type Db, type Tx } from '@form/db';
import { accountOf, clientInfo, tenantOf } from '../auth.ts';
import type { ApiConfig } from '../config.ts';
import { ProblemError } from '../errors.ts';
import { hex } from '../modules/auth/crypto.ts';
import { hashPassword, passwordProblem, PASSWORD_PROBLEMS } from '../modules/auth/passwords.ts';
import type { Throttle } from '../modules/auth/throttle.ts';
import { ACCESS_DEFAULTS, AccessBody, AccessView, changedKeys, loadAccess, settingsOfInput, viewOf, type AccessSettings } from '../runtime/access-config.ts';

/** What the access routes need; `app.ts` already passes all of it, so filling this module touched no shared file. */
export interface AccessRouteDeps {
  db: Db;
  /** The separate audit pool, for denied records written outside the business transaction. */
  auditDb: Db;
  config: ApiConfig;
  throttle: Throttle;
  now: () => Date;
}

const SECURITY = [{ session: [], org: [] }, { devUser: [], org: [] }];
const idParam = z.object({ id: z.uuid() });

/** Lower-case letters and digits in words joined by hyphens; 3 to 100 characters (what `publish` generates fits). */
const SLUG = /^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/;
const slugBody = z.object({ slug: z.string().regex(SLUG, 'use 3 to 100 lower-case letters, digits and hyphens, starting and ending with a letter or digit') }).strict();
const slugView = z.object({ slug: z.string().nullable(), previousSlugs: z.array(z.string()) });
const passwordBody = z.object({ password: z.string().min(1).max(512) }).strict();
const passwordView = z.object({ hasPassword: z.boolean() });

/** The revision a save read, from `If-Match` (`3`, `"3"` or `W/"3"`). */
function expectedRev(request: FastifyRequest): number {
  const header = request.headers['if-match'];
  const m = typeof header === 'string' ? /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(header) : null;
  if (!m) throw new ProblemError('ACCESS_REV_REQUIRED', 'Send the revision you read (the rev of GET .../access) in If-Match.');
  return Number(m[1]);
}

const etag = (rev: number): string => `"${rev}"`;

/** Postgres `unique_violation`, whether the driver error is bare or wrapped by drizzle. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/** RLS limits the read to the caller's org, so a form of another org is as absent as one that never existed. */
async function requireForm(tx: Tx, formId: string): Promise<{ slug: string | null }> {
  const [form] = await tx.select({ slug: forms.slug }).from(forms).where(eq(forms.id, formId)).limit(1);
  if (!form) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
  return form;
}

/** The form's current address and the ones it had before, oldest first. */
async function slugsOf(tx: Tx, formId: string): Promise<{ slug: string | null; previousSlugs: string[] }> {
  const form = await requireForm(tx, formId);
  const rows = await tx.select({ slug: formSlugs.slug }).from(formSlugs).where(eq(formSlugs.formId, formId)).orderBy(asc(formSlugs.createdAt), asc(formSlugs.slug));
  return { slug: form.slug, previousSlugs: rows.map((r) => r.slug).filter((s) => s !== form.slug) };
}

/**
 * The builder's form-access routes (WP-1.07): open and close times, submission limit, redirect and embed allowlists, the
 * password and the public address. Every route is `auth: 'user'` and needs `ops.manage`; a member without it gets a 403
 * that the error handler audits. Every read and write runs in `withTenant`, so the org is the caller's membership and a
 * form of another org answers 404. Each route has a case in `test/isolation-cases/access.ts`.
 *
 * The password hash is write-only for the API's database role (column grants, migration 0020): reads name their
 * columns, and `hasPassword` is derived from `password_updated_at`, which the password routes set and clear together with
 * the hash.
 */
export function accessRoutes(app: FastifyInstance, deps: AccessRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** The audit fields every record of a signed-in caller carries besides the actor: session, address hash, user agent. */
  const client = (request: FastifyRequest) => {
    const info = clientInfo(request, deps.config.auth.secret, deps.now());
    return { sessionId: accountOf(request).session?.id ?? null, actorIpHash: hex(info.ipHash), actorUa: info.ua };
  };

  r.get(
    '/v1/forms/:id/access',
    {
      config: { auth: 'user', perm: 'ops.manage' },
      schema: {
        tags: ['access'],
        summary: "Read a form's access settings",
        description:
          'The stored settings, or the defaults (open, no limit, 72 hours for previous versions, `rev` 0) for a form that was never configured. `hasPassword` says whether a password is set; the hash is never returned. The `ETag` is the revision to send back in `If-Match`.',
        security: SECURITY,
        params: idParam,
        response: { 200: AccessView },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const settings = await withTenant(deps.db, { ...tenantOf(request), readOnly: true }, async (tx) => {
        await requireForm(tx, id);
        return (await loadAccess(tx, id)) ?? ACCESS_DEFAULTS;
      });
      reply.header('etag', etag(settings.rev));
      return viewOf(settings);
    },
  );

  r.put(
    '/v1/forms/:id/access',
    {
      config: { auth: 'user', perm: 'ops.manage' },
      schema: {
        tags: ['access'],
        summary: "Save a form's access settings",
        description:
          'Replaces the settings (a key left out is cleared) if `If-Match` names the revision that was read, else 409; without it, 428. Each save bumps the revision and writes `form.access_changed` with the keys that changed. The password has its own routes and is not accepted here.',
        security: SECURITY,
        params: idParam,
        body: AccessBody,
        response: { 200: AccessView },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const tenant = tenantOf(request);
      const expected = expectedRev(request);
      const next = settingsOfInput(request.body);
      const who = client(request);
      const saved = await withTenant(deps.db, tenant, async (tx): Promise<AccessSettings> => {
        await requireForm(tx, id);
        // Locked, so two saves of one form take turns and the second sees the first's revision.
        const before = await loadAccess(tx, id, { forUpdate: true });
        const current = before ?? ACCESS_DEFAULTS;
        const stale = () => new ProblemError('ACCESS_REV_CONFLICT', 'The access settings changed since you read them. Reload and apply your change again.');
        if (current.rev !== expected) throw stale();
        const columns = {
          enabled: next.enabled,
          openAt: next.openAt,
          closeAt: next.closeAt,
          availability: next.availability as Record<string, unknown> | null,
          submissionLimit: next.submissionLimit,
          embedAllowlist: next.embedAllowlist,
          redirectAllowlist: next.redirectAllowlist,
          screens: next.screens as Record<string, unknown>,
          acceptPreviousVersionsHours: next.acceptPreviousVersionsHours,
        };
        let rev: number;
        if (before === null) {
          // The org comes from the caller's membership, never from the request.
          const [row] = await tx.insert(formAccess).values({ formId: id, orgId: tenant.orgId, ...columns }).onConflictDoNothing().returning({ rev: formAccess.rev });
          if (!row) throw stale();
          rev = row.rev;
        } else {
          const [row] = await tx
            .update(formAccess)
            .set({ ...columns, rev: sql`${formAccess.rev} + 1` })
            .where(and(eq(formAccess.formId, id), eq(formAccess.rev, before.rev)))
            .returning({ rev: formAccess.rev });
          if (!row) throw stale();
          rev = row.rev;
        }
        const changed = changedKeys(current, next);
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
          action: 'form.access_changed',
          resourceType: 'form',
          resourceId: id,
          formId: id,
          outcome: 'success',
          metadata: { changedKeys: changed, rev },
        });
        return { ...next, rev, hasPassword: current.hasPassword, passwordUpdatedAt: current.passwordUpdatedAt };
      });
      reply.header('etag', etag(saved.rev));
      return viewOf(saved);
    },
  );

  r.put(
    '/v1/forms/:id/access/password',
    {
      config: { auth: 'user', perm: 'ops.manage' },
      schema: {
        tags: ['access'],
        summary: 'Set or replace the form password',
        description:
          'Stored as an argon2id hash and never returned; `form.password_changed` is audited without the value. A password that is too short, too long or on the common-password list is a 422. Respondents unlock the form with `POST /v1/p/:slug/unlock`.',
        security: SECURITY,
        params: idParam,
        body: passwordBody,
        response: { 200: passwordView },
      },
    },
    async (request) => {
      const { id } = request.params;
      const tenant = tenantOf(request);
      const who = client(request);
      // An address of another org, or a mistyped one, is refused before the (deliberately slow) hash is computed.
      await withTenant(deps.db, { ...tenant, readOnly: true }, (tx) => requireForm(tx, id));
      // A form password is a shared access code, not an account password: the length and common-password rules apply,
      // the address rule (`personal`) does not, and breach lookups would send it to an outside service (no egress).
      const problem = await passwordProblem(request.body.password, { email: '' });
      if (problem) throw new ProblemError('WEAK_PASSWORD', PASSWORD_PROBLEMS[problem]);
      const passwordHash = await hashPassword(request.body.password);
      const at = deps.now();
      await withTenant(deps.db, tenant, async (tx) => {
        await requireForm(tx, id);
        // The row exists for a form that was configured; a form that was not gets one with the defaults.
        await tx.insert(formAccess).values({ formId: id, orgId: tenant.orgId, passwordHash, passwordUpdatedAt: at }).onConflictDoNothing();
        await tx.update(formAccess).set({ passwordHash, passwordUpdatedAt: at }).where(eq(formAccess.formId, id));
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
          action: 'form.password_changed',
          resourceType: 'form',
          resourceId: id,
          formId: id,
          outcome: 'success',
          metadata: { change: 'set' },
        });
      });
      return { hasPassword: true };
    },
  );

  r.delete(
    '/v1/forms/:id/access/password',
    {
      config: { auth: 'user', perm: 'ops.manage' },
      schema: {
        tags: ['access'],
        summary: 'Remove the form password',
        description: 'Idempotent: a form without a password answers `{ hasPassword: false }` and writes no audit record.',
        security: SECURITY,
        params: idParam,
        response: { 200: passwordView },
      },
    },
    async (request) => {
      const { id } = request.params;
      const tenant = tenantOf(request);
      const who = client(request);
      await withTenant(deps.db, tenant, async (tx) => {
        await requireForm(tx, id);
        const removed = await tx
          .update(formAccess)
          .set({ passwordHash: null, passwordUpdatedAt: null })
          .where(and(eq(formAccess.formId, id), sql`${formAccess.passwordUpdatedAt} is not null`))
          .returning({ formId: formAccess.formId });
        if (removed.length === 0) return;
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
          action: 'form.password_changed',
          resourceType: 'form',
          resourceId: id,
          formId: id,
          outcome: 'success',
          metadata: { change: 'removed' },
        });
      });
      return { hasPassword: false };
    },
  );

  r.get(
    '/v1/forms/:id/slug',
    {
      config: { auth: 'user', perm: 'ops.manage' },
      schema: {
        tags: ['access'],
        summary: "A form's public address and the addresses it had before",
        description: '`slug` is null until the form is published or given one. Every earlier address keeps resolving to the form.',
        security: SECURITY,
        params: idParam,
        response: { 200: slugView },
      },
    },
    async (request) => withTenant(deps.db, { ...tenantOf(request), readOnly: true }, (tx) => slugsOf(tx, request.params.id)),
  );

  r.put(
    '/v1/forms/:id/slug',
    {
      config: { auth: 'user', perm: 'ops.manage' },
      schema: {
        tags: ['access'],
        summary: "Change a form's public address",
        description:
          'The new address becomes the primary one and the old one keeps resolving (it redirects to the new one), so printed links and QR codes do not break. An address held by any form, in any org, as its current one or one it used to have, is 409 `FORM_SLUG_TAKEN`. Naming the current address changes nothing.',
        security: SECURITY,
        params: idParam,
        body: slugBody,
        response: { 200: slugView },
      },
    },
    async (request) => {
      const { id } = request.params;
      const { slug } = request.body;
      const tenant = tenantOf(request);
      const who = client(request);
      try {
        return await withTenant(deps.db, tenant, async (tx) => {
          const form = await requireForm(tx, id);
          if (form.slug !== slug) {
            // `forms.slug` is the one write: a trigger (migration 0020) makes the new address primary in `form_slugs`,
            // keeps the old one, and refuses an address another form holds with a unique violation.
            await tx.update(forms).set({ slug, updatedAt: deps.now(), updatedBy: accountOf(request).userId }).where(eq(forms.id, id));
            await audit.append(tx, tenant.orgId, {
              ...auditActor(tenant),
              sessionId: who.sessionId,
              actorIpHash: who.actorIpHash,
              actorUa: who.actorUa,
              action: 'form.slug_changed',
              resourceType: 'form',
              resourceId: id,
              formId: id,
              outcome: 'success',
              metadata: { previousSlug: form.slug, slug },
            });
          }
          return slugsOf(tx, id);
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new ProblemError('FORM_SLUG_TAKEN', 'Another form already uses that address. Choose a different one.');
        throw err;
      }
    },
  );
}
