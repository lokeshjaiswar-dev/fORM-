import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  audit,
  auditActor,
  inviteAccept,
  inviteByToken,
  invites,
  listUserOrgs,
  memberAccessToken,
  MEMBERSHIP_STATUSES,
  memberships,
  memberSessionsRevoke,
  orgs,
  sessions,
  users,
  withTenant,
  type InviteAcceptOutcome,
  type MembershipRole,
  type OrgRole,
  type TenantCtx,
  type Tx,
} from '@form/db';
import { z } from 'zod';
import { accountOf, memberOf, tenantOf } from '../../auth.ts';
import { canManage } from '../../authz/roles.ts';
import { ProblemError } from '../../errors.ts';
import { emailSchema, normaliseEmail, tokenSchema } from '../auth/context.ts';
import { randomToken, tokenHash } from '../auth/crypto.ts';
import { LINK_PATHS } from '../auth/mail.ts';
import { clientOf, isLastOwnerError, type OrgModuleDeps } from './context.ts';
import { settingsOf } from './orgs.ts';
import { inviteView, memberView, orgRoleSchema, userOrg } from './schemas.ts';

const security = [{ session: [], org: [] }, { devUser: [], org: [] }];
const RANK: Record<MembershipRole, number> = { owner: 0, admin: 1, editor: 2, creator: 3, data_collaborator: 4, data_viewer: 5, viewer: 6 };

/** Minutes a link an admin hands out by hand stays good (BL-203). */
export const ACCESS_LINK_MINUTES = 60;

const lastOwner = () => new ProblemError('LAST_OWNER', 'The org needs another active owner first.');

/** Member management (WSP-02, WSP-03): the member list, roles and removal, invites and their acceptance. */
export function memberRoutes(app: FastifyInstance, c: OrgModuleDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['members'];

  const link = (path: string, token: string) => `${c.config.auth.builderUrl}${path}#token=${token}`;

  /** The target member, in the caller's org; 404 when there is none. */
  async function target(tx: Tx, userId: string) {
    const [m] = await tx.select({ role: memberships.role, status: memberships.status }).from(memberships).where(eq(memberships.userId, userId));
    if (!m) throw new ProblemError('NOT_FOUND', 'No such member.');
    return m;
  }

  r.get(
    '/v1/org/members',
    {
      config: { auth: 'user', perm: 'forms.read' },
      schema: {
        tags,
        summary: 'The members of the active org',
        description: '`accessLinks`: whether the caller can hand members one-time sign-in links (a server without email, BL-203).',
        security,
        response: { 200: z.object({ items: z.array(memberView), accessLinks: z.boolean() }) },
      },
    },
    async (request, reply) => {
      const rows = await withTenant(c.db, { ...tenantOf(request), readOnly: true }, (tx) =>
        tx
          .select({ userId: memberships.userId, email: users.email, name: users.name, role: memberships.role, status: memberships.status, joinedAt: memberships.createdAt })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .orderBy(asc(users.email)),
      );
      reply.header('cache-control', 'no-store');
      return {
        items: rows
          .sort((a, b) => RANK[a.role] - RANK[b.role])
          .map((m) => ({ ...m, status: m.status as (typeof MEMBERSHIP_STATUSES)[number], joinedAt: m.joinedAt.toISOString() })),
        accessLinks: c.config.mailer.driver === 'log' && memberOf(request).perms.includes('members.manage'),
      };
    },
  );

  r.patch(
    '/v1/org/members/:userId',
    {
      config: { auth: 'user', perm: 'members.manage' },
      schema: {
        tags,
        summary: 'Change a member’s role or suspend them',
        description: 'Owners manage everyone; admins manage admins, editors and viewers. The member’s sessions bound to this org are revoked, so the change starts with a fresh sign-in.',
        security,
        params: z.object({ userId: z.uuid() }),
        body: z
          .object({ role: orgRoleSchema, status: z.enum(MEMBERSHIP_STATUSES) })
          .partial()
          .refine((b) => b.role !== undefined || b.status !== undefined, 'nothing to change'),
        response: { 200: z.object({ userId: z.uuid(), role: userOrg.shape.role, status: z.enum(MEMBERSHIP_STATUSES), sessionsRevoked: z.number().int() }) },
      },
    },
    async (request) => {
      const tenant = tenantOf(request);
      const member = memberOf(request);
      const account = accountOf(request);
      const { userId } = request.params;
      const cl = clientOf(c, request);
      if (userId === tenant.userId) throw new ProblemError('FORBIDDEN', 'You cannot change your own role or status. Another owner or admin can.');
      try {
        return await withTenant(c.db, tenant, async (tx) => {
          const before = await target(tx, userId);
          if (!canManage(member.role, before.role, request.body.role)) {
            throw new ProblemError('FORBIDDEN', member.role === 'admin' ? 'Only an owner can change an owner, or make someone an owner.' : 'You cannot manage members.');
          }
          const role = request.body.role ?? before.role;
          const status = request.body.status ?? (before.status as (typeof MEMBERSHIP_STATUSES)[number]);
          await tx.update(memberships).set({ role, status }).where(eq(memberships.userId, userId));
          const changed = role !== before.role || status !== before.status;
          const sessionsRevoked = changed ? await memberSessionsRevoke(tx, userId) : 0;
          if (changed) {
            await audit.append(tx, tenant.orgId, {
              ...auditActor(tenant),
              sessionId: account.session?.id ?? null,
              actorIpHash: cl.ipHash,
              actorUa: cl.ua,
              action: 'member.updated',
              resourceType: 'membership',
              resourceId: userId,
              outcome: 'success',
              metadata: { fromRole: before.role, toRole: role, fromStatus: before.status, toStatus: status, sessionsRevoked },
            });
          }
          return { userId, role, status, sessionsRevoked };
        });
      } catch (err) {
        if (isLastOwnerError(err)) throw lastOwner();
        throw err;
      }
    },
  );

  r.delete(
    '/v1/org/members/:userId',
    {
      config: { auth: 'user' },
      schema: {
        tags,
        summary: 'Remove a member, or leave the org (your own user id)',
        description: 'Removing someone else needs members.manage. The last active owner cannot leave or be removed.',
        security,
        params: z.object({ userId: z.uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      const member = memberOf(request);
      const account = accountOf(request);
      const { userId } = request.params;
      const self = userId === tenant.userId;
      const cl = clientOf(c, request);
      if (!self && !member.perms.includes('members.manage')) {
        throw new ProblemError('FORBIDDEN', 'Requires members.manage.', { orgId: tenant.orgId, actorId: tenant.userId ?? null, reason: 'missing_permission:members.manage' });
      }
      try {
        await withTenant(c.db, tenant, async (tx) => {
          const before = await target(tx, userId);
          if (!self && !canManage(member.role, before.role)) throw new ProblemError('FORBIDDEN', 'Only an owner can remove an owner.');
          await tx.delete(memberships).where(eq(memberships.userId, userId));
          if (self && account.session) await tx.update(sessions).set({ activeOrgId: null }).where(and(eq(sessions.id, account.session.id), eq(sessions.activeOrgId, tenant.orgId)));
          await audit.append(tx, tenant.orgId, {
            ...auditActor(tenant),
            sessionId: account.session?.id ?? null,
            actorIpHash: cl.ipHash,
            actorUa: cl.ua,
            action: 'member.removed',
            resourceType: 'membership',
            resourceId: userId,
            outcome: 'success',
            reason: self ? 'left' : 'removed',
            metadata: { role: before.role },
          });
        });
      } catch (err) {
        if (isLastOwnerError(err)) throw lastOwner();
        throw err;
      }
      return reply.code(204).send(null);
    },
  );

  r.post(
    '/v1/org/members/:userId/access-link',
    {
      config: { auth: 'user', perm: 'members.manage' },
      schema: {
        tags,
        summary: 'Without email: a one-time password-reset (or verification) link to hand to a member',
        description:
          'Only when the server sends no email (MAILER_DRIVER=log), only for a member who belongs to no other org, and for admins and owners only by an owner. The link is shown once and works for 60 minutes (BL-203).',
        security,
        params: z.object({ userId: z.uuid() }),
        response: { 200: z.object({ link: z.string(), purpose: z.enum(['password_reset', 'verify_email']), expiresAt: z.iso.datetime({ offset: true }) }) },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      const account = accountOf(request);
      if (c.config.mailer.driver !== 'log') throw new ProblemError('FEATURE_UNAVAILABLE', 'This server sends email: the member can use “Forgot password” on the sign-in page.');
      const cl = clientOf(c, request);
      const token = randomToken();
      const expiresAt = new Date(c.now().getTime() + ACCESS_LINK_MINUTES * 60_000);
      const purpose = await withTenant(c.db, tenant, async (tx) => {
        const issued = await memberAccessToken(tx, { userId: request.params.userId, tokenId: randomUUID(), tokenHash: tokenHash(token), minutes: ACCESS_LINK_MINUTES });
        switch (issued.outcome) {
          case 'not_a_member':
            throw new ProblemError('NOT_FOUND', 'No such member.');
          case 'other_orgs':
            throw new ProblemError('FORBIDDEN', 'This person belongs to other orgs too: only they can reset their password.');
          case 'inactive':
            throw new ProblemError('FORBIDDEN', 'This account is disabled.');
          case 'forbidden':
            throw new ProblemError('FORBIDDEN', 'Only an owner can do this for an owner or an admin, and nobody for themselves.');
          case 'issued':
            break;
        }
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: account.session?.id ?? null,
          actorIpHash: cl.ipHash,
          actorUa: cl.ua,
          action: 'member.access_link_issued',
          resourceType: 'user',
          resourceId: request.params.userId,
          outcome: 'success',
          reason: issued.purpose,
          metadata: { minutes: ACCESS_LINK_MINUTES },
        });
        return issued.purpose!;
      });
      reply.header('cache-control', 'no-store');
      return { link: link(LINK_PATHS[purpose], token), purpose, expiresAt: expiresAt.toISOString() };
    },
  );

  const inviteColumns = {
    id: invites.id,
    email: invites.email,
    role: invites.role,
    invitedBy: invites.invitedBy,
    createdAt: invites.createdAt,
    expiresAt: invites.expiresAt,
  };
  const openInvites = and(isNull(invites.acceptedAt), isNull(invites.revokedAt));
  const toInvite = (i: { id: string; email: string; role: OrgRole; invitedBy: string; createdAt: Date; expiresAt: Date }, now: Date) => ({
    ...i,
    createdAt: i.createdAt.toISOString(),
    expiresAt: i.expiresAt.toISOString(),
    state: i.expiresAt > now ? ('open' as const) : ('expired' as const),
  });

  r.get(
    '/v1/org/invites',
    {
      config: { auth: 'user', perm: 'members.manage' },
      schema: { tags, summary: 'Invites nobody has accepted or revoked yet, newest first', security, response: { 200: z.object({ items: z.array(inviteView) }) } },
    },
    async (request, reply) => {
      const rows = await withTenant(c.db, { ...tenantOf(request), readOnly: true }, (tx) =>
        tx.select(inviteColumns).from(invites).where(openInvites).orderBy(sql`${invites.createdAt} desc`),
      );
      reply.header('cache-control', 'no-store');
      const now = c.now();
      return { items: rows.map((i) => toInvite(i, now)) };
    },
  );

  r.post(
    '/v1/org/invites',
    {
      config: { auth: 'user', perm: 'members.manage' },
      schema: {
        tags,
        summary: 'Invite an email address to the org',
        description:
          'Emails a link that works for the org’s invite lifetime (7 days by default) and only for an account with that verified address. An open invite to the same address is replaced. The link is also returned, for servers without email.',
        security,
        body: z.object({ email: emailSchema, role: orgRoleSchema.default('editor') }),
        response: { 201: z.object({ invite: inviteView, link: z.string(), emailed: z.boolean() }) },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      const member = memberOf(request);
      const account = accountOf(request);
      const { email, role } = request.body;
      if (!canManage(member.role, 'viewer', role)) throw new ProblemError('FORBIDDEN', 'Only an owner can invite an owner.');
      const emailNorm = normaliseEmail(email);
      const cl = clientOf(c, request);
      const token = randomToken();
      const out = await withTenant(c.db, tenant, async (tx) => {
        const [existing] = await tx
          .select({ userId: memberships.userId })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(eq(users.emailNorm, emailNorm));
        if (existing) throw new ProblemError('ALREADY_MEMBER', 'This address belongs to a member already.');
        const { inviteDays } = await settingsOf(tx);
        const replaced = await tx.update(invites).set({ revokedAt: c.now() }).where(and(openInvites, eq(invites.emailNorm, emailNorm))).returning({ id: invites.id });
        const id = randomUUID();
        // fr_app may name only these columns: the creation, acceptance and revocation times are the database's, and so
        // is the clock of the expiry (at most 30 days after creation).
        await tx.execute(sql`insert into invites (id, org_id, email, email_norm, role, token_hash, invited_by, expires_at)
          values (${id}, ${tenant.orgId}, ${email.trim()}, ${emailNorm}, ${role}, ${Buffer.from(tokenHash(token))}, ${tenant.userId}, now() + make_interval(days => ${inviteDays}))`);
        const [row] = await tx.select(inviteColumns).from(invites).where(eq(invites.id, id));
        const [org] = await tx.select({ name: orgs.name }).from(orgs);
        const [inviter] = await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, tenant.userId!));
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: account.session?.id ?? null,
          actorIpHash: cl.ipHash,
          actorUa: cl.ua,
          action: 'member.invited',
          resourceType: 'invite',
          resourceId: id,
          outcome: 'success',
          metadata: { role, days: inviteDays, replaced: replaced.map((i) => i.id) },
        });
        return { row: row!, orgName: org!.name, inviterName: inviter?.name ?? inviter?.email ?? 'A member', inviteDays };
      });
      const url = link(LINK_PATHS.invite, token);
      c.mail.send({ kind: 'invite', to: { address: email.trim() }, link: url, invite: { orgName: out.orgName, inviterName: out.inviterName, role, days: out.inviteDays } });
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({ invite: toInvite(out.row, c.now()), link: url, emailed: c.config.mailer.driver !== 'log' });
    },
  );

  r.delete(
    '/v1/org/invites/:id',
    {
      config: { auth: 'user', perm: 'members.manage' },
      schema: { tags, summary: 'Withdraw an open invite', security, params: z.object({ id: z.uuid() }), response: { 204: z.null() } },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      const account = accountOf(request);
      const cl = clientOf(c, request);
      await withTenant(c.db, tenant, async (tx) => {
        const rows = await tx.update(invites).set({ revokedAt: c.now() }).where(and(eq(invites.id, request.params.id), openInvites)).returning({ id: invites.id });
        if (rows.length === 0) throw new ProblemError('NOT_FOUND', 'No such open invite.');
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: account.session?.id ?? null,
          actorIpHash: cl.ipHash,
          actorUa: cl.ua,
          action: 'member.invite_revoked',
          resourceType: 'invite',
          resourceId: request.params.id,
          outcome: 'success',
        });
      });
      return reply.code(204).send(null);
    },
  );

  const inviteInfo = z.object({
    orgName: z.string(),
    email: z.string(),
    role: orgRoleSchema,
    inviterName: z.string(),
    state: z.enum(['open', 'used', 'revoked', 'expired', 'org_inactive']),
    expiresAt: z.iso.datetime({ offset: true }),
  });

  r.post(
    '/v1/invites/lookup',
    {
      config: { auth: 'none' },
      schema: {
        tags,
        summary: 'Who an invite link is for, without using it',
        description: 'The builder shows the org and the address before the visitor signs in. The token travels in the body, never in a URL.',
        body: z.object({ token: tokenSchema }),
        response: { 200: inviteInfo },
      },
    },
    async (request, reply) => {
      const info = await inviteByToken(c.db, tokenHash(request.body.token));
      if (!info) throw new ProblemError('INVITE_UNAVAILABLE', 'This invitation link is not valid. Ask for a new one.');
      reply.header('cache-control', 'no-store');
      return { orgName: info.orgName, email: info.email, role: info.role, inviterName: info.inviterName, state: info.state, expiresAt: info.expiresAt.toISOString() };
    },
  );

  const REFUSALS: Partial<Record<InviteAcceptOutcome, () => ProblemError>> = {
    unknown: () => new ProblemError('INVITE_UNAVAILABLE', 'This invitation link is not valid. Ask for a new one.', undefined, { audited: true }),
    used: () => new ProblemError('INVITE_UNAVAILABLE', 'This invitation was used already.', undefined, { audited: true }),
    revoked: () => new ProblemError('INVITE_UNAVAILABLE', 'This invitation was withdrawn.', undefined, { audited: true }),
    expired: () => new ProblemError('INVITE_UNAVAILABLE', 'This invitation has expired. Ask for a new one.', undefined, { audited: true }),
    org_inactive: () => new ProblemError('INVITE_UNAVAILABLE', 'This org is not active.', undefined, { audited: true }),
    email_not_verified: () => new ProblemError('EMAIL_NOT_VERIFIED', 'Confirm your email address, then open the invitation again.', undefined, { audited: true }),
    email_mismatch: () => new ProblemError('INVITE_EMAIL_MISMATCH', 'This invitation is for another email address. Sign in with that address.', undefined, { audited: true }),
    suspended: () => new ProblemError('FORBIDDEN', 'Your membership of this org is suspended. Ask an admin.', undefined, { audited: true }),
  };

  async function refused(request: FastifyRequest, orgId: string | null, userId: string, sessionId: string | null, inviteId: string | null, outcome: InviteAcceptOutcome): Promise<never> {
    const cl = clientOf(c, request);
    try {
      await audit.appendDetached(c.auditDb, orgId, {
        actorKind: 'user',
        actorId: userId,
        sessionId,
        actorIpHash: cl.ipHash,
        actorUa: cl.ua,
        action: 'member.joined',
        resourceType: 'invite',
        resourceId: inviteId,
        outcome: 'denied',
        reason: outcome,
        requestId: request.id,
      });
    } catch (err) {
      request.log.error({ err }, 'audit record of a refused invite was not written');
    }
    throw REFUSALS[outcome]!();
  }

  r.post(
    '/v1/invites/accept',
    {
      config: { auth: 'account' },
      schema: {
        tags,
        summary: 'Accept an invite as the signed-in user',
        description: 'The signed-in account’s verified address must be the invited one. The org becomes the session’s active org.',
        body: z.object({ token: tokenSchema }),
        response: { 200: z.object({ org: userOrg, outcome: z.enum(['accepted', 'already_member']) }) },
      },
    },
    async (request) => {
      const account = accountOf(request);
      const hash = tokenHash(request.body.token);
      const sessionId = account.session?.id ?? null;
      const info = await inviteByToken(c.db, hash);
      if (!info) return refused(request, null, account.userId, sessionId, null, 'unknown');
      const cl = clientOf(c, request);
      const ctx: TenantCtx = { orgId: info.orgId, actor: 'user', userId: account.userId, perms: [], requestId: request.id };
      const result = await withTenant(c.db, ctx, async (tx) => {
        const accepted = await inviteAccept(tx, hash, account.userId);
        if (accepted.outcome !== 'accepted' && accepted.outcome !== 'already_member') return accepted;
        if (account.session) await tx.update(sessions).set({ activeOrgId: info.orgId }).where(eq(sessions.id, account.session.id));
        await audit.append(tx, info.orgId, {
          ...auditActor(ctx),
          sessionId,
          actorIpHash: cl.ipHash,
          actorUa: cl.ua,
          action: 'member.joined',
          resourceType: 'invite',
          resourceId: accepted.inviteId,
          outcome: 'success',
          reason: accepted.outcome,
          metadata: { role: accepted.role },
        });
        return accepted;
      });
      if (result.outcome !== 'accepted' && result.outcome !== 'already_member') return refused(request, info.orgId, account.userId, sessionId, result.inviteId, result.outcome);
      const org = (await listUserOrgs(c.db, account.userId)).find((o) => o.orgId === info.orgId);
      if (!org) throw new ProblemError('INTERNAL');
      return { org: { id: org.orgId, slug: org.slug, name: org.name, role: org.role }, outcome: result.outcome };
    },
  );
}
