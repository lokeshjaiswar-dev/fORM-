import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createZstdCompress } from 'node:zlib';
import {
  archivableAttachedMonths,
  archiveLines,
  audit,
  auditChainKeys,
  auditHead,
  detachArchivedMonth,
  isArchivable,
  isAuditMonth,
  isMonthArchived,
  latestCheckpointSeq,
  listCheckpoints,
  recordArchive,
  recordCheckpoint,
  toHex,
  verifyChain,
  withTenant,
  type Db,
  type StoredCheckpoint,
  type Tx,
  type VerifyReport,
} from '@form/db';
import type { Logger } from 'pino';
import { toIsoInstant, type AuditCheckpoint, type AuditSink, type KeyProvider, type ReceivedJob, type Storage } from '@form/ports';
import { checkpointSigner } from '../audit/signatures.ts';
import { defineJob, type AnyJobDefinition } from './define.ts';

export interface AuditJobDeps {
  keys: KeyProvider;
  /** The platform audit signing key (an app-held Ed25519 key wrapped by the KMS by default). */
  signingKeyId: string;
  /** Earlier audit signing keys whose checkpoints still verify; a checkpoint under any other key id fails. */
  retiredSigningKeyIds?: readonly string[] | undefined;
  /** The `audit` bucket: checkpoints go there when it has Object Lock, archives always (absent: no archive job). */
  storage?: Storage | undefined;
  /** The WORM bucket sink over `storage` (`createWormBucketAuditSink`), used while the bucket has Object Lock. */
  worm?: (AuditSink & { objectKey(cp: Pick<AuditCheckpoint, 'orgKey' | 'seq'>): string }) | undefined;
  /** syslog/SIEM fallback for checkpoints when the bucket has no Object Lock. */
  sink?: AuditSink | undefined;
  /** Production refuses a checkpoint it cannot anchor anywhere and an archive outside a WORM bucket; development warns. */
  requireAnchor: boolean;
  /** Separate small pool for detached (error) audit records. */
  auditWriter: Db;
  /** Object Lock retention of checkpoints and archives (default 7 years). */
  retentionYears?: number;
  now?: () => Date;
}

const ctxFor = (orgKey: string, jobId: string) => ({ orgId: orgKey, actor: 'system' as const, requestId: `job:${jobId}` });

interface ArchiveStats {
  rows: number;
  checkpoints: number;
  minSeq: number;
  maxSeq: number;
}

/**
 * One org-month as NDJSON, row by row from the database, closed by the month's signed checkpoints; null when the month
 * has no rows. Read lazily, so the object streams through zstd into a multipart upload instead of building in memory.
 */
async function archiveBody(tx: Tx, month: string, stats: ArchiveStats): Promise<AsyncIterable<string> | null> {
  const rows = archiveLines(tx, month)[Symbol.asyncIterator]();
  const first = await rows.next();
  if (first.done) return null;
  return (async function* () {
    for (let r: IteratorResult<{ line: string; seq: number }> = first; !r.done; r = await rows.next()) {
      if (stats.rows === 0) stats.minSeq = r.value.seq;
      stats.maxSeq = r.value.seq;
      stats.rows += 1;
      yield `${r.value.line}\n`;
    }
    for (const cp of await listCheckpoints(tx)) {
      if (cp.seq < stats.minSeq || cp.seq > stats.maxSeq) continue;
      stats.checkpoints += 1;
      yield `${JSON.stringify({ checkpoint: toWireCheckpoint(cp) })}\n`;
    }
  })();
}

/** zstd-compressed bytes of `lines`, hashing them on the way out. */
async function* compressed(lines: AsyncIterable<string>, hash: ReturnType<typeof createHash>): AsyncGenerator<Uint8Array> {
  for await (const chunk of Readable.from(lines).pipe(createZstdCompress()) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
}

export function toWireCheckpoint(cp: StoredCheckpoint, anchoredObject?: string): AuditCheckpoint {
  return {
    orgKey: cp.orgKey,
    seq: cp.seq,
    hash: toHex(cp.hash),
    signedAt: toIsoInstant(cp.signedAt),
    keyId: cp.keyId,
    alg: cp.alg,
    signature: Buffer.from(cp.signature).toString('base64url'),
    ...(anchoredObject ? { anchoredObject } : {}),
  };
}

/** `audit.checkpoint`, `audit.verify` and, with storage, `audit.archive` (architecture §2.7, §5.2). */
export function createAuditJobs(deps: AuditJobDeps): AnyJobDefinition[] {
  const now = deps.now ?? (() => new Date());
  const retentionYears = deps.retentionYears ?? 7;
  const retainUntil = () => {
    const d = now();
    return new Date(Date.UTC(d.getUTCFullYear() + retentionYears, d.getUTCMonth(), d.getUTCDate()));
  };
  const objectLock = async () => (deps.storage ? (await deps.storage.capabilities()).objectLock : false);

  /** WORM bucket when the store has Object Lock, else the SIEM sink; returns where the checkpoint went. */
  async function anchor(cp: StoredCheckpoint, worm: boolean): Promise<string | null> {
    if (worm && deps.worm) {
      await deps.worm.forward(toWireCheckpoint(cp));
      return `bucket:audit/${deps.worm.objectKey(cp)}`;
    }
    if (deps.sink) {
      await deps.sink.forward(toWireCheckpoint(cp));
      return `${deps.sink.kind}:${cp.orgKey}/${cp.seq}`;
    }
    if (deps.requireAnchor) throw new Error('audit.checkpoint: the audit bucket has no Object Lock and no audit sink is configured');
    return null;
  }

  const checkpoint = defineJob({
    name: 'audit.checkpoint',
    perms: [],
    cron: '5 * * * *',
    async run({ db, log, job }) {
      const signer = checkpointSigner(deps.keys, deps.signingKeyId, deps.retiredSigningKeyIds);
      const worm = await objectLock();
      let signed = 0;
      for (const key of await auditChainKeys(db)) {
        job.signal.throwIfAborted();
        await withTenant(db, ctxFor(key, job.id), async (tx) => {
          const head = await auditHead(tx);
          if (!head || (await latestCheckpointSeq(tx)) === head.seq) return;
          const cp = await signer.sign({ orgKey: key, seq: head.seq, hash: head.hash, signedAt: now() });
          const anchoredObject = await anchor(cp, worm);
          if (anchoredObject === null) log.warn({ orgKey: key, seq: cp.seq }, 'audit checkpoint not anchored (development: no Object Lock, no sink)');
          await recordCheckpoint(tx, { ...cp, anchoredObject });
          signed += 1;
        });
      }
      log.info({ signed, anchor: worm ? 'bucket' : (deps.sink?.kind ?? 'none') }, 'audit checkpoints signed');
    },
  });

  const verify = defineJob({
    name: 'audit.verify',
    perms: [],
    cron: '30 2 * * *',
    async run({ db, log, job }) {
      const signer = checkpointSigner(deps.keys, deps.signingKeyId, deps.retiredSigningKeyIds);
      const failed: VerifyReport[] = [];
      let verified = 0;
      for (const key of await auditChainKeys(db)) {
        job.signal.throwIfAborted();
        // One snapshot: links the dispatcher commits meanwhile are not part of this walk.
        const report = await withTenant(db, { ...ctxFor(key, job.id), isolation: 'repeatable read' }, async (tx) => {
          const r = await verifyChain(tx, key, { verifySignature: (cp) => signer.verify(cp) });
          if (r.ok) {
            await audit.append(tx, key, {
              actorKind: 'system',
              action: 'audit.verified',
              resourceType: 'audit_chain',
              resourceId: key,
              outcome: 'success',
              requestId: `job:${job.id}`,
              metadata: { headSeq: r.headSeq, rowsChecked: r.rowsChecked, archivedRows: r.archivedRows, checkpointsChecked: r.checkpointsChecked },
            });
          }
          return r;
        });
        verified += 1;
        if (report.ok) continue;
        failed.push(report);
        log.error({ orgKey: key, problems: report.problems, headSeq: report.headSeq }, 'audit chain verification failed');
        await audit.appendDetached(deps.auditWriter, key, {
          actorKind: 'system',
          action: 'audit.verified',
          resourceType: 'audit_chain',
          resourceId: key,
          outcome: 'error',
          reason: report.problems[0]?.code ?? 'unknown',
          requestId: `job:${job.id}`,
          metadata: { headSeq: report.headSeq, problems: report.problems.map((p) => `${p.code}${p.seq === undefined ? '' : `@${p.seq}`}`) },
        });
      }
      log.info({ verified, failed: failed.length }, 'audit chains verified');
    },
  });

  if (!deps.storage) return [checkpoint, verify];
  const storage = deps.storage;

  const archive = defineJob({
    name: 'audit.archive',
    perms: [],
    cron: '0 3 2 * *',
    async run({ db, log, job }) {
      const asked = job.envelope.data.month;
      if (asked !== undefined && !isAuditMonth(asked)) throw new Error(`audit.archive: month must be YYYY-MM, got ${JSON.stringify(asked)}`);
      if (asked !== undefined && !isArchivable(asked, now())) throw new Error(`audit.archive: ${asked} is inside the 13-month online window`);
      const worm = await objectLock();
      if (!worm && deps.requireAnchor) throw new Error('audit.archive: the audit bucket has no Object Lock; archives go only to a WORM bucket');
      // The cron run takes every attached month outside the window, oldest first, so a month whose run gave up (a
      // detach that kept missing its lock) is picked up again instead of staying online for good (BL-196).
      const months = asked !== undefined ? [asked] : await archivableAttachedMonths(db, now());
      const failed: string[] = [];
      for (const month of months) {
        try {
          await archiveMonth(db, log, job, month, worm);
        } catch (err) {
          if (months.length === 1) throw err;
          failed.push(month);
          log.error({ err, month }, 'audit month not archived; it stays attached until the next run');
        }
      }
      if (failed.length > 0) throw new Error(`audit.archive: ${failed.join(', ')} still attached after this run`);
      if (!worm && months.length > 0) log.warn('audit archives written without Object Lock (development: the store does not support it)');
    },
  });

  async function archiveMonth(db: Db, log: Logger, job: ReceivedJob<'audit.archive'>, month: string, worm: boolean): Promise<void> {
    let archived = 0;
    for (const key of await auditChainKeys(db)) {
      job.signal.throwIfAborted();
      await withTenant(db, ctxFor(key, job.id), async (tx) => {
        if (await isMonthArchived(tx, month)) return;
        // The month's signed checkpoints close the object, so the archive verifies against signatures on its own.
        const stats: ArchiveStats = { rows: 0, checkpoints: 0, minSeq: 0, maxSeq: 0 };
        const lines = await archiveBody(tx, month, stats);
        if (!lines) return;
        const hash = createHash('sha256');
        const objectKey = `archive/${key}/${month}.ndjson.zst`;
        await storage.put('audit', objectKey, compressed(lines, hash), {
          contentType: 'application/zstd',
          ...(worm ? { objectLock: { mode: 'compliance' as const, retainUntil: retainUntil() } } : {}),
        });
        const sha256 = new Uint8Array(hash.digest());
        const { rows: rowCount, minSeq, maxSeq } = stats;
        await recordArchive(tx, { orgKey: key, month, objectKey, rowCount, minSeq, maxSeq, sha256 });
        await audit.append(tx, key, {
          actorKind: 'system',
          action: 'audit.archived',
          resourceType: 'audit_chain',
          resourceId: key,
          outcome: 'success',
          requestId: `job:${job.id}`,
          metadata: { month, objectKey, rowCount, checkpoints: stats.checkpoints, minSeq, maxSeq, sha256: toHex(sha256), objectLock: worm },
        });
        archived += 1;
      });
    }
    const detached = await detachArchivedMonth(db, month);
    log.info({ month, archived, detached, objectLock: worm }, 'audit month archived');
  }

  return [checkpoint, verify, archive];
}
