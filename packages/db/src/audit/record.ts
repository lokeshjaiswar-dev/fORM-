import { createHash } from 'node:crypto';
import { canonicalJson } from '@form/schema';
import { AUDIT_OUTCOMES, type AuditOutcome } from '../schema/index.ts';
import { ACTOR_KINDS, isUuid } from '../tenant.ts';
import { scrubAuditMetadata, storableText } from './scrub.ts';

/** The prev_hash of seq 1: 32 zero bytes (`audit_genesis()`). */
export const AUDIT_GENESIS = new Uint8Array(32);

/** Text caps of the chained columns; longer values are cut at append and at chain time. */
export const AUDIT_TEXT_LIMITS = {
  action: 128,
  resourceType: 64,
  resourceId: 256,
  reason: 1024,
  actorUa: 512,
  requestId: 128,
  traceId: 128,
} as const;

/** An instant with microseconds in UTC (`YYYY-MM-DDTHH:MM:SS.ffffffZ`), exactly as Postgres stores it. */
export type AuditInstant = string;

/**
 * What a chain link hashes: every audit_log column but `id` and the hashes, plus a version. Hash of a link:
 * `sha256(prev_hash ‖ JCS(record))` (architecture §2.7). Absent values are explicit nulls, so a verifier
 * recomputes the hash from the stored row alone.
 */
export interface AuditRecord {
  v: 1;
  orgKey: string;
  seq: number;
  occurredAt: AuditInstant;
  actorKind: string;
  actorId: string | null;
  impersonatorId: string | null;
  sessionId: string | null;
  apiKeyId: string | null;
  /** Lower-case hex. */
  actorIpHash: string | null;
  actorUa: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  formId: string | null;
  outcome: AuditOutcome;
  reason: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  traceId: string | null;
}

export function chainHash(prevHash: Uint8Array, record: AuditRecord): Uint8Array {
  return new Uint8Array(createHash('sha256').update(prevHash).update(canonicalJson(record), 'utf8').digest());
}

const HEX = /^(?:[0-9a-f]{2})+$/;

/**
 * A pending event as a record. Rows written by `audit.append()` are already clean; anything else (an older
 * build, a hand-written row) is coerced instead of wedging the chain, and `metadata._malformed` lists what was.
 */
export function recordFromPending(orgKey: string, seq: number, occurredAt: AuditInstant, raw: unknown): AuditRecord {
  const e = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const malformed: string[] = [];
  const text = (key: keyof typeof AUDIT_TEXT_LIMITS, fallback: string | null): string | null => {
    const v = e[key];
    if (v === undefined || v === null) {
      if (fallback !== null) malformed.push(key);
      return fallback;
    }
    if (typeof v !== 'string') {
      malformed.push(key);
      return fallback;
    }
    return storableText(v.length > AUDIT_TEXT_LIMITS[key] ? v.slice(0, AUDIT_TEXT_LIMITS[key]) : v);
  };
  const uuid = (key: string): string | null => {
    const v = e[key];
    if (v === undefined || v === null) return null;
    if (isUuid(v)) return v.toLowerCase();
    malformed.push(key);
    return null;
  };
  const actorKind = (ACTOR_KINDS as readonly unknown[]).includes(e.actorKind) || e.actorKind === 'none' ? (e.actorKind as string) : 'none';
  if (actorKind !== e.actorKind) malformed.push('actorKind');
  const outcome = (AUDIT_OUTCOMES as readonly unknown[]).includes(e.outcome) ? (e.outcome as AuditOutcome) : 'error';
  if (outcome !== e.outcome) malformed.push('outcome');
  const ip = e.actorIpHash;
  const actorIpHash = typeof ip === 'string' && HEX.test(ip) && ip.length <= 128 ? ip : null;
  if (ip != null && actorIpHash === null) malformed.push('actorIpHash');
  const metadata: Record<string, unknown> = scrubAuditMetadata(e.metadata);
  const record: AuditRecord = {
    v: 1,
    orgKey,
    seq,
    occurredAt,
    actorKind,
    actorId: uuid('actorId'),
    impersonatorId: uuid('impersonatorId'),
    sessionId: uuid('sessionId'),
    apiKeyId: uuid('apiKeyId'),
    actorIpHash,
    actorUa: text('actorUa', null),
    action: text('action', 'unknown')!,
    resourceType: text('resourceType', 'unknown')!,
    resourceId: text('resourceId', null),
    formId: uuid('formId'),
    outcome,
    reason: text('reason', null),
    metadata,
    requestId: text('requestId', null),
    traceId: text('traceId', null),
  };
  if (malformed.length > 0) record.metadata = { ...metadata, _malformed: malformed };
  return record;
}

export const toHex = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}
