import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, gt } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  accountDelete,
  accountExportData,
  audit,
  authUserCredentials,
  DELETION_BLOCKERS,
  GRIEVANCE_CATEGORIES,
  GRIEVANCE_STATUSES,
  MEMBERSHIP_ROLES,
  NOTICE_ACK_CONTEXTS,
  PLATFORM_ORG_KEY,
  sessions,
  userGrievances,
  userIdentities,
  userNoticeAcks,
  userPublicColumns,
  users,
  withUser,
  type AccountDeletion,
  type AuthCredentials,
} from '@form/db';
import { z } from 'zod';
import { accountOf, type Account } from '../../auth.ts';
import { ProblemError } from '../../errors.ts';
import { client, meUser, normaliseEmail, toMe, type AuthCtx } from '../auth/context.ts';
import { base32Encode, hex } from '../auth/crypto.ts';
import { RECENT_SIGN_IN_MINUTES } from '../auth/routes.ts';
import { clearSessionCookie } from '../auth/sessions.ts';
import { recordNoticeAck } from './notice.ts';

/** Erasure completes with backup expiry (architecture §8 #6, #11): what the deletion answer and email promise. */
export const BACKUP_RETENTION_DAYS = 35;
/** DPDP Rules: a grievance is answered within 90 days. */
export const GRIEVANCE_DUE_DAYS = 90;
/** Privacy requests one user may send in a day. */
export const GRIEVANCES_PER_DAY = 10;

const iso = z.iso.datetime({ offset: true });
const DAY_MS = 86_400_000;

export const noticeView = z.object({
  version: z.string(),
  locale: z.string(),
  title: z.string(),
  fiduciary: z.string(),
  contact: z.object({ name: z.string().nullable(), email: z.string() }),
  sections: z.array(z.object({ id: z.string(), heading: z.string(), paragraphs: z.array(z.string()), items: z.array(z.string()) })),
  hash: z.string(),
});

const grievanceView = z.object({
  reference: z.string(),
  category: z.enum(GRIEVANCE_CATEGORIES),
  message: z.string().nullable(),
  status: z.enum(GRIEVANCE_STATUSES),
  createdAt: iso,
  dueAt: iso,
  closedAt: iso.nullable(),
});

const deletionOrg = z.object({
  orgId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  role: z.enum(MEMBERSHIP_ROLES),
  formsOwned: z.number().int(),
  formsTo: z.uuid().nullable(),
  blocker: z.enum(DELETION_BLOCKERS).nullable(),
});

const exportView = z.object({
  format: z.literal('fr.account-export@1'),
  generatedAt: iso,
  notice: z.string(),
  user: z.object({
    id: z.uuid(),
    email: z.string(),
    name: z.string().nullable(),
    locale: z.string().nullable(),
    status: z.string(),
    emailVerifiedAt: iso.nullable(),
    createdAt: iso,
    lastLoginAt: iso.nullable(),
    hasPassword: z.boolean(),
    totpEnabledAt: iso.nullable(),
    recoveryCodesLeft: z.number().int(),
  }),
  linkedAccounts: z.array(z.object({ provider: z.string(), subject: z.string(), linkedAt: iso, lastUsedAt: iso.nullable() })),
  sessions: z.array(
    z.object({
      id: z.uuid(),
      mfaLevel: z.string(),
      userAgent: z.string().nullable(),
      createdAt: iso,
      lastSeenAt: iso,
      expiresAt: iso,
      revokedAt: iso.nullable(),
      revokedReason: z.string().nullable(),
    }),
  ),
  memberships: z.array(
    z.object({ orgId: z.uuid(), orgSlug: z.string(), orgName: z.string(), role: z.string(), status: z.string(), joinedAt: iso, formsOwned: z.number().int() }),
  ),
  notices: z.array(z.object({ version: z.string(), hash: z.string(), locale: z.string(), context: z.enum(NOTICE_ACK_CONTEXTS), acknowledgedAt: iso })),
  requests: z.array(grievanceView),
  activity: z.array(
    z.object({
      occurredAt: iso,
      action: z.string(),
      outcome: z.string(),
      reason: z.string().nullable(),
      resourceType: z.string(),
      resourceId: z.string().nullable(),
      sessionId: z.string().nullable(),
      userAgent: z.string().nullable(),
      metadata: z.record(z.string(), z.unknown()),
    }),
  ),
});

const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);
/** Timestamps from jsonb (`account_export_data()`) carry Postgres' offset form; the export says them as ISO instants. */
const isoText = (v: string) => new Date(v).toISOString();
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

const newReference = () => `GRV-${base32Encode(randomBytes(5))}`;

/**
 * The platform as Data Fiduciary for its own users (CMP-21, WP-1.31): the privacy notice, its acknowledgement in
 * settings, the account export and deletion, and privacy requests to the platform's privacy contact. Everything runs
 * in the user's own context; deletion and the parts of the export that lie outside it go through definer functions.
 */
export function accountRoutes(app: FastifyInstance, c: AuthCtx): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['account'];

  async function me(request: FastifyRequest): Promise<{ account: Account; user: AuthCredentials }> {
    const account = accountOf(request);
    const user = await authUserCredentials(c.db, account.userId);
    if (!user || user.status !== 'active') throw new ProblemError('UNAUTHENTICATED');
    return { account, user };
  }

  r.get(
    '/v1/privacy/notice',
    {
      config: { auth: 'none' },
      schema: { tags: ['privacy'], summary: 'The privacy notice for builder accounts, with its version and hash', response: { 200: noticeView } },
    },
    async (_request, reply) => {
      reply.header('cache-control', 'no-cache');
      return c.notice;
    },
  );

  r.patch(
    '/v1/me',
    {
      config: { auth: 'account' },
      schema: {
        tags,
        summary: 'Correct the user’s name',
        body: z.object({ name: z.string().trim().min(1).max(200).nullable() }),
        response: { 200: z.object({ user: meUser }) },
      },
    },
    async (request) => {
      const { account, user } = await me(request);
      const cl = client(c, request);
      const { name } = request.body;
      await withUser(c.db, { userId: user.id, requestId: request.id }, async (tx) => {
        await tx.update(users).set({ name }).where(eq(users.id, user.id));
        await audit.append(tx, PLATFORM_ORG_KEY, {
          actorKind: 'user',
          actorId: user.id,
          sessionId: account.session?.id ?? null,
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'account.profile_updated',
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'success',
          requestId: request.id,
          metadata: { changed: ['name'] },
        });
      });
      return { user: toMe({ ...user, name }) };
    },
  );

  r.post(
    '/v1/me/notice',
    {
      config: { auth: 'account' },
      schema: {
        tags,
        summary: 'Record that the user read the current privacy notice',
        body: z.object({ version: z.string().max(32), hash: z.string().regex(/^[0-9a-f]{64}$/) }),
        response: { 200: z.object({ version: z.string(), acknowledged: z.boolean() }) },
      },
    },
    async (request) => {
      const { account, user } = await me(request);
      if (request.body.version !== c.notice.version || request.body.hash !== c.notice.hash) {
        throw new ProblemError('NOTICE_OUTDATED', 'The privacy notice changed while you were reading it. Read the new version.');
      }
      const recorded = await withUser(c.db, { userId: user.id, requestId: request.id }, (tx) =>
        recordNoticeAck(tx, { userId: user.id, notice: c.notice, context: 'settings', client: client(c, request), sessionId: account.session?.id ?? null }),
      );
      return { version: c.notice.version, acknowledged: recorded };
    },
  );

  r.post(
    '/v1/me/export',
    {
      config: { auth: 'account' },
      schema: {
        tags,
        summary: 'Download everything the platform holds about the user’s account, as JSON',
        description:
          'Profile, linked accounts, sessions, memberships, notices acknowledged, privacy requests and the user’s own security events of the last 13 months. Forms and responses belong to the orgs and are not included.',
        response: { 200: exportView },
      },
    },
    async (request, reply) => {
      const { account, user } = await me(request);
      const cl = client(c, request);
      const now = c.now();
      const out = await withUser(c.db, { userId: user.id, requestId: request.id }, async (tx) => {
        const [profile] = await tx.select(userPublicColumns).from(users).where(eq(users.id, user.id));
        const linked = await tx.select().from(userIdentities).where(eq(userIdentities.userId, user.id)).orderBy(userIdentities.createdAt);
        const own = await tx
          .select({
            id: sessions.id,
            mfaLevel: sessions.mfaLevel,
            uaSummary: sessions.uaSummary,
            createdAt: sessions.createdAt,
            lastSeenAt: sessions.lastSeenAt,
            absoluteExpiresAt: sessions.absoluteExpiresAt,
            revokedAt: sessions.revokedAt,
            revokedReason: sessions.revokedReason,
          })
          .from(sessions)
          .where(eq(sessions.userId, user.id))
          .orderBy(desc(sessions.createdAt));
        const acks = await tx.select().from(userNoticeAcks).where(eq(userNoticeAcks.userId, user.id)).orderBy(userNoticeAcks.acknowledgedAt);
        const requests = await tx.select().from(userGrievances).where(eq(userGrievances.userId, user.id)).orderBy(desc(userGrievances.createdAt));
        if (!profile) throw new ProblemError('UNAUTHENTICATED');
        const held = await accountExportData(tx, user.id);
        await audit.append(tx, PLATFORM_ORG_KEY, {
          actorKind: 'user',
          actorId: user.id,
          sessionId: account.session?.id ?? null,
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'account.exported',
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'success',
          requestId: request.id,
          metadata: { sessions: own.length, memberships: held.memberships.length, activity: held.activity.length },
        });
        return {
          format: 'fr.account-export@1' as const,
          generatedAt: now.toISOString(),
          notice: 'Forms and responses belong to your organisations and are not part of this export: an owner or admin of the organisation can export them.',
          user: {
            id: profile.id,
            email: profile.email,
            name: profile.name,
            locale: profile.locale,
            status: profile.status,
            emailVerifiedAt: isoOrNull(profile.emailVerifiedAt),
            createdAt: profile.createdAt.toISOString(),
            lastLoginAt: isoOrNull(profile.lastLoginAt),
            hasPassword: user.passwordHash !== null,
            totpEnabledAt: isoOrNull(profile.totpEnabledAt),
            recoveryCodesLeft: user.recoveryCodesLeft,
          },
          linkedAccounts: linked.map((i) => ({ provider: i.provider, subject: i.subject, linkedAt: i.createdAt.toISOString(), lastUsedAt: isoOrNull(i.lastUsedAt) })),
          sessions: own.map((s) => ({
            id: s.id,
            mfaLevel: s.mfaLevel,
            userAgent: s.uaSummary,
            createdAt: s.createdAt.toISOString(),
            lastSeenAt: s.lastSeenAt.toISOString(),
            expiresAt: s.absoluteExpiresAt.toISOString(),
            revokedAt: isoOrNull(s.revokedAt),
            revokedReason: s.revokedReason,
          })),
          memberships: held.memberships.map((m) => ({ ...m, joinedAt: isoText(m.joinedAt) })),
          notices: acks.map((a) => ({ version: a.noticeVersion, hash: hex(a.noticeHash), locale: a.locale, context: a.context, acknowledgedAt: a.acknowledgedAt.toISOString() })),
          requests: requests.map(toGrievance),
          activity: held.activity.map((e) => ({ ...e, occurredAt: isoText(e.occurredAt) })),
        };
      });
      reply.header('cache-control', 'no-store');
      reply.header('content-disposition', `attachment; filename="form-account-${dateOnly(now)}.json"`);
      return out;
    },
  );

  const recentSignIn = (account: Account) => !account.session || c.now().getTime() - account.session.createdAt.getTime() <= RECENT_SIGN_IN_MINUTES * 60_000;

  r.get(
    '/v1/me/deletion',
    {
      config: { auth: 'account' },
      schema: {
        tags,
        summary: 'What deleting the account would do, and what stops it',
        response: { 200: z.object({ status: z.enum(['ready', 'blocked']), orgs: z.array(deletionOrg), recentSignIn: z.boolean(), signInWithinMinutes: z.number().int() }) },
      },
    },
    async (request, reply) => {
      const { account, user } = await me(request);
      const plan = await withUser(c.db, { userId: user.id, requestId: request.id }, (tx) => accountDelete(tx, user.id, { apply: false }));
      reply.header('cache-control', 'no-store');
      return {
        status: plan.status === 'blocked' ? ('blocked' as const) : ('ready' as const),
        orgs: plan.orgs,
        recentSignIn: recentSignIn(account),
        signInWithinMinutes: RECENT_SIGN_IN_MINUTES,
      };
    },
  );

  r.post(
    '/v1/me/delete',
    {
      config: { auth: 'account' },
      schema: {
        tags,
        summary: 'Delete the account',
        description:
          'Needs a sign-in from the last 15 minutes and the account’s email address typed as confirmation. Refused (`ACCOUNT_DELETION_BLOCKED`) while an org would be left without an owner or without members; otherwise the user leaves every org, their forms pass to an owner of the org, every session ends and the account is erased (backups expire within 35 days).',
        body: z.object({ confirmEmail: z.string().trim().max(254) }),
        response: {
          200: z.object({ status: z.literal('deleted'), orgsLeft: z.number().int(), formsReassigned: z.number().int(), backupsExpireBy: iso }),
        },
      },
    },
    async (request, reply) => {
      const { account, user } = await me(request);
      const cl = client(c, request);
      const denied = (reason: string, blockedBy: Array<{ orgId: string; blocker: string | null }> = []) =>
        audit.appendDetached(c.auditDb, null, {
          actorKind: 'user',
          actorId: user.id,
          sessionId: account.session?.id ?? null,
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'account.deleted',
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'denied',
          reason,
          requestId: request.id,
          metadata: { orgs: blockedBy },
        });
      if (normaliseEmail(request.body.confirmEmail) !== normaliseEmail(user.email)) {
        await denied('confirmation_mismatch');
        throw new ProblemError('CONFIRMATION_MISMATCH', 'Type the email address of this account to confirm.', undefined, { audited: true });
      }
      if (!recentSignIn(account)) {
        await denied('reauth_required');
        throw new ProblemError('REAUTH_REQUIRED', `Sign in again to delete your account: it needs a sign-in from the last ${RECENT_SIGN_IN_MINUTES} minutes.`, undefined, {
          audited: true,
        });
      }
      const now = c.now();
      const result: AccountDeletion = await withUser(c.db, { userId: user.id, requestId: request.id }, async (tx) => {
        const done = await accountDelete(tx, user.id, { apply: true });
        if (done.status !== 'deleted') return done;
        await audit.append(tx, PLATFORM_ORG_KEY, {
          actorKind: 'user',
          actorId: user.id,
          sessionId: account.session?.id ?? null,
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'account.deleted',
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'success',
          requestId: request.id,
          metadata: {
            orgsLeft: done.orgsLeft,
            formsReassigned: done.formsReassigned,
            sessionsEnded: done.sessionsEnded,
            orgs: done.orgs.map((o) => ({ orgId: o.orgId, formsOwned: o.formsOwned, formsTo: o.formsTo })),
          },
        });
        return done;
      });
      if (result.status !== 'deleted') {
        const blocked = result.orgs.filter((o) => o.blocker !== null);
        await denied(
          'blocked',
          blocked.map((o) => ({ orgId: o.orgId, blocker: o.blocker })),
        );
        throw new ProblemError(
          'ACCOUNT_DELETION_BLOCKED',
          `First make someone else an owner of, or delete: ${blocked.map((o) => o.name).join(', ')}. Your organisations keep their data, so each needs an owner.`,
          undefined,
          { audited: true },
        );
      }
      const backupsExpireBy = new Date(now.getTime() + BACKUP_RETENTION_DAYS * DAY_MS);
      clearSessionCookie(reply);
      c.mail.send({ kind: 'account_deleted', to: { address: user.email }, backupsExpireBy: dateOnly(backupsExpireBy), contactEmail: c.notice.contact.email });
      return { status: 'deleted' as const, orgsLeft: result.orgsLeft, formsReassigned: result.formsReassigned, backupsExpireBy: backupsExpireBy.toISOString() };
    },
  );

  r.get(
    '/v1/me/grievances',
    {
      config: { auth: 'account' },
      schema: { tags, summary: 'The user’s privacy requests and grievances, newest first', response: { 200: z.object({ items: z.array(grievanceView) }) } },
    },
    async (request, reply) => {
      const { user } = await me(request);
      const rows = await withUser(c.db, { userId: user.id, requestId: request.id }, (tx) =>
        tx.select().from(userGrievances).where(eq(userGrievances.userId, user.id)).orderBy(desc(userGrievances.createdAt)),
      );
      reply.header('cache-control', 'no-store');
      return { items: rows.map(toGrievance) };
    },
  );

  r.post(
    '/v1/me/grievances',
    {
      config: { auth: 'account' },
      schema: {
        tags,
        summary: 'Send a privacy request or grievance to the platform’s privacy contact',
        description: 'Answered within 90 days. The user gets a receipt with the reference; the privacy contact gets the request by email.',
        body: z.object({ category: z.enum(GRIEVANCE_CATEGORIES), message: z.string().trim().min(1).max(5000) }),
        response: { 201: grievanceView },
      },
    },
    async (request, reply) => {
      const { account, user } = await me(request);
      const cl = client(c, request);
      const now = c.now();
      const dueAt = new Date(now.getTime() + GRIEVANCE_DUE_DAYS * DAY_MS);
      const { category, message } = request.body;
      const row = await withUser(c.db, { userId: user.id, requestId: request.id }, async (tx) => {
        const recent = await tx
          .select({ id: userGrievances.id })
          .from(userGrievances)
          .where(and(eq(userGrievances.userId, user.id), gt(userGrievances.createdAt, new Date(now.getTime() - DAY_MS))));
        if (recent.length >= GRIEVANCES_PER_DAY) return null;
        const [inserted] = await tx
          .insert(userGrievances)
          .values({ id: randomUUID(), userId: user.id, reference: newReference(), category, message, createdAt: now, dueAt })
          .returning();
        await audit.append(tx, PLATFORM_ORG_KEY, {
          actorKind: 'user',
          actorId: user.id,
          sessionId: account.session?.id ?? null,
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'account.grievance_filed',
          resourceType: 'grievance',
          resourceId: inserted!.id,
          outcome: 'success',
          requestId: request.id,
          metadata: { reference: inserted!.reference, category, dueAt: dueAt.toISOString() },
        });
        return inserted!;
      });
      if (!row) throw new ProblemError('RATE_LIMITED', `You sent ${GRIEVANCES_PER_DAY} requests in the last day. Write to ${c.notice.contact.email} if it cannot wait.`);
      const dueBy = dateOnly(dueAt);
      c.mail.send({
        kind: 'grievance_received',
        to: { address: user.email, ...(user.name ? { name: user.name } : {}) },
        reference: row.reference,
        dueBy,
        contactEmail: c.notice.contact.email,
      });
      c.mail.send({ kind: 'grievance_filed', to: { address: c.notice.contact.email }, reference: row.reference, category, dueBy, from: user.email, message });
      return reply.code(201).send(toGrievance(row));
    },
  );
}

function toGrievance(g: typeof userGrievances.$inferSelect): z.infer<typeof grievanceView> {
  return {
    reference: g.reference,
    category: g.category,
    message: g.message,
    status: g.status,
    createdAt: g.createdAt.toISOString(),
    dueAt: g.dueAt.toISOString(),
    closedAt: isoOrNull(g.closedAt),
  };
}
