import type { Tx } from '../client.ts';
import type { TenantCtx } from '../tenant.ts';
import { audit, auditActor } from './append.ts';
import { MAX_METADATA_BYTES, MAX_METADATA_ITEMS } from './scrub.ts';

/**
 * Audited reads (architecture §2.7, C-M9): every submission read, for every form, leaves a record in the same
 * transaction as the read, which therefore runs read-write (`withTenant` without `readOnly`; a read-only one fails
 * with 25006). Records carry ids and counts, never values or search text.
 */
type ReadCtx = Pick<TenantCtx, 'orgId' | 'actor' | 'userId' | 'requestId'>;

/** Where a read came from, as the other audit records of a request carry it: the session and the keyed hash of the IP (never the IP). */
export interface ReadClient {
  sessionId?: string | null | undefined;
  /** Lower-case hex. */
  actorIpHash?: string | null | undefined;
  actorUa?: string | null | undefined;
}

/** Grid pages show at most this many rows; the ids shown are listed in full, over as many records as it takes. */
export const MAX_AUDITED_PAGE_IDS = 500;

const ENCODER = new TextEncoder();
/**
 * Room kept in every record for the keys around the ids (`count`, `page`, `filtered`, `part`, `parts`, the operation
 * name of a bulk action, `_scrubbed`): a few dozen small, bounded keys, so half a kilobyte is generous.
 */
const METADATA_OVERHEAD_BYTES = 512;

/**
 * The ids split into groups that each fit one audit record. `scrubAuditMetadata` replaces the metadata of a record over
 * `MAX_METADATA_BYTES` (16 KiB) with `{ _omitted }`, and 500 uuids are about 19 KiB, so a page or a bulk action put into
 * one record would silently lose every id (BL-192). Greedy by the real size of each id, so it holds for any id text; an
 * empty list is one empty group (a page with no rows is still a read, and still leaves its record).
 */
export function auditIdChunks(ids: readonly string[]): string[][] {
  const budget = MAX_METADATA_BYTES - METADATA_OVERHEAD_BYTES;
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const id of ids) {
    // The id as JSON text (quotes and escapes) and the comma after it.
    const size = ENCODER.encode(JSON.stringify(id)).byteLength + 1;
    if (current.length > 0 && (bytes + size > budget || current.length >= MAX_METADATA_ITEMS)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(id);
    bytes += size;
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  return chunks;
}

function assertAuditable(name: string, ids: readonly string[]): void {
  if (ids.length > MAX_AUDITED_PAGE_IDS) throw new RangeError(`auditReads.${name}: at most ${MAX_AUDITED_PAGE_IDS} ids per call`);
}

export const auditReads = {
  /** A submission detail view. */
  async detail(tx: Tx, ctx: ReadCtx, i: { formId: string; submissionId: string; client?: ReadClient }): Promise<void> {
    await audit.append(tx, ctx.orgId, {
      ...auditActor(ctx),
      sessionId: i.client?.sessionId ?? null,
      actorIpHash: i.client?.actorIpHash ?? null,
      actorUa: i.client?.actorUa ?? null,
      action: 'submission.viewed',
      resourceType: 'submission',
      resourceId: i.submissionId,
      formId: i.formId,
      outcome: 'success',
    });
  },

  /**
   * One grid page, coalesced into one record with the ids shown. A page whose ids do not fit one record (16 KiB of
   * metadata, about 400 uuids) leaves several, numbered `part` of `parts`, each with its share of the ids and the same
   * `count` of the whole page, so the ids of the records together are exactly the page (BL-192).
   */
  async gridPage(tx: Tx, ctx: ReadCtx, i: { formId: string; submissionIds: readonly string[]; page: number; filtered: boolean; client?: ReadClient }): Promise<void> {
    assertAuditable('gridPage', i.submissionIds);
    const parts = auditIdChunks(i.submissionIds);
    for (const [n, ids] of parts.entries()) {
      await audit.append(tx, ctx.orgId, {
        ...auditActor(ctx),
        sessionId: i.client?.sessionId ?? null,
        actorIpHash: i.client?.actorIpHash ?? null,
        actorUa: i.client?.actorUa ?? null,
        action: 'submission.page_viewed',
        resourceType: 'form',
        resourceId: i.formId,
        formId: i.formId,
        outcome: 'success',
        // part and parts are left out (undefined) when the page is one record.
        metadata: {
          ids,
          count: i.submissionIds.length,
          page: i.page,
          filtered: i.filtered,
          part: parts.length > 1 ? n + 1 : undefined,
          parts: parts.length > 1 ? parts.length : undefined,
        },
      });
    }
  },

  /** Submissions read through the API (one record per request, or several when the ids do not fit one, as for a grid page). */
  async api(tx: Tx, ctx: ReadCtx, i: { formId: string; submissionIds: readonly string[]; apiKeyId?: string | null; client?: ReadClient }): Promise<void> {
    assertAuditable('api', i.submissionIds);
    const parts = auditIdChunks(i.submissionIds);
    for (const [n, ids] of parts.entries()) {
      await audit.append(tx, ctx.orgId, {
        ...auditActor(ctx),
        sessionId: i.client?.sessionId ?? null,
        actorIpHash: i.client?.actorIpHash ?? null,
        actorUa: i.client?.actorUa ?? null,
        apiKeyId: i.apiKeyId ?? null,
        action: 'submission.api_read',
        resourceType: 'submission',
        resourceId: i.submissionIds.length === 1 ? i.submissionIds[0]! : null,
        formId: i.formId,
        outcome: 'success',
        metadata: {
          ids,
          count: i.submissionIds.length,
          part: parts.length > 1 ? n + 1 : undefined,
          parts: parts.length > 1 ? parts.length : undefined,
        },
      });
    }
  },

  /** Masked sensitive values revealed: the field ids, never the values. */
  async reveal(tx: Tx, ctx: ReadCtx, i: { formId: string; submissionId: string; fieldIds: readonly string[] }): Promise<void> {
    await audit.append(tx, ctx.orgId, {
      ...auditActor(ctx),
      action: 'submission.revealed',
      resourceType: 'submission',
      resourceId: i.submissionId,
      formId: i.formId,
      outcome: 'success',
      metadata: { fieldIds: [...i.fieldIds] },
    });
  },

  /** An export request; `reason` is required when it includes sensitive fields. */
  async export(tx: Tx, ctx: ReadCtx, i: { formId: string; exportId: string; format: string; includeSensitive: boolean; reason?: string | null }): Promise<void> {
    if (i.includeSensitive && !i.reason?.trim()) throw new TypeError('auditReads.export: includeSensitive needs a reason');
    await audit.append(tx, ctx.orgId, {
      ...auditActor(ctx),
      action: 'submission.exported',
      resourceType: 'export',
      resourceId: i.exportId,
      formId: i.formId,
      outcome: 'success',
      reason: i.reason ?? null,
      metadata: { format: i.format, includeSensitive: i.includeSensitive },
    });
  },

  /** A file download (presigned GET or stream). */
  async download(tx: Tx, ctx: ReadCtx, i: { formId: string; fileId: string; submissionId?: string | null; streamed: boolean }): Promise<void> {
    await audit.append(tx, ctx.orgId, {
      ...auditActor(ctx),
      action: 'file.downloaded',
      resourceType: 'file',
      resourceId: i.fileId,
      formId: i.formId,
      outcome: 'success',
      metadata: { submissionId: i.submissionId ?? null, streamed: i.streamed },
    });
  },
};
