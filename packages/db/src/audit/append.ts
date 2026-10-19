import { sql } from 'drizzle-orm';
import type { Db, Tx } from '../client.ts';
import { auditPending, PLATFORM_ORG_KEY, type AuditOutcome } from '../schema/index.ts';
import { ACTOR_KINDS, isUuid, type ActorKind, type TenantCtx } from '../tenant.ts';
import { AUDIT_EVENTS, isAuditAction, type AuditAction } from './catalogue.ts';
import { AUDIT_TEXT_LIMITS } from './record.ts';
import { scrubAuditMetadata } from './scrub.ts';

/**
 * An `audit_pending.event`. Never carries answer values (architecture §2.7): `metadata` is scrubbed here, and the
 * lint rule `form-audit/no-answer-values` checks every `audit.append()` call site.
 */
export interface AuditEvent {
  actorKind: ActorKind | 'none';
  actorId?: string | null | undefined;
  impersonatorId?: string | null | undefined;
  sessionId?: string | null | undefined;
  apiKeyId?: string | null | undefined;
  /** Lower-case hex of a keyed hash of the client IP; never the IP. */
  actorIpHash?: string | null | undefined;
  actorUa?: string | null | undefined;
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null | undefined;
  formId?: string | null | undefined;
  outcome: AuditOutcome;
  reason?: string | null | undefined;
  requestId?: string | null | undefined;
  traceId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/** The actor fields of an event from a verified tenant context. */
export function auditActor(ctx: Pick<TenantCtx, 'actor' | 'userId' | 'requestId'>): Pick<AuditEvent, 'actorKind' | 'actorId' | 'requestId'> {
  return { actorKind: ctx.actor, actorId: ctx.userId ?? null, requestId: ctx.requestId };
}

const UUID_FIELDS = ['actorId', 'impersonatorId', 'sessionId', 'apiKeyId', 'formId'] as const;

/** Validates and normalises an event: a catalogued action with one of its outcomes, real ids, capped text, scrubbed metadata. */
export function normaliseAuditEvent(event: AuditEvent, allowed: readonly AuditOutcome[]): Record<string, unknown> {
  const bad = (msg: string): never => {
    throw new TypeError(`audit.append: ${msg}`);
  };
  if (!isAuditAction(event.action)) bad(`unknown action ${JSON.stringify(event.action)}; add it to AUDIT_EVENTS`);
  const spec = AUDIT_EVENTS[event.action];
  if (!(spec.outcomes as readonly string[]).includes(event.outcome)) bad(`${event.action} is not recorded with outcome ${event.outcome}`);
  if (!allowed.includes(event.outcome)) {
    bad(`outcome ${event.outcome} goes ${event.outcome === 'success' ? 'in the business transaction (audit.append)' : 'on a separate connection (audit.appendDetached)'}`);
  }
  if (event.actorKind !== 'none' && !(ACTOR_KINDS as readonly string[]).includes(event.actorKind)) bad(`unknown actor kind ${event.actorKind}`);
  for (const f of UUID_FIELDS) if (event[f] != null && !isUuid(event[f])) bad(`${f} must be a uuid`);
  if (event.actorIpHash != null && !/^(?:[0-9a-f]{2}){16,64}$/.test(event.actorIpHash)) bad('actorIpHash must be lower-case hex');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (v === undefined || v === null || k === 'metadata') continue;
    const limit = AUDIT_TEXT_LIMITS[k as keyof typeof AUDIT_TEXT_LIMITS];
    out[k] = typeof v === 'string' && limit !== undefined && v.length > limit ? v.slice(0, limit) : v;
  }
  if (event.metadata !== undefined) out.metadata = scrubAuditMetadata(event.metadata);
  return out;
}

/**
 * Writes audit events (ADR-0006). `append` puts a success record in the business transaction, so it commits or
 * rolls back with the change; `appendDetached` puts a denied or failed record through a separate pool (the
 * audit writer) in a transaction of its own, so it survives the rollback (C-M7). `orgId` null files the event
 * under the platform chain. The `audit.chain` worker hashes the rows into `audit_log` within seconds.
 */
export const audit = {
  async append(tx: Tx, orgId: string, event: AuditEvent): Promise<void> {
    const normalised = normaliseAuditEvent(event, ['success']);
    await tx.insert(auditPending).values({ orgKey: orgId, event: normalised });
  },

  async appendDetached(writer: Db, orgId: string | null, event: AuditEvent): Promise<void> {
    const normalised = normaliseAuditEvent(event, ['denied', 'error']);
    await writer.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${orgId ?? ''}, true), set_config('app.actor_kind', ${event.actorKind}, true)`);
      await tx.insert(auditPending).values({ orgKey: orgId ?? PLATFORM_ORG_KEY, event: normalised });
    });
  },
};
