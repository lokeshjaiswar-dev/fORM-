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

/**
 * Partitioned by month on `occurred_at`; partitions live in schema `parts`. RLS: `audit_log_tenant` (SELECT only for
 * fr_app; rows arrive through `audit_log_append()`). Platform events carry the zero org key.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
    orgId: uuid('org_id').notNull(),
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

export const CHECKPOINT_ALGS = ['ed25519', 'es256'] as const;
export type CheckpointAlg = (typeof CHECKPOINT_ALGS)[number];

/** The last link of each chain; changed only by the continuity trigger. RLS: `audit_heads_tenant` (SELECT). */
export const auditHeads = pgTable('audit_heads', {
  orgKey: uuid('org_key').primaryKey(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  hash: bytea('hash').notNull(),
  updatedAt: ts('updated_at'),
});

/** Signed anchors of the heads (`audit.checkpoint`). Append-only. RLS: `audit_checkpoints_tenant`. */
export const auditCheckpoints = pgTable(
  'audit_checkpoints',
  {
    orgKey: uuid('org_key').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    hash: bytea('hash').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull(),
    keyId: text('key_id').notNull(),
    alg: text('alg', { enum: CHECKPOINT_ALGS }).notNull(),
    signature: bytea('signature').notNull(),
    anchoredObject: text('anchored_object'),
  },
  (t) => [primaryKey({ columns: [t.orgKey, t.seq] })],
);

/** One archived month of a chain (`audit.archive`). Append-only. RLS: `audit_archives_tenant`. */
export const auditArchives = pgTable(
  'audit_archives',
  {
    orgKey: uuid('org_key').notNull(),
    month: text('month').notNull(),
    objectKey: text('object_key').notNull(),
    rowCount: bigint('row_count', { mode: 'number' }).notNull(),
    minSeq: bigint('min_seq', { mode: 'number' }).notNull(),
    maxSeq: bigint('max_seq', { mode: 'number' }).notNull(),
    sha256: bytea('sha256').notNull(),
    archivedAt: ts('archived_at'),
  },
  (t) => [primaryKey({ columns: [t.orgKey, t.month] })],
);
