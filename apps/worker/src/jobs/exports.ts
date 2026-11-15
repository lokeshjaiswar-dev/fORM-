import { and, desc, eq } from 'drizzle-orm';
import { exportJobs as exportsTable, formVersions, isUuid, reviewerScope, type ExportFormat } from '@form/db';
import { isPortError, JOB_POLICIES } from '@form/ports';
import type { CompiledForm, FormDefinition } from '@form/schema';
import type { EffectDeps } from '../effects/deps.ts';
import { buildExportPlan, type ExportPlan, type ExportReviewer, type ExportVersion } from '../effects/export/columns.ts';
import { createCsvWriter } from '../effects/export/csv.ts';
import { EXPORT_BATCH_SIZE, parseScope, readBatch, recordExportDisclosures, type Cursor, type ParsedScope } from '../effects/export/rows.ts';
import { ExportFailure, type TableWriter } from '../effects/export/table.ts';
import { startUpload } from '../effects/export/upload.ts';
import { createXlsxWriter } from '../effects/export/xlsx.ts';
import { defineJob, type AnyJobDefinition, type ManualJobDefinition } from './define.ts';

/*
 * Exports (WP-1.17, EXP-01): `export.build` turns a queued `exports` row into a CSV or XLSX file in the `exports` bucket.
 * An export is asked for by a person, not triggered by a response, so this domain has no `submission.fanout` consumer.
 *
 * It is a `transaction: 'manual'` job because the file is uploaded while the responses are still being read: each batch of
 * 2000 responses is one short `inTenant` transaction (read, build the cells, write the `disclosures` rows), and the bytes of
 * the batch go to the object store between two of them, with no connection held. What may leave is decided by
 * `disclosableFields` through `buildExportPlan` (purposes, `inExports` omit and mask, `include_sensitive`, taint, sealed
 * answers) and, for a requester who is a reviewer of the form, `visibleBlocksForReviewer` (`own_unit` redaction); the writers
 * escape every cell against formula injection.
 */

/** A finished file stays downloadable this long; the sweep that removes the object is WP-1.22. */
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

const BUCKET = 'exports' as const;

const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const DISPLAY_NAMES: Record<ExportFormat, string> = { csv: 'CSV export', xlsx: 'XLSX export' };

/** What `exports.error` says when the cause is not one of ours to explain: no database message, key or answer ever reaches it. */
const GENERIC_FAILURE = 'The export could not be built. Try again; if it keeps failing, contact support with the export id.';
const STORAGE_FAILURE = 'The file could not be saved to storage. Try again in a few minutes.';

interface Prepared {
  kind: 'build';
  formId: string;
  format: ExportFormat;
  scope: ParsedScope;
  plan: ExportPlan;
}

/** The `error` text of a failed export, and whether a retry could change anything. */
function describeFailure(err: unknown): { message: string; permanent: boolean } {
  if (err instanceof ExportFailure) return { message: err.message, permanent: true };
  if (isPortError(err)) return { message: STORAGE_FAILURE, permanent: false };
  return { message: GENERIC_FAILURE, permanent: false };
}

/** The `export.build` handler. */
export function exportBuild(deps: EffectDeps): ManualJobDefinition<'export.build'> {
  return defineJob({
    name: 'export.build',
    // A system job: the read policies of `exports` and `submissions` let it through, and it writes only the file's state and ledger rows.
    perms: [],
    transaction: 'manual',
    async run({ job, orgId, log, inTenant }) {
      const exportId = job.envelope.data.exportId;
      if (!isUuid(exportId)) {
        log.warn('export.build: the envelope names no export id; nothing to build');
        return;
      }

      /** Marks the export failed in a transaction of its own; best effort, because the attempt may already be interrupted. */
      const markFailed = async (message: string): Promise<void> => {
        try {
          await inTenant((tx) =>
            tx
              .update(exportsTable)
              .set({ status: 'failed', error: message, finishedAt: deps.now() })
              .where(and(eq(exportsTable.id, exportId), eq(exportsTable.orgId, orgId))),
          );
        } catch (err) {
          log.warn({ exportId, errName: err instanceof Error ? err.name : 'unknown' }, 'export.build: could not record the failure');
        }
      };

      try {
        // Phase 1: take the export, set it running, and read everything the file's shape depends on.
        const prepared = await inTenant(async (tx): Promise<Prepared | { kind: 'skip'; why: string }> => {
          const [row] = await tx.select().from(exportsTable).where(eq(exportsTable.id, exportId)).limit(1);
          if (!row) return { kind: 'skip', why: 'no such export' };
          if (row.status === 'ready' || row.status === 'expired') return { kind: 'skip', why: `already ${row.status}` };
          const scope = parseScope(row.scope);
          const versions = await tx
            .select({ id: formVersions.id, number: formVersions.number, definition: formVersions.definition, compiled: formVersions.compiled })
            .from(formVersions)
            .where(and(eq(formVersions.formId, row.formId), eq(formVersions.orgId, orgId)))
            .orderBy(desc(formVersions.number));
          // Fails closed: settings that do not parse stop the export, so a reviewer is never given a whole response by mistake.
          const review = await reviewerScope(tx, { formId: row.formId, userId: row.requestedBy }).catch((err: unknown) => {
            // `reviewerScope` says so in these words (exports.int.test.ts pins them); a database error is not this, and is retried.
            if (!(err instanceof Error) || !err.message.startsWith('the review settings of form')) throw err;
            throw new ExportFailure('review_settings_invalid', 'The export was stopped: this form\'s review settings are not valid. Ask a form admin to save them again.');
          });
          // The live units and the pending rows' units: a checker whose unit moved to another group still decides it on the
          // responses in flight, so they stay redacted to it (see `ReviewerScope.assignments`).
          const reviewer: ExportReviewer | null = review.settings && review.groupIds.length > 0 ? { settings: { units: review.assignments }, groupIds: review.groupIds } : null;
          const exportVersions: ExportVersion[] = versions.map((v) => ({
            id: v.id,
            number: v.number,
            definition: v.definition as unknown as FormDefinition,
            compiled: v.compiled as unknown as CompiledForm,
          }));
          const plan = buildExportPlan({ versions: exportVersions, includeSensitive: row.includeSensitive, reviewer });
          await tx
            .update(exportsTable)
            .set({ status: 'running', error: null, finishedAt: null })
            .where(and(eq(exportsTable.id, exportId), eq(exportsTable.orgId, orgId)));
          return { kind: 'build', formId: row.formId, format: row.format, scope, plan };
        });
        if (prepared.kind === 'skip') {
          log.info({ exportId }, `export.build: ${prepared.why}`);
          return;
        }

        const storage = deps.storage;
        if (!storage) throw new ExportFailure('storage_unavailable', 'Exports are not available here: no object storage is configured.');

        // Phase 2: stream the file. Each batch is read and recorded in one transaction, then written to the upload.
        const objectKey = `${orgId}/${exportId}.${prepared.format}`;
        const sse = (await storage.capabilities()).sse;
        const upload = startUpload(storage, BUCKET, objectKey, { contentType: CONTENT_TYPES[prepared.format], ...(sse ? { sse: true as const } : {}) });
        let rowCount = 0;
        let bytes = 0;
        try {
          const writer: TableWriter = prepared.format === 'csv' ? createCsvWriter(upload) : createXlsxWriter(upload.stream);
          await writer.start(prepared.plan.headers);
          let after: Cursor | null = null;
          for (;;) {
            job.signal.throwIfAborted();
            const batch = await inTenant(async (tx) => {
              const rows = await readBatch(tx, { orgId, formId: prepared.formId, scope: prepared.scope, after, limit: EXPORT_BATCH_SIZE });
              const built = rows.map((r) => prepared.plan.rowOf({ id: r.id, receivedAt: r.receivedAt, formVersionId: r.formVersionId, answers: r.answers }));
              await recordExportDisclosures(tx, {
                orgId,
                exportId,
                displayName: DISPLAY_NAMES[prepared.format],
                items: rows.map((r, i) => ({ submissionId: r.id, receivedAt: r.receivedAt, fieldKeys: built[i]?.fieldKeys ?? [] })),
              });
              return { cells: built.map((b) => b.cells), last: rows.at(-1) };
            });
            if (!batch.last) break;
            await writer.rows(batch.cells);
            rowCount += batch.cells.length;
            after = { receivedAt: batch.last.receivedAt, id: batch.last.id };
            if (batch.cells.length < EXPORT_BATCH_SIZE) break;
          }
          await writer.finish();
          ({ bytes } = await upload.finish());
        } catch (err) {
          await upload.abort(err);
          throw err;
        }

        // Phase 3: the file exists; say so.
        const finishedAt = deps.now();
        const done = await inTenant((tx) =>
          tx
            .update(exportsTable)
            .set({ status: 'ready', rowCount, objectKey, bytes, error: null, finishedAt, expiresAt: new Date(finishedAt.getTime() + EXPORT_TTL_MS) })
            .where(and(eq(exportsTable.id, exportId), eq(exportsTable.orgId, orgId)))
            .returning({ id: exportsTable.id }),
        );
        if (done.length === 0) {
          // The export was deleted while it ran: nobody can ask for the file, so do not leave it behind.
          await storage.delete(BUCKET, [objectKey]);
          log.warn({ exportId }, 'export.build: the export was removed while it ran; the file was deleted');
          return;
        }
        log.info({ exportId, format: prepared.format, rows: rowCount, bytes }, 'export.build: file ready');
      } catch (err) {
        // An interrupted attempt (shutdown, expiry) is retried as it is: the export stays `running` and the next attempt starts again.
        if (job.signal.aborted) throw err;
        const { message, permanent } = describeFailure(err);
        const lastAttempt = job.attempt > JOB_POLICIES['export.build'].retryLimit;
        if (permanent || lastAttempt) await markFailed(message);
        log.error({ exportId, attempt: job.attempt, failure: err instanceof ExportFailure ? err.code : err instanceof Error ? err.name : 'unknown' }, 'export.build: failed');
        // A reason retrying cannot change is final: ack the job, the export row says why. Anything else goes back to the queue.
        if (permanent) return;
        throw err;
      }
    },
  });
}

/** The queues this domain works. */
export function exportJobs(deps: EffectDeps): AnyJobDefinition[] {
  return [exportBuild(deps)];
}
