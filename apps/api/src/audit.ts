import type { FastifyRequest } from 'fastify';
import { audit, type Db } from '@form/db';
import { scrubUrl } from '@form/observability';

/** Who was refused and why, when the refusal happens before `request.tenant` exists (auth.ts). */
export interface DenialAudit {
  /** The org the record is filed under; null files it under the platform chain. */
  orgId: string | null;
  actorId: string | null;
  reason: string;
  /** An org id the caller named but does not belong to. */
  claimedOrgId?: string | undefined;
}

const route = (request: FastifyRequest) => `${request.method} ${request.routeOptions.url ?? scrubUrl(request.url).split('?')[0]}`;

/**
 * Every 403 leaves a denied record and every 5xx a route raises an error record (architecture §2.7, §3.2; C-M7;
 * overload 503s from under-pressure are not audited, so an overload does not add audit writes), written on the
 * API's separate audit pool in a transaction of their own, so the rollback of the request's transaction cannot
 * take them along. `audit.chain` moves them into audit_log within seconds.
 */
export async function auditProblem(writer: Db, request: FastifyRequest, status: number, code: string, denial?: DenialAudit): Promise<void> {
  const tenant = request.tenant;
  const orgId = denial ? denial.orgId : (tenant?.orgId ?? null);
  const actorId = denial ? denial.actorId : (tenant?.userId ?? null);
  const actorKind = tenant?.actor ?? (actorId ? 'user' : 'none');
  if (status === 403) {
    await audit.appendDetached(writer, orgId, {
      actorKind,
      actorId,
      action: 'request.authorize',
      resourceType: 'route',
      resourceId: route(request),
      outcome: 'denied',
      reason: denial?.reason ?? code.toLowerCase(),
      requestId: request.id,
      metadata: { code, claimedOrgId: denial?.claimedOrgId ?? null },
    });
    return;
  }
  await audit.appendDetached(writer, orgId, {
    actorKind,
    actorId,
    action: 'request.failed',
    resourceType: 'route',
    resourceId: route(request),
    outcome: 'error',
    reason: code,
    requestId: request.id,
    metadata: { status, code },
  });
}
