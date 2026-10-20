import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { audit, authUserCredentials, listUserOrgs, MEMBERSHIP_ROLES, PLATFORM_ORG_KEY, sessions, withUser } from '@form/db';
import { z } from 'zod';
import { accountOf } from '../../auth.ts';
import { ProblemError } from '../../errors.ts';
import { latestNoticeAck } from '../account/notice.ts';
import { client, liveSessions, meUser, toMe, type AuthCtx } from './context.ts';
import { hex } from './crypto.ts';
import { clearSessionCookie } from './sessions.ts';

const sessionView = z.object({
  id: z.uuid(),
  mfaLevel: z.string(),
  userAgent: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  lastSeenAt: z.iso.datetime({ offset: true }),
  current: z.boolean(),
});

/**
 * `GET /v1/me` and the user's own sessions (architecture §3.3). Export, deletion and the notice live in `../account`
 * (CMP-21); the org switcher's `PUT /v1/me/active-org` is in the org module.
 */
export function meRoutes(app: FastifyInstance, c: AuthCtx): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['account'];

  r.get(
    '/v1/me',
    {
      config: { auth: 'account' },
      schema: {
        tags,
        summary: 'The signed-in user, this session and the orgs they belong to',
        response: {
          200: z.object({
            user: meUser,
            session: z.object({ id: z.uuid(), mfaLevel: z.string(), expiresAt: z.iso.datetime({ offset: true }) }).nullable(),
            orgs: z.array(z.object({ id: z.uuid(), slug: z.string(), name: z.string(), role: z.enum(MEMBERSHIP_ROLES) })),
            /** The platform privacy notice: `current` is false until the user has read this version (CMP-21). */
            notice: z.object({ version: z.string(), acknowledgedVersion: z.string().nullable(), current: z.boolean() }),
            /** The org the switcher chose (PUT /v1/me/active-org), while the user is still a member of it. */
            activeOrgId: z.uuid().nullable(),
          }),
        },
      },
    },
    async (request, reply) => {
      const account = accountOf(request);
      const user = await authUserCredentials(c.db, account.userId);
      if (!user || user.status !== 'active') throw new ProblemError('UNAUTHENTICATED');
      const orgs = await listUserOrgs(c.db, account.userId);
      const ack = await withUser(c.db, { userId: account.userId, requestId: request.id }, (tx) => latestNoticeAck(tx, account.userId));
      reply.header('cache-control', 'no-store');
      return {
        user: toMe(user),
        session: account.session
          ? { id: account.session.id, mfaLevel: account.session.mfaLevel, expiresAt: account.session.absoluteExpiresAt.toISOString() }
          : null,
        orgs: orgs.map((o) => ({ id: o.orgId, slug: o.slug, name: o.name, role: o.role })),
        notice: { version: c.notice.version, acknowledgedVersion: ack?.version ?? null, current: ack?.hash === c.notice.hash },
        activeOrgId: orgs.some((o) => o.orgId === account.session?.activeOrgId) ? account.session!.activeOrgId : null,
      };
    },
  );

  r.get(
    '/v1/me/sessions',
    {
      config: { auth: 'account' },
      schema: { tags, summary: 'The user’s live sessions, newest first', response: { 200: z.object({ items: z.array(sessionView) }) } },
    },
    async (request, reply) => {
      const account = accountOf(request);
      const rows = await withUser(c.db, { userId: account.userId, requestId: request.id }, (tx) => liveSessions(tx, c.now()));
      reply.header('cache-control', 'no-store');
      return {
        items: rows.map((s) => ({
          id: s.id,
          mfaLevel: s.mfaLevel,
          userAgent: s.uaSummary,
          createdAt: s.createdAt.toISOString(),
          lastSeenAt: s.lastSeenAt.toISOString(),
          current: s.id === account.session?.id,
        })),
      };
    },
  );

  r.delete(
    '/v1/me/sessions/:id',
    {
      config: { auth: 'account' },
      schema: { tags, summary: 'Revoke one of the user’s sessions', params: z.object({ id: z.uuid() }), response: { 204: z.null() } },
    },
    async (request, reply) => {
      const account = accountOf(request);
      const { id } = request.params;
      const cl = client(c, request);
      const revoked = await withUser(c.db, { userId: account.userId, requestId: request.id }, async (tx) => {
        const rows = await tx
          .update(sessions)
          .set({ revokedAt: c.now(), revokedReason: 'revoked' })
          .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
          .returning({ id: sessions.id });
        if (rows.length === 0) return false;
        await audit.append(tx, PLATFORM_ORG_KEY, {
          actorKind: 'user',
          actorId: account.userId,
          sessionId: account.session?.id ?? null,
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'auth.session_revoked',
          resourceType: 'session',
          resourceId: id,
          outcome: 'success',
          reason: 'user',
          requestId: request.id,
        });
        return true;
      });
      // Another user's session id looks exactly like one that does not exist.
      if (!revoked) throw new ProblemError('NOT_FOUND', 'No such session.');
      if (id === account.session?.id) clearSessionCookie(reply);
      return reply.code(204).send(null);
    },
  );
}
