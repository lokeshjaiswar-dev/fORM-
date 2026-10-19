import { createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import {
  archivableMonth,
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
  type VerifyReport,
} from '@form/db';
import { toIsoInstant, type AuditCheckpoint, type AuditSink, type KeyProvider, type Storage } from '@form/ports';
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
const pad = (seq: number) => String(seq).padStart(20, '0');

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
    if (worm && deps.storage) {
      const key = `checkpoints/${cp.orgKey}/${pad(cp.seq)}.json`;
      const body = new TextEncoder().encode(JSON.stringify(toWireCheckpoint(cp)));
      await deps.storage.put('audit', key, body, { contentType: 'application/json', objectLock: { mode: 'compliance', retainUntil: retainUntil() } });
      return `bucket:audit/${key}`;
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
      const month = job.envelope.data.month ?? archivableMonth(now());
      if (!isAuditMonth(month)) throw new Error(`audit.archive: month must be YYYY-MM, got ${JSON.stringify(month)}`);
      if (!isArchivable(month, now())) throw new Error(`audit.archive: ${month} is inside the 13-month online window`);
      const worm = await objectLock();
      if (!worm && deps.requireAnchor) throw new Error('audit.archive: the audit bucket has no Object Lock; archives go only to a WORM bucket');
      let archived = 0;
      for (const key of await auditChainKeys(db)) {
        job.signal.throwIfAborted();
        await withTenant(db, ctxFor(key, job.id), async (tx) => {
          if (await isMonthArchived(tx, month)) return;
          const lines: string[] = [];
          let minSeq = 0;
          let maxSeq = 0;
          for await (const l of archiveLines(tx, month)) {
            lines.push(l.line);
            if (minSeq === 0) minSeq = l.seq;
            maxSeq = l.seq;
          }
          if (lines.length === 0) return;
          const rowCount = lines.length;
          // The month's signed checkpoints close the object, so the archive verifies against signatures on its own.
          for (const cp of await listCheckpoints(tx)) {
            if (cp.seq >= minSeq && cp.seq <= maxSeq) lines.push(JSON.stringify({ checkpoint: toWireCheckpoint(cp) }));
          }
          const body = new Uint8Array(zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')));
          const objectKey = `archive/${key}/${month}.ndjson.zst`;
          await storage.put('audit', objectKey, body, {
            contentType: 'application/zstd',
            ...(worm ? { objectLock: { mode: 'compliance' as const, retainUntil: retainUntil() } } : {}),
          });
          const sha256 = new Uint8Array(createHash('sha256').update(body).digest());
          await recordArchive(tx, { orgKey: key, month, objectKey, rowCount, minSeq, maxSeq, sha256 });
          await audit.append(tx, key, {
            actorKind: 'system',
            action: 'audit.archived',
            resourceType: 'audit_chain',
            resourceId: key,
            outcome: 'success',
            requestId: `job:${job.id}`,
            metadata: { month, objectKey, rowCount, checkpoints: lines.length - rowCount, minSeq, maxSeq, sha256: toHex(sha256), objectLock: worm },
          });
          archived += 1;
        });
      }
      const detached = await detachArchivedMonth(db, month);
      log.info({ month, archived, detached, objectLock: worm }, 'audit month archived');
      if (!worm) log.warn('audit archives written without Object Lock (development: the store does not support it)');
    },
  });

  return [checkpoint, verify, archive];
}
