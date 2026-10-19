import type { Tx } from '../client.ts';
import type { TenantCtx } from '../tenant.ts';
import { audit, auditActor } from './append.ts';

/**
 * Audited reads (architecture §2.7, C-M9): every submission read, for every form, leaves a record in the same
 * transaction as the read, which therefore runs read-write (`withTenant` without `readOnly`; a read-only one fails
 * with 25006). Records carry ids and counts, never values or search text.
 */
type ReadCtx = Pick<TenantCtx, 'orgId' | 'actor' | 'userId' | 'requestId'>;

/** Grid pages show at most this many rows; the ids shown are listed in full. */
export const MAX_AUDITED_PAGE_IDS = 500;

export const auditReads = {
  /** A submission detail view. */
  async detail(tx: Tx, ctx: ReadCtx, i: { formId: string; submissionId: string }): Promise<void> {
    await audit.append(tx, ctx.orgId, {
      ...auditActor(ctx),
      action: 'submission.viewed',
      resourceType: 'submission',
      resourceId: i.submissionId,
      formId: i.formId,
      outcome: 'success',
    });
  },

  /** One grid page, coalesced into one record with the ids shown. */
  async gridPage(tx: Tx, ctx: ReadCtx, i: { formId: string; submissionIds: readonly string[]; page: number; filtered: boolean }): Promise<void> {
    if (i.submissionIds.length > MAX_AUDITED_PAGE_IDS) throw new RangeError(`auditReads.gridPage: at most ${MAX_AUDITED_PAGE_IDS} ids per page`);
    await audit.append(tx, ctx.orgId, {
      ...auditActor(ctx),
      action: 'submission.page_viewed',
      resourceType: 'form',
      resourceId: i.formId,
      formId: i.formId,
      outcome: 'success',
      metadata: { ids: [...i.submissionIds], count: i.submissionIds.length, page: i.page, filtered: i.filtered },
    });
  },

  /** Submissions read through the API (one record per request). */
  async api(tx: Tx, ctx: ReadCtx, i: { formId: string; submissionIds: readonly string[]; apiKeyId?: string | null }): Promise<void> {
    await audit.append(tx, ctx.orgId, {
      ...auditActor(ctx),
      apiKeyId: i.apiKeyId ?? null,
      action: 'submission.api_read',
      resourceType: 'submission',
      resourceId: i.submissionIds.length === 1 ? i.submissionIds[0]! : null,
      formId: i.formId,
      outcome: 'success',
      metadata: { ids: i.submissionIds.slice(0, MAX_AUDITED_PAGE_IDS), count: i.submissionIds.length },
    });
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
