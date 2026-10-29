import { sql } from 'drizzle-orm';
import type { Db, Executor, Tx } from '../client.ts';
import { PLATFORM_ORG_KEY } from '../schema/columns.ts';
import { withTenant } from '../tenant.ts';
import { chainHash, recordFromPending, toHex, type AuditInstant, type AuditRecord } from './record.ts';

export interface ChainHead {
  seq: number;
  hash: Uint8Array;
}

export interface ChainResult {
  /** False when another chainer holds the head; it is moving the rows already. */
  acquired: boolean;
  chained: number;
  head: ChainHead | null;
  /** Milliseconds from the oldest chained event's `occurred_at` to the moment it was chained. */
  maxLagMs: number;
}

export interface ChainOptions {
  /** Pending rows per statement (default 500). */
  batchSize?: number;
  /** Rows per call, so one transaction stays short (default 5000). */
  maxRows?: number;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
}

type PendingRow = {
  id: string | number;
  event: unknown;
  occurred_at: AuditInstant;
};

/** The audit_log_append() row of a hashed record (json, hashes as hex). */
function appendRow(record: AuditRecord, prevHash: Uint8Array, hash: Uint8Array): Record<string, unknown> {
  const { v: _v, orgKey: _orgKey, ...cols } = record;
  return {
    seq: cols.seq,
    occurred_at: cols.occurredAt,
    actor_kind: cols.actorKind,
    actor_id: cols.actorId,
    impersonator_id: cols.impersonatorId,
    session_id: cols.sessionId,
    api_key_id: cols.apiKeyId,
    actor_ip_hash: cols.actorIpHash,
    actor_ua: cols.actorUa,
    action: cols.action,
    resource_type: cols.resourceType,
    resource_id: cols.resourceId,
    form_id: cols.formId,
    outcome: cols.outcome,
    reason: cols.reason,
    metadata: cols.metadata,
    request_id: cols.requestId,
    trace_id: cols.traceId,
    prev_hash: toHex(prevHash),
    hash: toHex(hash),
  };
}

const asBytes = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(Buffer.from(String(v).replace(/^\\x/, ''), 'hex')));

/**
 * One `audit.chain` pass over the chain of the current tenant (`withTenant` on the org key, actor `system`): takes
 * the head (or returns when another chainer has it), moves pending rows in id order into `audit_log` with
 * `hash = sha256(prev_hash ‖ JCS(record))`, and lets the continuity trigger advance the head. Everything commits
 * or rolls back with `tx`; business transactions never touch the head (F-21).
 */
export async function chainPending(tx: Tx, orgKey: string, o: ChainOptions = {}): Promise<ChainResult> {
  const batchSize = o.batchSize ?? 500;
  const maxRows = o.maxRows ?? 5000;
  const now = o.now ?? Date.now;
  const { rows: heads } = await tx.execute<{ seq: string | number; hash: unknown }>(sql`select seq, hash from audit_chain_begin()`);
  const first = heads[0];
  if (!first) return { acquired: false, chained: 0, head: null, maxLagMs: 0 };
  let head: ChainHead = { seq: Number(first.seq), hash: asBytes(first.hash) };
  let chained = 0;
  let maxLagMs = 0;
  while (chained < maxRows) {
    const { rows } = await tx.execute<PendingRow>(sql`select id, event, occurred_at from audit_pending_take(${Math.min(batchSize, maxRows - chained)})`);
    if (rows.length === 0) break;
    const batch: Record<string, unknown>[] = [];
    const at = now();
    for (const r of rows) {
      const record = recordFromPending(orgKey, head.seq + 1, r.occurred_at, r.event);
      const hash = chainHash(head.hash, record);
      batch.push(appendRow(record, head.hash, hash));
      head = { seq: record.seq, hash };
      maxLagMs = Math.max(maxLagMs, at - Date.parse(r.occurred_at));
    }
    await tx.execute(sql`select audit_log_append(${JSON.stringify(batch)}::jsonb)`);
    chained += rows.length;
    if (rows.length < batchSize) break;
  }
  return { acquired: true, chained, head, maxLagMs };
}

export interface PendingChain {
  orgKey: string;
  oldest: Date;
  pending: number;
}

/** The cross-chain functions run as a system actor inside the platform tenant. */
export const asPlatformSystem = <T>(db: Db, requestId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withTenant(db, { orgId: PLATFORM_ORG_KEY, actor: 'system', requestId }, fn);

/** Chains with pending rows, oldest first (`audit_pending_keys()`): what the dispatcher enqueues `audit.chain` for. */
export async function auditPendingKeys(db: Db): Promise<PendingChain[]> {
  const { rows } = await asPlatformSystem(db, 'audit.dispatch', (tx) =>
    tx.execute<{ org_key: string; oldest: Date | string; pending: string | number }>(sql`select org_key, oldest, pending from audit_pending_keys()`),
  );
  return rows.map((r) => ({ orgKey: r.org_key, oldest: new Date(r.oldest), pending: Number(r.pending) }));
}

/** Every chain that exists, the platform chain included (`audit_chain_keys()`). */
export async function auditChainKeys(db: Db): Promise<string[]> {
  const { rows } = await asPlatformSystem(db, 'audit.keys', (tx) => tx.execute<{ org_key: string }>(sql`select org_key from audit_chain_keys() as org_key`));
  return rows.map((r) => r.org_key);
}

/** The head of the current tenant's chain, or null before its first link. */
export async function auditHead(tx: Executor): Promise<ChainHead | null> {
  const { rows } = await tx.execute<{ seq: string | number; hash: unknown }>(sql`select seq, hash from audit_heads where org_key = app_org()`);
  const h = rows[0];
  return h && Number(h.seq) > 0 ? { seq: Number(h.seq), hash: asBytes(h.hash) } : null;
}

export { asBytes };
