import { sql } from 'drizzle-orm';
import type { Db, Tx } from './client.ts';
import { auditPending, PLATFORM_ORG_KEY, type AuditOutcome } from './schema/index.ts';
import type { ActorKind } from './tenant.ts';

/** An `audit_pending.event`. Never carries answer values (architecture §2.7). */
export interface AuditEvent {
  actorKind: ActorKind | 'none';
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome: AuditOutcome;
  reason?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

/** Inside the business transaction: the record commits or rolls back with the change. */
export async function appendAudit(tx: Tx, orgId: string, event: AuditEvent): Promise<void> {
  await tx.insert(auditPending).values({ orgKey: orgId, event: { ...event } });
}

/**
 * Denied and failed actions: written in a transaction of their own on another pooled connection, so the
 * record survives the rollback of the business transaction (C-M7). `orgId` null files it under the
 * platform key.
 */
export async function appendAuditDetached(db: Db, orgId: string | null, event: AuditEvent): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId ?? ''}, true), set_config('app.actor_kind', ${event.actorKind}, true)`);
    await tx.insert(auditPending).values({ orgKey: orgId ?? PLATFORM_ORG_KEY, event: { ...event } });
  });
}
