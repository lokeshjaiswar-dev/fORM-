import { sql } from 'drizzle-orm';
import { canonicalJson } from '@form/schema';
import type { Executor } from '../client.ts';
import type { CheckpointAlg } from '../schema/index.ts';
import { toHex } from './record.ts';
import type { StoredCheckpoint } from './verify.ts';

/** What a checkpoint signature covers. */
export interface CheckpointStatement {
  orgKey: string;
  seq: number;
  hash: Uint8Array;
  signedAt: Date;
  keyId: string;
  alg: CheckpointAlg;
}

/** The signed bytes: JCS of `{ v, type, orgKey, seq, hash (hex), signedAt, keyId, alg }`. */
export function checkpointMessage(s: CheckpointStatement): Uint8Array {
  return new TextEncoder().encode(
    canonicalJson({ v: 1, type: 'fr.audit.checkpoint', orgKey: s.orgKey, seq: s.seq, hash: toHex(s.hash), signedAt: s.signedAt.toISOString(), keyId: s.keyId, alg: s.alg }),
  );
}

/** Stores a signed checkpoint of the current tenant's chain; the insert trigger refuses one that names no real link. */
export async function recordCheckpoint(tx: Executor, cp: StoredCheckpoint & { anchoredObject: string | null }): Promise<void> {
  await tx.execute(sql`insert into audit_checkpoints (org_key, seq, hash, signed_at, key_id, alg, signature, anchored_object)
    values (${cp.orgKey}, ${cp.seq}, ${Buffer.from(cp.hash)}, ${cp.signedAt.toISOString()}, ${cp.keyId}, ${cp.alg}, ${Buffer.from(cp.signature)}, ${cp.anchoredObject})`);
}

export async function latestCheckpointSeq(tx: Executor): Promise<number | null> {
  const { rows } = await tx.execute<{ seq: string | number | null }>(sql`select max(seq) as seq from audit_checkpoints where org_key = app_org()`);
  const seq = rows[0]?.seq;
  return seq == null ? null : Number(seq);
}
