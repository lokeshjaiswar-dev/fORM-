import type { FastifyInstance } from 'fastify';
import type { OrgModuleDeps } from './context.ts';
import { memberRoutes } from './members.ts';
import { orgRoutes } from './orgs.ts';

export type { OrgModuleDeps } from './context.ts';

/**
 * Orgs, members, invites and roles (WP-1.02): `/v1/orgs`, `/v1/org*`, `/v1/invites/*` and `PUT /v1/me/active-org`.
 * Permissions are checked by the auth preHandler (`config.perm`) and again by RLS.
 */
export function registerOrgModule(app: FastifyInstance, deps: OrgModuleDeps): void {
  orgRoutes(app, deps);
  memberRoutes(app, deps);
}
