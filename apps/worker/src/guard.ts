import { appendAuditDetached, isUuid, JOB_RESOURCE_TYPES, resolveJobOrg, type Db, type JobResourceType as DbResourceType } from '@form/db';
import { PortError, type JobName, type JobResource } from '@form/ports';
import type { Logger } from 'pino';

/** What the queue adapter reports for an envelope it refused to run (see `@form/adapters` RejectedJob). */
export interface JobRejectionReport {
  id: string;
  name: JobName;
  reason: string;
  claimedOrgId: string | null;
  resource: JobResource | null;
  resolvedOrgId: string | null;
}

const resolvable = (type: string): type is DbResourceType => (JOB_RESOURCE_TYPES as readonly string[]).includes(type);

/**
 * ADR-0016 on the worker side: the org of a job comes from the database (`resolve_job_org`), never from the
 * envelope alone, and every refused job leaves a denied audit record on its own connection.
 */
export function jobGuard(db: Db, log: Logger) {
  return {
    async resolveOrg(resource: JobResource): Promise<string | null> {
      if (!resolvable(resource.type)) throw new PortError('unsupported', `resolve_job_org does not know ${resource.type}`);
      if (!isUuid(resource.id)) return null;
      return resolveJobOrg(db, resource.type, resource.id);
    },

    async onRejected(r: JobRejectionReport): Promise<void> {
      log.warn({ queue: r.name, jobId: r.id, reason: r.reason, claimedOrgId: r.claimedOrgId, resolvedOrgId: r.resolvedOrgId }, 'job rejected');
      // Filed under the org that owns the resource when the database named one; the claim alone is untrusted.
      await appendAuditDetached(db, r.resolvedOrgId, {
        actorKind: 'system',
        action: 'job.rejected',
        resourceType: r.resource?.type ?? 'job',
        resourceId: r.resource?.id ?? r.id,
        outcome: 'denied',
        reason: r.reason,
        requestId: `job:${r.id}`,
        metadata: { queue: r.name, jobId: r.id, claimedOrgId: r.claimedOrgId },
      });
    },
  };
}
