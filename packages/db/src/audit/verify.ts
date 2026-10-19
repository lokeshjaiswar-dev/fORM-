import { sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../client.ts';
import type { AuditOutcome, CheckpointAlg } from '../schema/index.ts';
import { asBytes, auditHead } from './chain.ts';
import { AUDIT_GENESIS, bytesEqual, chainHash, toHex, type AuditRecord } from './record.ts';

export type VerifyProblemCode =
  | 'hash_mismatch'
  | 'link_broken'
  | 'bad_genesis'
  | 'rows_missing'
  | 'head_mismatch'
  | 'head_behind'
  | 'count_mismatch'
  | 'archive_mismatch'
  | 'checkpoint_mismatch'
  | 'checkpoint_signature';

export interface VerifyProblem {
  code: VerifyProblemCode;
  seq?: number;
}

export interface StoredCheckpoint {
  orgKey: string;
  seq: number;
  hash: Uint8Array;
  signedAt: Date;
  keyId: string;
  alg: CheckpointAlg;
  signature: Uint8Array;
}

export interface VerifyOptions {
  /** Checks a checkpoint's signature (the KMS port lives in the worker). */
  verifySignature: (cp: StoredCheckpoint) => Promise<boolean>;
  /** Rows per page (default 1000). */
  pageSize?: number;
  /** Stop collecting after this many problems (default 20). */
  maxProblems?: number;
  /** Called after each page with the rows checked so far. */
  afterPage?: (rowsChecked: number) => Promise<void>;
}

export interface VerifyReport {
  orgKey: string;
  ok: boolean;
  headSeq: number;
  rowsChecked: number;
  archivedRows: number;
  checkpointsChecked: number;
  latestCheckpointSeq: number | null;
  problems: VerifyProblem[];
}

type ArchiveRow = { month: string; min_seq: string | number; max_seq: string | number; row_count: string | number; attached: boolean; online: string | number };

type LogRow = {
  seq: string | number;
  occurred_at: string;
  actor_kind: string;
  actor_id: string | null;
  impersonator_id: string | null;
  session_id: string | null;
  api_key_id: string | null;
  actor_ip_hash: unknown;
  actor_ua: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  form_id: string | null;
  outcome: AuditOutcome;
  reason: string | null;
  metadata: Record<string, unknown>;
  request_id: string | null;
  trace_id: string | null;
  prev_hash: unknown;
  hash: unknown;
};

const OCCURRED_AT = sql.raw(`to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

/** A stored audit_log row as the record its hash covers. */
export function recordFromRow(orgKey: string, r: LogRow): AuditRecord {
  return {
    v: 1,
    orgKey,
    seq: Number(r.seq),
    occurredAt: r.occurred_at,
    actorKind: r.actor_kind,
    actorId: r.actor_id,
    impersonatorId: r.impersonator_id,
    sessionId: r.session_id,
    apiKeyId: r.api_key_id,
    actorIpHash: r.actor_ip_hash == null ? null : toHex(asBytes(r.actor_ip_hash)),
    actorUa: r.actor_ua,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    formId: r.form_id,
    outcome: r.outcome,
    reason: r.reason,
    metadata: r.metadata,
    requestId: r.request_id,
    traceId: r.trace_id,
  };
}

export interface ChainLink {
  record: AuditRecord;
  prevHash: Uint8Array;
  hash: Uint8Array;
}

/** Links of the current tenant's chain matching `where`, in seq order. */
export async function readChainWhere(tx: Executor, where: SQL, limit: number): Promise<ChainLink[]> {
  const { rows } = await tx.execute<LogRow & { org_id: string }>(sql`
    select org_id, seq, ${OCCURRED_AT} as occurred_at, actor_kind, actor_id, impersonator_id, session_id, api_key_id, actor_ip_hash,
      actor_ua, action, resource_type, resource_id, form_id, outcome, reason, metadata, request_id, trace_id, prev_hash, hash
    from audit_log where org_id = app_org() and ${where} order by seq limit ${limit}`);
  return rows.map((r) => ({ record: recordFromRow(r.org_id, r), prevHash: asBytes(r.prev_hash), hash: asBytes(r.hash) }));
}

/** Links of the current tenant's chain with `seq > after`. */
export const readChain = (tx: Executor, after: number, limit: number): Promise<ChainLink[]> => readChainWhere(tx, sql`seq > ${after}`, limit);

export async function listCheckpoints(tx: Executor): Promise<StoredCheckpoint[]> {
  const { rows } = await tx.execute<{ org_key: string; seq: string | number; hash: unknown; signed_at: Date; key_id: string; alg: CheckpointAlg; signature: unknown }>(
    sql`select org_key, seq, hash, signed_at, key_id, alg, signature from audit_checkpoints where org_key = app_org() order by seq`,
  );
  return rows.map((r) => ({
    orgKey: r.org_key,
    seq: Number(r.seq),
    hash: asBytes(r.hash),
    signedAt: new Date(r.signed_at),
    keyId: r.key_id,
    alg: r.alg,
    signature: asBytes(r.signature),
  }));
}

/**
 * `audit.verify` for the chain of the current tenant: recomputes every online link's hash, checks each link
 * against the one before it, that the gaps are exactly the archived months, that the last link is the head, and
 * that every checkpoint names a real link and carries a valid signature. Read-only. The head, the archives, the
 * checkpoints and every page must come from one snapshot, so the transaction must be repeatable read or
 * serializable: under read committed a chainer committing between two statements would look like tampering.
 * An archived month whose partition is still attached (`audit.archive` stopped before the detach) stays part of
 * the walk; its online rows must match the archive's count. Only detached months fill gaps and count as archived.
 */
export async function verifyChain(tx: Executor, orgKey: string, o: VerifyOptions): Promise<VerifyReport> {
  const pageSize = o.pageSize ?? 1000;
  const maxProblems = o.maxProblems ?? 20;
  const problems: VerifyProblem[] = [];
  const problem = (code: VerifyProblemCode, seq?: number) => {
    if (problems.length < maxProblems) problems.push(seq === undefined ? { code } : { code, seq });
  };

  const { rows: level } = await tx.execute<{ level: string }>(sql`select current_setting('transaction_isolation') as level`);
  if (level[0]?.level !== 'repeatable read' && level[0]?.level !== 'serializable') {
    throw new Error(`verifyChain: needs a repeatable read transaction (one snapshot), got ${level[0]?.level ?? 'none'}`);
  }

  const head = await auditHead(tx);
  const headSeq = head?.seq ?? 0;
  // A detach takes an exclusive lock on audit_log, which this transaction's reads block, so attachment cannot
  // change during the walk.
  const { rows: archives } = await tx.execute<ArchiveRow>(sql`
    select a.month, a.min_seq, a.max_seq, a.row_count,
      exists (
        select 1 from pg_inherits i join pg_class c on c.oid = i.inhrelid join pg_namespace n on n.oid = c.relnamespace
        where i.inhparent = 'public.audit_log'::regclass and n.nspname = 'parts' and c.relname = 'audit_log_' || replace(a.month, '-', '_')
      ) as attached,
      (select count(*) from audit_log l where l.org_id = app_org()
        and l.occurred_at >= (a.month || '-01')::timestamp at time zone 'UTC'
        and l.occurred_at < ((a.month || '-01')::timestamp + interval '1 month') at time zone 'UTC') as online
    from audit_archives a where a.org_key = app_org() order by a.min_seq`);
  const offline: { min: number; max: number }[] = [];
  let archivedRows = 0;
  for (const a of archives) {
    if (a.attached) {
      if (Number(a.online) !== Number(a.row_count)) problem('archive_mismatch', Number(a.min_seq));
      continue;
    }
    offline.push({ min: Number(a.min_seq), max: Number(a.max_seq) });
    archivedRows += Number(a.row_count);
  }
  const offlineRange = (seq: number) => offline.find((r) => seq >= r.min && seq <= r.max);
  const archived = (seq: number) => offlineRange(seq) !== undefined;
  /** The first seq in `[from, to)` that is neither online (the caller saw none) nor in a detached month. */
  const firstMissing = (from: number, to: number): number | null => {
    for (let s = from; s < to; ) {
      const r = offlineRange(s);
      if (!r) return s;
      s = r.max + 1;
    }
    return null;
  };
  const checkpoints = await listCheckpoints(tx);
  const pendingCheckpoints = new Map(checkpoints.map((c) => [c.seq, c]));

  let rowsChecked = 0;
  let prev: { seq: number; hash: Uint8Array } = { seq: 0, hash: AUDIT_GENESIS };
  let last: { seq: number; hash: Uint8Array } | null = null;
  for (;;) {
    const page = await readChain(tx, prev.seq, pageSize);
    for (const row of page) {
      const { seq } = row.record;
      rowsChecked += 1;
      if (!bytesEqual(chainHash(row.prevHash, row.record), row.hash)) problem('hash_mismatch', seq);
      if (seq === prev.seq + 1) {
        if (!bytesEqual(row.prevHash, prev.hash)) problem(seq === 1 ? 'bad_genesis' : 'link_broken', seq);
      } else {
        const missing = firstMissing(prev.seq + 1, seq);
        if (missing !== null) problem('rows_missing', missing);
      }
      const cp = pendingCheckpoints.get(seq);
      if (cp) {
        if (!bytesEqual(cp.hash, row.hash)) problem('checkpoint_mismatch', seq);
        pendingCheckpoints.delete(seq);
      }
      prev = { seq, hash: row.hash };
      last = prev;
    }
    if (page.length < pageSize) break;
    await o.afterPage?.(rowsChecked);
  }

  if (last === null ? headSeq > 0 && !archived(headSeq) : last.seq < headSeq && !archived(headSeq)) problem('rows_missing', headSeq);
  if (last !== null && last.seq > headSeq) problem('head_behind', last.seq);
  if (head && last && last.seq === head.seq && !bytesEqual(last.hash, head.hash)) problem('head_mismatch', head.seq);
  if (rowsChecked + archivedRows !== headSeq) problem('count_mismatch');
  for (const cp of pendingCheckpoints.values()) if (!archived(cp.seq)) problem('checkpoint_mismatch', cp.seq);
  for (const cp of checkpoints) if (!(await o.verifySignature(cp))) problem('checkpoint_signature', cp.seq);

  return {
    orgKey,
    ok: problems.length === 0,
    headSeq,
    rowsChecked,
    archivedRows,
    checkpointsChecked: checkpoints.length,
    latestCheckpointSeq: checkpoints.at(-1)?.seq ?? null,
    problems,
  };
}
