import type { IsoInstant, SignatureAlg } from './common.ts';

/** One row of `audit_checkpoints` (architecture §2.7), in wire form. */
export interface AuditCheckpoint {
  orgKey: string;
  seq: number;
  /** Lower-case hex SHA-256 of the chain head. */
  hash: string;
  signedAt: IsoInstant;
  keyId: string;
  alg: SignatureAlg;
  /** base64url. */
  signature: string;
  anchoredObject?: string;
}

/** WORM bucket where Object Lock exists, else syslog / OTLP / SIEM. */
export interface AuditSink {
  readonly kind: 'worm_bucket' | 'syslog' | 'otlp';
  forward(checkpoint: AuditCheckpoint): Promise<void>;
}
