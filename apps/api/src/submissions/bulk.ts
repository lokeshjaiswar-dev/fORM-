import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { audit, auditActor, auditIdChunks, forms, formFiles, submissions, uuidV7Time, withTenant, type Db, type ReadClient, type TenantCtx, type Tx } from '@form/db';
import { toIsoInstant } from '@form/ports';
import { ProblemError } from '../errors.ts';
import type { FileStore } from '../files.ts';
import type { BulkAction } from './schemas.ts';
import { searchIndexOn, type SearchIndexFactory } from './search.ts';

export interface BulkDeps {
  db: Db;
  files: FileStore;
  /** Makes the search index of the deployment; without it `delete` answers 503 and removes nothing. */
  searchIndex?: SearchIndexFactory | undefined;
  now: () => Date;
}

export interface BulkResult {
  action: BulkAction;
  requested: number;
  changed: number;
  unchanged: number;
  missing: number;
  removedFiles: number;
}

type Row = { id: string; receivedAt: Date; read: boolean; starred: boolean; archivedAt: Date | null; trashedAt: Date | null; legalHold: boolean; statutoryHoldUntil: Date | null };

/** The rows an action changes, from the rows it was asked about; an action on a row already in its end state changes nothing. */
const SELECT: Record<Exclude<BulkAction, 'delete'>, (row: Row) => boolean> = {
  mark_read: (row) => !row.read,
  mark_unread: (row) => row.read,
  star: (row) => !row.starred,
  unstar: (row) => row.starred,
  // An archived response in the trash stays where it is: restore it first.
  archive: (row) => row.archivedAt === null && row.trashedAt === null,
  unarchive: (row) => row.archivedAt !== null,
  trash: (row) => row.trashedAt === null,
  restore: (row) => row.trashedAt !== null,
};

/** The rows an id list names, bound to the months their ids name so the planner skips the others. */
function named(formId: string, ids: readonly string[]) {
  const times = ids.map((id) => uuidV7Time(id)!.getTime());
  return and(eq(submissions.formId, formId), inArray(submissions.id, [...ids]), gte(submissions.receivedAt, new Date(Math.min(...times))), lte(submissions.receivedAt, new Date(Math.max(...times))));
}

/**
 * One bulk action over the responses of a form, all in one transaction: the rows are locked first, so two members acting
 * on the same selection get one answer, and the change and its audit records commit together. The ids are not trusted:
 * one that is not a response of this form (never received here, already deleted, another org's, not even a UUIDv7) is
 * counted as `missing` and touched by nothing. `delete` is the exception that refuses instead of skipping: every response
 * it names must be in the trash and free of holds, or nothing is deleted, so a selection that mixes live and trashed rows
 * cannot remove a live one.
 *
 * Delete forever removes, in the same transaction, the response rows, their search documents and the `form_files` rows of
 * the files they held; the bytes go through the `FileStore` once that has committed (a rolled-back delete must not have
 * lost the bytes of rows that are still there).
 */
export async function bulkAct(
  deps: BulkDeps,
  tenant: TenantCtx,
  client: ReadClient,
  formId: string,
  input: { ids: readonly string[]; action: BulkAction },
): Promise<BulkResult> {
  const ids = [...new Set(input.ids)];
  const { action } = input;
  const valid = ids.filter((id) => uuidV7Time(id) !== null);

  const outcome = await withTenant(deps.db, tenant, async (tx) => {
    const form = await tx.select({ id: forms.id }).from(forms).where(eq(forms.id, formId)).limit(1);
    if (!form[0]) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');

    const rows: Row[] =
      valid.length === 0
        ? []
        : await tx
            .select({
              id: submissions.id,
              receivedAt: submissions.receivedAt,
              read: submissions.read,
              starred: submissions.starred,
              archivedAt: submissions.archivedAt,
              trashedAt: submissions.trashedAt,
              legalHold: submissions.legalHold,
              statutoryHoldUntil: submissions.statutoryHoldUntil,
            })
            .from(submissions)
            .where(named(formId, valid))
            .orderBy(submissions.id)
            .for('update');
    const missing = ids.length - rows.length;
    const now = deps.now();

    if (action === 'delete') {
      if (rows.some((row) => row.trashedAt === null)) throw new ProblemError('SUBMISSION_NOT_TRASHED', 'Move the responses to the trash first. Nothing was deleted.');
      if (rows.some((row) => row.legalHold || (row.statutoryHoldUntil !== null && row.statutoryHoldUntil > now))) {
        throw new ProblemError('SUBMISSION_HELD', 'Some of these responses are under a hold. Nothing was deleted.');
      }
      if (rows.length === 0) return { changed: [] as string[], missing, fileIds: [] as string[] };
      const targets = rows.map((row) => row.id);
      const held = await tx
        .select({ id: formFiles.id })
        .from(formFiles)
        .where(and(eq(formFiles.formId, formId), inArray(formFiles.submissionId, targets)));
      const fileIds = held.map((file) => file.id);
      if (fileIds.length > 0) await tx.delete(formFiles).where(and(eq(formFiles.formId, formId), inArray(formFiles.id, fileIds)));
      // The adapter on this transaction, so the documents go with the rows or not at all.
      await searchIndexOn(deps.searchIndex, tx).remove(
        tenant.orgId,
        rows.map((row) => ({ submissionId: row.id, receivedAt: toIsoInstant(row.receivedAt) })),
      );
      await tx.delete(submissions).where(named(formId, targets));
      await recordPurged(tx, tenant, client, formId, targets, fileIds.length);
      return { changed: targets, missing, fileIds };
    }

    const targets = rows.filter(SELECT[action]).map((row) => row.id);
    if (targets.length === 0) return { changed: targets, missing, fileIds: [] as string[] };
    const patch = {
      mark_read: { read: true },
      mark_unread: { read: false },
      star: { starred: true },
      unstar: { starred: false },
      archive: { archivedAt: now },
      unarchive: { archivedAt: null },
      trash: { trashedAt: now },
      restore: { trashedAt: null },
    }[action];
    await tx
      .update(submissions)
      .set({ ...patch, updatedAt: now })
      .where(named(formId, targets));
    if (action === 'trash') await recordTrashed(tx, tenant, client, formId, targets);
    else if (action === 'restore') await recordRestored(tx, tenant, client, formId, targets);
    else await recordUpdated(tx, tenant, client, formId, action, targets);
    return { changed: targets, missing, fileIds: [] as string[] };
  });

  // The rows and their file records are gone for good: now the bytes. The store ignores a file that is not there.
  await Promise.all(outcome.fileIds.map((id) => deps.files.remove(id)));
  return {
    action,
    requested: ids.length,
    changed: outcome.changed.length,
    unchanged: ids.length - outcome.missing - outcome.changed.length,
    missing: outcome.missing,
    removedFiles: outcome.fileIds.length,
  };
}

/*
 * The audit records of the actions. One call site per code, each with its literal `action` (the catalogue test and the
 * `form-audit` lint read them), and the ids split over as many records as their size needs (BL-192): a record over 16 KiB
 * of metadata would lose every id.
 */

async function recordUpdated(tx: Tx, tenant: TenantCtx, client: ReadClient, formId: string, op: BulkAction, targets: readonly string[]): Promise<void> {
  const parts = auditIdChunks(targets);
  for (const [n, ids] of parts.entries()) {
    await audit.append(tx, tenant.orgId, {
      ...auditActor(tenant),
      sessionId: client.sessionId ?? null,
      actorIpHash: client.actorIpHash ?? null,
      actorUa: client.actorUa ?? null,
      action: 'submission.updated',
      resourceType: 'submission',
      resourceId: targets.length === 1 ? targets[0]! : null,
      formId,
      outcome: 'success',
      metadata: { ops: [op], count: targets.length, ids, part: parts.length > 1 ? n + 1 : undefined, parts: parts.length > 1 ? parts.length : undefined },
    });
  }
}

async function recordTrashed(tx: Tx, tenant: TenantCtx, client: ReadClient, formId: string, targets: readonly string[]): Promise<void> {
  const parts = auditIdChunks(targets);
  for (const [n, ids] of parts.entries()) {
    await audit.append(tx, tenant.orgId, {
      ...auditActor(tenant),
      sessionId: client.sessionId ?? null,
      actorIpHash: client.actorIpHash ?? null,
      actorUa: client.actorUa ?? null,
      action: 'submission.trashed',
      resourceType: 'submission',
      resourceId: targets.length === 1 ? targets[0]! : null,
      formId,
      outcome: 'success',
      metadata: { count: targets.length, ids, part: parts.length > 1 ? n + 1 : undefined, parts: parts.length > 1 ? parts.length : undefined },
    });
  }
}

async function recordRestored(tx: Tx, tenant: TenantCtx, client: ReadClient, formId: string, targets: readonly string[]): Promise<void> {
  const parts = auditIdChunks(targets);
  for (const [n, ids] of parts.entries()) {
    await audit.append(tx, tenant.orgId, {
      ...auditActor(tenant),
      sessionId: client.sessionId ?? null,
      actorIpHash: client.actorIpHash ?? null,
      actorUa: client.actorUa ?? null,
      action: 'submission.restored',
      resourceType: 'submission',
      resourceId: targets.length === 1 ? targets[0]! : null,
      formId,
      outcome: 'success',
      metadata: { count: targets.length, ids, part: parts.length > 1 ? n + 1 : undefined, parts: parts.length > 1 ? parts.length : undefined },
    });
  }
}

async function recordPurged(tx: Tx, tenant: TenantCtx, client: ReadClient, formId: string, targets: readonly string[], fileCount: number): Promise<void> {
  const parts = auditIdChunks(targets);
  for (const [n, ids] of parts.entries()) {
    await audit.append(tx, tenant.orgId, {
      ...auditActor(tenant),
      sessionId: client.sessionId ?? null,
      actorIpHash: client.actorIpHash ?? null,
      actorUa: client.actorUa ?? null,
      action: 'submission.purged',
      resourceType: 'submission',
      resourceId: targets.length === 1 ? targets[0]! : null,
      formId,
      outcome: 'success',
      metadata: { count: targets.length, ids, fileCount, part: parts.length > 1 ? n + 1 : undefined, parts: parts.length > 1 ? parts.length : undefined },
    });
  }
}
