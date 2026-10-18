import { bigint, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea, ts } from './columns.ts';

export const AUDIT_OUTCOMES = ['success', 'denied', 'error'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** Append-only for fr_app (INSERT only). RLS: `audit_pending_append`. */
export const auditPending = pgTable('audit_pending', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  orgKey: uuid('org_key').notNull(),
  event: jsonb('event').$type<Record<string, unknown>>().notNull(),
  occurredAt: ts('occurred_at'),
});

/** Partitioned by month on `occurred_at`; partitions live in schema `parts`. RLS: `audit_log_tenant`. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
    orgId: uuid('org_id'),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    actorKind: text('actor_kind').notNull(),
    actorId: uuid('actor_id'),
    impersonatorId: uuid('impersonator_id'),
    sessionId: uuid('session_id'),
    apiKeyId: uuid('api_key_id'),
    actorIpHash: bytea('actor_ip_hash'),
    actorUa: text('actor_ua'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    formId: uuid('form_id'),
    outcome: text('outcome', { enum: AUDIT_OUTCOMES }).notNull(),
    reason: text('reason'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    requestId: text('request_id'),
    traceId: text('trace_id'),
    prevHash: bytea('prev_hash').notNull(),
    hash: bytea('hash').notNull(),
  },
  (t) => [primaryKey({ columns: [t.id, t.occurredAt] })],
);
