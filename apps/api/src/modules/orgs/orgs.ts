import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  audit,
  auditActor,
  authUserCredentials,
  createOrg,
  listUserOrgs,
  membershipFor,
  ORG_DEFAULTS,
  orgSettings,
  orgs,
  sessions,
  withTenant,
  type Tx,
} from '@form/db';
import { z } from 'zod';
import { accountOf, memberOf, tenantOf } from '../../auth.ts';
import { ROLE_PERMISSIONS } from '../../authz/roles.ts';
import { ProblemError } from '../../errors.ts';
import { clientOf, type OrgModuleDeps } from './context.ts';
import {
  dateFormatSchema,
  localeSchema,
  orgNameSchema,
  orgView,
  settingsView,
  slugFrom,
  slugSchema,
  timeZoneSchema,
  userOrg,
  withSuffix,
  type OrgView,
} from './schemas.ts';

type OrgRow = typeof orgs.$inferSelect;

const toView = (o: OrgRow): OrgView => ({
  id: o.id,
  slug: o.slug,
  name: o.name,
  plan: o.plan,
  region: o.region,
  locale: o.locale,
  timeZone: o.timeZone,
  dateFormat: o.dateFormat as OrgView['dateFormat'],
  status: o.status,
  createdAt: o.createdAt.toISOString(),
});

const SETTINGS_DEFAULTS = { editorsApproveNotice: false, inviteDays: 7 };

/** The org's settings; an org created before `org_settings` existed has the defaults. */
export async function settingsOf(tx: Tx): Promise<z.infer<typeof settingsView>> {
  const [row] = await tx.select({ editorsApproveNotice: orgSettings.editorsApproveNotice, inviteDays: orgSettings.inviteDays }).from(orgSettings);
  return row ?? SETTINGS_DEFAULTS;
}

const security = [{ session: [], org: [] }, { devUser: [], org: [] }];

/**
 * Orgs (WSP-02, WSP-09): the caller's orgs (`list_user_orgs()`), creating one (`create_org()`, with the en-IN,
 * Asia/Kolkata and DD-MM-YYYY defaults), the active org and its settings, and the switcher's choice.
 */
export function orgRoutes(app: FastifyInstance, c: OrgModuleDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['orgs'];

  r.get(
    '/v1/orgs',
    {
      config: { auth: 'account' },
      schema: {
        tags,
        summary: 'The orgs the signed-in user belongs to, and the one the switcher chose',
        response: { 200: z.object({ items: z.array(userOrg), activeOrgId: z.uuid().nullable() }) },
      },
    },
    async (request, reply) => {
      const account = accountOf(request);
      const items = await listUserOrgs(c.db, account.userId);
      reply.header('cache-control', 'no-store');
      const active = account.session?.activeOrgId ?? null;
      return {
        items: items.map((o) => ({ id: o.orgId, slug: o.slug, name: o.name, role: o.role })),
        activeOrgId: active && items.some((o) => o.orgId === active) ? active : null,
      };
    },
  );

  r.post(
    '/v1/orgs',
    {
      config: { auth: 'account' },
      schema: {
        tags,
        summary: 'Create an org; the caller becomes its owner',
        description: `Defaults: locale ${ORG_DEFAULTS.locale}, time zone ${ORG_DEFAULTS.timeZone}, date format ${ORG_DEFAULTS.dateFormat}. Without a slug, one is made from the name. The new org becomes the session's active org.`,
        body: z.object({
          name: orgNameSchema,
          slug: slugSchema.optional(),
          locale: localeSchema.optional(),
          timeZone: timeZoneSchema.optional(),
          dateFormat: dateFormatSchema.optional(),
        }),
        response: { 201: z.object({ org: orgView }) },
      },
    },
    async (request, reply) => {
      const account = accountOf(request);
      const { userId } = account;
      const user = await authUserCredentials(c.db, userId);
      if (!user || user.status !== 'active') throw new ProblemError('UNAUTHENTICATED');
      if (!user.emailVerifiedAt) throw new ProblemError('EMAIL_NOT_VERIFIED', 'Confirm your email address before you create an org.');
      const { name, locale, timeZone, dateFormat } = request.body;
      const cl = clientOf(c, request);
      const base = request.body.slug ?? slugFrom(name);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const id = randomUUID();
        const slug = attempt === 0 ? base : withSuffix(base);
        const ctx = { orgId: id, actor: 'user' as const, userId, perms: ROLE_PERMISSIONS.owner, requestId: request.id };
        const created = await withTenant(c.db, ctx, async (tx) => {
          const outcome = await createOrg(tx, { id, slug, name, userId, locale, timeZone, dateFormat });
          if (outcome !== 'created') return outcome;
          const [org] = await tx.select().from(orgs).where(eq(orgs.id, id));
          if (account.session) await tx.update(sessions).set({ activeOrgId: id }).where(eq(sessions.id, account.session.id));
          await audit.append(tx, id, {
            ...auditActor(ctx),
            sessionId: account.session?.id ?? null,
            actorIpHash: cl.ipHash,
            actorUa: cl.ua,
            action: 'org.created',
            resourceType: 'org',
            resourceId: id,
            outcome: 'success',
            metadata: { slug, locale: org!.locale, timeZone: org!.timeZone, dateFormat: org!.dateFormat },
          });
          return org!;
        });
        if (created === 'limit') throw new ProblemError('PLAN_LIMIT_REACHED', 'You own the most orgs one account may own (25).');
        if (created === 'slug_taken') {
          if (request.body.slug) throw new ProblemError('SLUG_TAKEN', `The address ${slug} is taken. Choose another.`);
          continue;
        }
        return reply.code(201).send({ org: toView(created) });
      }
      throw new ProblemError('SLUG_TAKEN', 'Could not find a free address for this name. Choose one.');
    },
  );

  r.get(
    '/v1/org',
    {
      config: { auth: 'user', perm: 'forms.read' },
      schema: {
        tags,
        summary: 'The active org, the caller’s role and permissions in it',
        security,
        response: { 200: z.object({ org: orgView, role: userOrg.shape.role, permissions: z.array(z.string()) }) },
      },
    },
    async (request) => {
      const tenant = tenantOf(request);
      const member = memberOf(request);
      const [org] = await withTenant(c.db, { ...tenant, readOnly: true }, (tx) => tx.select().from(orgs));
      if (!org) throw new ProblemError('NOT_FOUND', 'No such org.');
      return { org: toView(org), role: member.role, permissions: [...member.perms] };
    },
  );

  r.patch(
    '/v1/org',
    {
      config: { auth: 'user', perm: 'org.settings' },
      schema: {
        tags,
        summary: 'Rename the org or change its defaults (locale, time zone, date format)',
        security,
        body: z
          .object({ name: orgNameSchema, locale: localeSchema, timeZone: timeZoneSchema, dateFormat: dateFormatSchema })
          .partial()
          .refine((b) => Object.keys(b).length > 0, 'nothing to change'),
        response: { 200: z.object({ org: orgView }) },
      },
    },
    async (request) => {
      const tenant = tenantOf(request);
      const account = accountOf(request);
      const cl = clientOf(c, request);
      const changes = Object.fromEntries(Object.entries(request.body).filter(([, v]) => v !== undefined));
      const org = await withTenant(c.db, tenant, async (tx) => {
        const [row] = await tx.update(orgs).set(changes).where(eq(orgs.id, tenant.orgId)).returning();
        if (!row) throw new ProblemError('NOT_FOUND', 'No such org.');
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: account.session?.id ?? null,
          actorIpHash: cl.ipHash,
          actorUa: cl.ua,
          action: 'org.updated',
          resourceType: 'org',
          resourceId: tenant.orgId,
          outcome: 'success',
          metadata: { changed: Object.keys(changes) },
        });
        return row;
      });
      return { org: toView(org) };
    },
  );

  r.get(
    '/v1/org/settings',
    {
      config: { auth: 'user', perm: 'org.settings' },
      schema: { tags, summary: 'The org’s settings', security, response: { 200: settingsView } },
    },
    async (request) => withTenant(c.db, { ...tenantOf(request), readOnly: true }, settingsOf),
  );

  r.patch(
    '/v1/org/settings',
    {
      config: { auth: 'user', perm: 'org.settings' },
      schema: {
        tags,
        summary: 'Change the org’s settings',
        security,
        body: settingsView.partial().refine((b) => Object.keys(b).length > 0, 'nothing to change'),
        response: { 200: settingsView },
      },
    },
    async (request) => {
      const tenant = tenantOf(request);
      const account = accountOf(request);
      const cl = clientOf(c, request);
      const changes = Object.fromEntries(Object.entries(request.body).filter(([, v]) => v !== undefined));
      return withTenant(c.db, tenant, async (tx) => {
        const values = { ...SETTINGS_DEFAULTS, ...(await settingsOf(tx)), ...changes, updatedAt: c.now(), updatedBy: tenant.userId ?? null };
        const [row] = await tx
          .insert(orgSettings)
          .values({ orgId: tenant.orgId, ...values })
          .onConflictDoUpdate({ target: orgSettings.orgId, set: values })
          .returning({ editorsApproveNotice: orgSettings.editorsApproveNotice, inviteDays: orgSettings.inviteDays });
        await audit.append(tx, tenant.orgId, {
          ...auditActor(tenant),
          sessionId: account.session?.id ?? null,
          actorIpHash: cl.ipHash,
          actorUa: cl.ua,
          action: 'org.settings_updated',
          resourceType: 'org',
          resourceId: tenant.orgId,
          outcome: 'success',
          metadata: { changed: Object.keys(changes) },
        });
        return row!;
      });
    },
  );

  r.put(
    '/v1/me/active-org',
    {
      config: { auth: 'account' },
      schema: {
        tags: ['account'],
        summary: 'Choose the org the session works in by default (the org switcher)',
        description: 'Requests that name no org with `X-FR-Org` then use this one. Only an org the user is an active member of.',
        body: z.object({ orgId: z.uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const account = accountOf(request);
      const { orgId } = request.body;
      const membership = await membershipFor(c.db, account.userId, orgId);
      if (!membership) {
        throw new ProblemError('FORBIDDEN', 'You are not a member of this org.', { orgId: null, actorId: account.userId, reason: 'not_a_member', claimedOrgId: orgId });
      }
      const cl = clientOf(c, request);
      const ctx = { orgId, actor: 'user' as const, userId: account.userId, perms: [], requestId: request.id };
      await withTenant(c.db, ctx, async (tx) => {
        if (account.session) await tx.update(sessions).set({ activeOrgId: orgId }).where(eq(sessions.id, account.session.id));
        await audit.append(tx, orgId, {
          ...auditActor(ctx),
          sessionId: account.session?.id ?? null,
          actorIpHash: cl.ipHash,
          actorUa: cl.ua,
          action: 'org.switched',
          resourceType: 'org',
          resourceId: orgId,
          outcome: 'success',
          metadata: { role: membership.role },
        });
      });
      return reply.code(204).send(null);
    },
  );
}
