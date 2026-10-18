import type { FastifyInstance, FastifyRequest } from 'fastify';
import { appendAuditDetached, isUuid, membershipFor, type Db, type TenantCtx } from '@form/db';
import { ROLE_PERMISSIONS, type Permission } from './authz/roles.ts';
import { ProblemError } from './errors.ts';

export type RouteAuth = 'none' | 'user';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set for routes with `config.auth: 'user'` once the caller and the active org are verified. */
    tenant: TenantCtx | null;
  }
  interface FastifyContextConfig {
    auth?: RouteAuth;
    perm?: Permission;
  }
}

export const DEV_USER_HEADER = 'x-fr-dev-user';
export const ORG_HEADER = 'x-fr-org';

export interface AuthOptions {
  db: Db;
  /**
   * Development stub until sign-in lands (WP-1.01): the caller names a user id in `X-FR-Dev-User`. Off, every
   * route that needs a user answers 401, because this build has no credential to verify.
   */
  devHeaders: boolean;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return typeof v === 'string' ? v.trim() : undefined;
}

/** Request context: caller, active org (validated with membership_for), permissions. Denials are audited. */
export function registerAuth(app: FastifyInstance, options: AuthOptions): void {
  app.decorateRequest('tenant', null);

  const deny = async (request: FastifyRequest, orgId: string | null, userId: string, reason: string, detail: string): Promise<never> => {
    await appendAuditDetached(options.db, orgId, {
      actorKind: 'user',
      actorId: userId,
      action: 'request.authorize',
      resourceType: 'route',
      resourceId: `${request.method} ${request.routeOptions.url ?? ''}`,
      outcome: 'denied',
      reason,
      requestId: request.id,
      ...(orgId ? {} : { metadata: { claimedOrgId: header(request, ORG_HEADER) } }),
    });
    throw new ProblemError('FORBIDDEN', detail);
  };

  app.addHook('preHandler', async (request, reply) => {
    const { auth, perm } = request.routeOptions.config;
    if (auth !== 'user') return;
    if (!options.devHeaders) throw new ProblemError('UNAUTHENTICATED');

    const userId = header(request, DEV_USER_HEADER);
    if (!isUuid(userId)) throw new ProblemError('UNAUTHENTICATED', `${DEV_USER_HEADER} must be a user id`);
    const orgId = header(request, ORG_HEADER);
    if (!isUuid(orgId)) throw new ProblemError('BAD_REQUEST', `${ORG_HEADER} must be an org id`);

    const role = await membershipFor(options.db, userId, orgId);
    if (!role) return deny(request, null, userId, 'not_a_member', 'You are not a member of this org.');
    const perms = ROLE_PERMISSIONS[role];
    if (perm && !perms.includes(perm)) return deny(request, orgId, userId, `missing_permission:${perm}`, `Requires ${perm}.`);

    request.tenant = { orgId, actor: 'user', userId, perms, teamIds: [], requestId: request.id };
    request.log = request.log.child({ orgId });
    reply.log = request.log;
  });
}

/** The verified context of an authenticated route. */
export function tenantOf(request: FastifyRequest): TenantCtx {
  if (!request.tenant) throw new ProblemError('UNAUTHENTICATED');
  return request.tenant;
}
