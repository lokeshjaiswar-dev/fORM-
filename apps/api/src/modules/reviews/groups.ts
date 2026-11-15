import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { audit, auditActor, MEMBERSHIP_ROLES, memberships, reviewGroupMembers, reviewGroups, users, withTenant, type Tx } from '@form/db';
import { z } from 'zod';
import { accountOf, memberOf, tenantOf } from '../../auth.ts';
import { permissionsFor } from '../../authz/roles.ts';
import { ProblemError } from '../../errors.ts';
import { uuidv7 } from '../../uuid7.ts';
import type { ReviewModuleDeps } from './context.ts';
import { auditClient, REVIEW_SECURITY } from './http.ts';

const TAGS = ['reviews'];

/** A group's name: what a form's Review tab and the reviewer's queue show. Plain text, 1 to 120 characters (`review_groups_name_check`). */
export const groupNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[^\p{Cc}]+$/u, 'must not contain control characters');

const groupMemberView = z.object({
  userId: z.uuid(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.enum(MEMBERSHIP_ROLES),
  /** False when the member's role no longer carries `submissions.review`, or they are suspended: they are still listed, and decide nothing. */
  canReview: z.boolean(),
  addedAt: z.iso.datetime({ offset: true }),
});

export const reviewGroupView = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  /** Null for a group in use. An archived group keeps its members and its past decisions, and takes no new units or checkers. */
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
  members: z.array(groupMemberView),
});
export type ReviewGroupView = z.infer<typeof reviewGroupView>;

const idParam = z.object({ id: z.uuid() });
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });

/** Whether a membership may check responses: an active member in a role that carries `submissions.review`. */
export function mayReview(role: (typeof MEMBERSHIP_ROLES)[number], status: string): boolean {
  return status === 'active' && permissionsFor(role).includes('submissions.review');
}

/** The groups with their members, in one query each (not one per group). RLS limits both to the caller's org. */
async function viewsOf(tx: Tx, o: { id?: string; includeArchived?: boolean }): Promise<ReviewGroupView[]> {
  const conditions = [o.id ? eq(reviewGroups.id, o.id) : undefined, o.includeArchived || o.id ? undefined : isNull(reviewGroups.archivedAt)];
  const groups = await tx
    .select()
    .from(reviewGroups)
    .where(and(...conditions))
    .orderBy(asc(reviewGroups.name), asc(reviewGroups.id));
  if (groups.length === 0) return [];
  const rows = await tx
    .select({
      groupId: reviewGroupMembers.groupId,
      userId: reviewGroupMembers.userId,
      addedAt: reviewGroupMembers.addedAt,
      email: users.email,
      name: users.name,
      role: memberships.role,
      status: memberships.status,
    })
    .from(reviewGroupMembers)
    .innerJoin(memberships, and(eq(memberships.orgId, reviewGroupMembers.orgId), eq(memberships.userId, reviewGroupMembers.userId)))
    .innerJoin(users, eq(users.id, reviewGroupMembers.userId))
    .where(
      inArray(
        reviewGroupMembers.groupId,
        groups.map((g) => g.id),
      ),
    )
    .orderBy(asc(users.email), asc(reviewGroupMembers.userId));
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    createdAt: g.createdAt.toISOString(),
    archivedAt: g.archivedAt ? g.archivedAt.toISOString() : null,
    members: rows
      .filter((m) => m.groupId === g.id)
      .map((m) => ({ userId: m.userId, email: m.email, name: m.name, role: m.role, canReview: mayReview(m.role, m.status), addedAt: m.addedAt.toISOString() })),
  }));
}

/** One group of the caller's org; a group of another org is as absent as one that never existed (RLS). */
async function groupOf(tx: Tx, id: string) {
  const [group] = await tx.select().from(reviewGroups).where(eq(reviewGroups.id, id)).limit(1);
  if (!group) throw new ProblemError('NOT_FOUND', 'No such review group.');
  return group;
}

/**
 * Review groups of an org and their members: `/v1/org/review-groups` (WP-2.33). A group is a named set of checkers that a
 * form's review units are assigned to. Managing groups needs `members.manage`, the permission of managing members, and RLS
 * repeats it (`review_groups_manage_*`), so a route that forgot its own check is still stopped. Reading needs that or
 * `submissions.review`, because a checker sees the groups they are asked about.
 *
 * A checker needs two things, and the first is checked when they are added (422 `NOT_A_REVIEWER`): a role that carries
 * `submissions.review` (owner, admin, editor), and membership of the unit's group. The role is read again whenever a
 * decision is made, so demoting a member after adding them does not leave them able to decide.
 *
 * Groups are archived, never deleted: review rows and decisions name the group that was asked. Every route has a case in
 * `test/isolation-cases/reviews.ts`; a group of another org answers 404 for each.
 */
export function registerReviewGroups(app: FastifyInstance, deps: ReviewModuleDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/org/review-groups',
    {
      // Either permission lets the caller read, which `config.perm` cannot say, so the check is below and is audited the same way.
      config: { auth: 'user' },
      schema: {
        tags: TAGS,
        summary: "The org's review groups and their members",
        description: 'Active groups by default; `includeArchived=true` adds archived ones. Needs `members.manage` or `submissions.review`.',
        security: REVIEW_SECURITY,
        querystring: z.object({ includeArchived: z.stringbool().default(false) }),
        response: { 200: z.object({ items: z.array(reviewGroupView) }) },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      const { perms } = memberOf(request);
      if (!perms.includes('members.manage') && !perms.includes('submissions.review')) {
        throw new ProblemError('FORBIDDEN', 'Requires members.manage or submissions.review.', {
          orgId: tenant.orgId,
          actorId: tenant.userId ?? null,
          reason: 'missing_permission:members.manage|submissions.review',
        });
      }
      const items = await withTenant(deps.db, { ...tenant, readOnly: true }, (tx) => viewsOf(tx, { includeArchived: request.query.includeArchived }));
      reply.header('cache-control', 'no-store');
      return { items };
    },
  );

  r.post(
    '/v1/org/review-groups',
    {
      config: { auth: 'user', perm: 'members.manage' },
      schema: {
        tags: TAGS,
        summary: 'Create a review group',
        description: 'The group starts with no members. Audited as `review_group.created`.',
        security: REVIEW_SECURITY,
        body: z.strictObject({ name: groupNameSchema }),
        response: { 201: reviewGroupView },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      const who = auditClient(deps, request);
      const { name } = request.body;
      const id = uuidv7(deps.now().getTime());
      const view = await withTenant(deps.db, tenant, async (tx) => {
        // The org and the creator come from the caller's membership, never from the request.
        await tx.insert(reviewGroups).values({ id, orgId: tenant.orgId, name, createdBy: accountOf(request).userId });
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
          action: 'review_group.created',
          resourceType: 'review_group',
          resourceId: id,
          outcome: 'success',
          metadata: { name },
        });
        return (await viewsOf(tx, { id }))[0]!;
      });
      return reply.code(201).send(view);
    },
  );

  r.patch(
    '/v1/org/review-groups/:id',
    {
      config: { auth: 'user', perm: 'members.manage' },
      schema: {
        tags: TAGS,
        summary: 'Rename a review group, archive it or bring it back',
        description:
          'Archiving keeps the members and every decision that names the group; the group can no longer be given to a unit or take new members. A change that changes nothing writes no audit record.',
        security: REVIEW_SECURITY,
        params: idParam,
        body: z
          .strictObject({ name: groupNameSchema, archived: z.boolean() })
          .partial()
          .refine((b) => b.name !== undefined || b.archived !== undefined, 'nothing to change'),
        response: { 200: reviewGroupView },
      },
    },
    async (request) => {
      const tenant = tenantOf(request);
      const { id } = request.params;
      const who = auditClient(deps, request);
      return withTenant(deps.db, tenant, async (tx) => {
        const before = await groupOf(tx, id);
        const changed: string[] = [];
        const set: Partial<typeof reviewGroups.$inferInsert> = {};
        let archived = before.archivedAt !== null;
        if (request.body.name !== undefined && request.body.name !== before.name) {
          set.name = request.body.name;
          changed.push('name');
        }
        if (request.body.archived !== undefined && request.body.archived !== archived) {
          set.archivedAt = request.body.archived ? deps.now() : null;
          archived = request.body.archived;
          changed.push('archived');
        }
        if (changed.length > 0) {
          await tx.update(reviewGroups).set(set).where(eq(reviewGroups.id, id));
          await audit.append(tx, tenant.orgId, {
            ...auditActor(tenant),
            sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
            action: 'review_group.updated',
            resourceType: 'review_group',
            resourceId: id,
            outcome: 'success',
            metadata: { changed, name: set.name ?? before.name, archived },
          });
        }
        return (await viewsOf(tx, { id }))[0]!;
      });
    },
  );

  r.put(
    '/v1/org/review-groups/:id/members/:userId',
    {
      config: { auth: 'user', perm: 'members.manage' },
      schema: {
        tags: TAGS,
        summary: 'Add a member to a review group',
        description:
          'The member must be active in the org with a role that carries `submissions.review` (owner, admin, editor), else 422 `NOT_A_REVIEWER`; an archived group takes none (409). Adding a member twice is not an error and writes one record. Audited as `review_group.member_added`.',
        security: REVIEW_SECURITY,
        params: memberParams,
        response: { 200: reviewGroupView },
      },
    },
    async (request) => {
      const tenant = tenantOf(request);
      const { id, userId } = request.params;
      const who = auditClient(deps, request);
      return withTenant(deps.db, tenant, async (tx) => {
        const group = await groupOf(tx, id);
        // RLS limits memberships to the org, so a user id of another org is as absent as a made-up one.
        const [member] = await tx.select({ role: memberships.role, status: memberships.status }).from(memberships).where(eq(memberships.userId, userId)).limit(1);
        if (!member) throw new ProblemError('NOT_FOUND', 'No such member.');
        if (group.archivedAt) throw new ProblemError('REVIEW_GROUP_ARCHIVED', 'Bring the group back before you add members to it.');
        if (!mayReview(member.role, member.status)) {
          throw new ProblemError(
            'NOT_A_REVIEWER',
            member.status === 'active'
              ? `A member with the ${member.role} role cannot review responses. Only owners, admins and editors can.`
              : 'A suspended member cannot review responses.',
          );
        }
        const added = await tx
          .insert(reviewGroupMembers)
          .values({ orgId: tenant.orgId, groupId: id, userId, addedBy: accountOf(request).userId })
          .onConflictDoNothing()
          .returning({ userId: reviewGroupMembers.userId });
        if (added.length > 0) {
          await audit.append(tx, tenant.orgId, {
            ...auditActor(tenant),
            sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
            action: 'review_group.member_added',
            resourceType: 'review_group',
            resourceId: id,
            outcome: 'success',
            metadata: { userId, role: member.role },
          });
        }
        return (await viewsOf(tx, { id }))[0]!;
      });
    },
  );

  r.delete(
    '/v1/org/review-groups/:id/members/:userId',
    {
      config: { auth: 'user', perm: 'members.manage' },
      schema: {
        tags: TAGS,
        summary: 'Take a member out of a review group',
        description:
          'Idempotent: someone who is not in the group answers 204 and writes no record. Units already waiting for the group stay waiting for it. Audited as `review_group.member_removed`.',
        security: REVIEW_SECURITY,
        params: memberParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      const { id, userId } = request.params;
      const who = auditClient(deps, request);
      await withTenant(deps.db, tenant, async (tx) => {
        await groupOf(tx, id);
        const removed = await tx
          .delete(reviewGroupMembers)
          .where(and(eq(reviewGroupMembers.groupId, id), eq(reviewGroupMembers.userId, userId)))
          .returning({ userId: reviewGroupMembers.userId });
        if (removed.length === 0) return;
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: who.sessionId,
          actorIpHash: who.actorIpHash,
          actorUa: who.actorUa,
          action: 'review_group.member_removed',
          resourceType: 'review_group',
          resourceId: id,
          outcome: 'success',
          metadata: { userId },
        });
      });
      return reply.code(204).send(null);
    },
  );
}
