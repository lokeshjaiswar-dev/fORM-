import { PortError, type AuditCheckpoint, type AuditSink, type Storage } from '@form/ports';
import { checkCheckpoint } from './checkpoint.ts';

export interface WormBucketAuditSinkOptions {
  /** The store whose `audit` bucket has Object Lock (`capabilities().objectLock`). */
  storage: Storage;
  /** Compliance-mode retention of each checkpoint (`AUDIT_RETENTION_YEARS`, default 7). */
  retentionYears?: number;
  now?: () => Date;
}

/** Where a checkpoint lands in the `audit` bucket; seq zero-padded so keys sort by seq. */
export const checkpointObjectKey = (cp: Pick<AuditCheckpoint, 'orgKey' | 'seq'>) => `checkpoints/${cp.orgKey}/${String(cp.seq).padStart(20, '0')}.json`;

export interface WormBucketAuditSink extends AuditSink {
  readonly kind: 'worm_bucket';
  /** Whether the bucket has Object Lock; without it `forward` is PortError('unsupported') and the SIEM sink takes over. */
  available(): Promise<boolean>;
  /** The `audit` bucket key `forward` writes the checkpoint to (`checkpointObjectKey`). */
  objectKey(cp: Pick<AuditCheckpoint, 'orgKey' | 'seq'>): string;
}

/**
 * The WORM anchor of architecture §2.7: each checkpoint as JSON in the `audit` bucket under compliance-mode Object
 * Lock, so not even the account root can delete it before `retainUntil`. Never writes an unlocked copy.
 */
export function createWormBucketAuditSink(o: WormBucketAuditSinkOptions): WormBucketAuditSink {
  const now = o.now ?? (() => new Date());
  const years = o.retentionYears ?? 7;
  const available = async () => (await o.storage.capabilities()).objectLock;
  return {
    kind: 'worm_bucket',
    available,
    objectKey: checkpointObjectKey,
    async forward(cp) {
      checkCheckpoint(cp);
      if (!(await available())) throw new PortError('unsupported', 'the audit bucket has no Object Lock');
      const d = now();
      const retainUntil = new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate()));
      await o.storage.put('audit', checkpointObjectKey(cp), new TextEncoder().encode(JSON.stringify(cp)), {
        contentType: 'application/json',
        objectLock: { mode: 'compliance', retainUntil },
      });
    },
  };
}
