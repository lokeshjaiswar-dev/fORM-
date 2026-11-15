import { and, eq } from 'drizzle-orm';
import { audit, auditActor, auditReads, formFiles, submissionKey, submissions, withTenant, type Db, type ReadClient, type SubmissionStatus, type TenantCtx } from '@form/db';
import { ProblemError } from '../errors.ts';
import { detailFieldsOf, maskedAnswersOf, MASK, type DetailField, type PlanLoader } from './plans.ts';
import { mayShow, reviewerViewOf, reviewOf, reviewSummaries, SEES_ALL, type RedactionLoader, type ReviewUnitSummary } from './review-view.ts';

export interface DetailDeps {
  db: Db;
  plans: PlanLoader;
  now: () => Date;
  /** What a reviewer who sees only their own units may read of each version (required, so no route can forget to redact). */
  redaction: RedactionLoader;
}

export interface Detail {
  id: string;
  formId: string;
  receivedAt: string;
  status: SubmissionStatus;
  read: boolean;
  starred: boolean;
  archivedAt: string | null;
  trashedAt: string | null;
  versionId: string;
  versionNumber: number | null;
  locale: string;
  meta: Record<string, unknown>;
  fields: DetailField[];
  answers: Record<string, unknown>;
  files: Array<{ id: string | null; blockId: string; name: string; mime: string; sizeBytes: number | null; purpose: 'file' | 'signature'; masked: boolean }>;
  /** Each review unit of a response that was held for review: its name and state, nothing else. Absent for any other response. */
  review?: ReviewUnitSummary[];
}

const NOT_ON_FORM = 'That submission is not on this form.';

/** The language a response was given in: `meta.locale`, which the submit route always writes. */
const localeOf = (meta: Record<string, unknown>): string => (typeof meta['locale'] === 'string' ? meta['locale'] : 'en-IN');

/** What the server recorded about the request, without the keyed hashes of the address and the browser (they are for the spam checks, not for a reader). */
function metaOf(meta: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(meta).filter(([key]) => !/hash/i.test(key)));
}

/**
 * One response with its fields, as the inbox reader shows it (SUB-03). Read and audited in one read-write transaction
 * (`auditReads.detail`, C-M9). The fields are rebuilt from the answers and the version they were received on, so a page
 * cannot show a line the form never asked; encrypted and sensitive answers are masked, in `fields`, in `answers` and in
 * the file list, until a reveal exists (WP-1.11).
 *
 * A caller who is acting as a reviewer of the form with `own_unit` visibility (WP-2.33) gets the answers, display rows and
 * files of the blocks of their own units and of no other: the rest is removed before the response is built, not masked.
 */
export async function readDetail(deps: DetailDeps, tenant: TenantCtx, client: ReadClient, formId: string, id: string): Promise<Detail> {
  return withTenant(deps.db, tenant, async (tx) => {
    // By id and the partition key it implies, so one partition is read; an id that is not a UUIDv7 matches nothing.
    const rows = await tx
      .select()
      .from(submissions)
      .where(and(eq(submissions.formId, formId), submissionKey(id)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ProblemError('NOT_FOUND', NOT_ON_FORM);
    const plan = await deps.plans.ofVersion(tx, row.formVersionId);
    const held = await tx
      .select({ id: formFiles.id, blockId: formFiles.blockId, name: formFiles.name, mime: formFiles.mime, sizeBytes: formFiles.sizeBytes, purpose: formFiles.purpose })
      .from(formFiles)
      .where(and(eq(formFiles.formId, formId), eq(formFiles.submissionId, row.id), eq(formFiles.submissionReceivedAt, row.receivedAt)))
      .orderBy(formFiles.createdAt, formFiles.id);
    const reviewer = await reviewerViewOf(tx, tenant, formId);
    const visible = (reviewer.redacted ? await deps.redaction.visibility(tx, reviewer, [row.formVersionId]) : SEES_ALL).of(row.formVersionId);
    const summaries = await reviewSummaries(tx, reviewer, tenant.orgId, formId, [row]);
    await auditReads.detail(tx, tenant, { formId, submissionId: row.id, client });
    const answers = maskedAnswersOf(plan, row.answers);
    return {
      id: row.id,
      formId: row.formId,
      receivedAt: row.receivedAt.toISOString(),
      status: row.status,
      read: row.read,
      starred: row.starred,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      trashedAt: row.trashedAt?.toISOString() ?? null,
      versionId: row.formVersionId,
      versionNumber: plan?.number ?? null,
      locale: localeOf(row.meta),
      meta: metaOf(row.meta),
      fields: visible === null ? detailFieldsOf(plan, row.answers) : detailFieldsOf(plan, row.answers).filter((field) => mayShow(visible, field.id)),
      answers: visible === null ? answers : Object.fromEntries(Object.entries(answers).filter(([id]) => mayShow(visible, id))),
      files: held.filter((file) => mayShow(visible, file.blockId)).map((file) => {
        // A file in a protected field is listed, but neither named nor fetchable from here (WP-1.14, WP-1.11 reveal it).
        const masked = plan?.byId.get(file.blockId)?.masked ?? true;
        return masked
          ? { id: null, blockId: file.blockId, name: MASK, mime: '', sizeBytes: null, purpose: file.purpose, masked: true }
          : { id: file.id, blockId: file.blockId, name: file.name, mime: file.mime, sizeBytes: file.sizeBytes, purpose: file.purpose, masked: false };
      }),
      ...reviewOf(summaries, row.id),
    };
  });
}

/**
 * Sets `read` and `starred` on one response (the flags of the inbox). A flag already at the asked value writes nothing and
 * leaves no audit record, so opening a response that is read already is free; a change is one `submission.updated` record
 * naming the operations, in the same transaction.
 */
export async function setFlags(
  deps: DetailDeps,
  tenant: TenantCtx,
  client: ReadClient,
  formId: string,
  id: string,
  change: { read?: boolean | undefined; starred?: boolean | undefined },
): Promise<{ id: string; read: boolean; starred: boolean }> {
  return withTenant(deps.db, tenant, async (tx) => {
    const rows = await tx
      .select({ id: submissions.id, read: submissions.read, starred: submissions.starred })
      .from(submissions)
      .where(and(eq(submissions.formId, formId), submissionKey(id)))
      .limit(1)
      .for('update');
    const row = rows[0];
    if (!row) throw new ProblemError('NOT_FOUND', NOT_ON_FORM);
    const set: { read?: boolean; starred?: boolean } = {};
    const ops: string[] = [];
    if (change.read !== undefined && change.read !== row.read) {
      set.read = change.read;
      ops.push(change.read ? 'mark_read' : 'mark_unread');
    }
    if (change.starred !== undefined && change.starred !== row.starred) {
      set.starred = change.starred;
      ops.push(change.starred ? 'star' : 'unstar');
    }
    if (ops.length === 0) return { id: row.id, read: row.read, starred: row.starred };
    await tx
      .update(submissions)
      .set({ ...set, updatedAt: deps.now() })
      .where(and(eq(submissions.formId, formId), submissionKey(id)));
    await audit.append(tx, tenant.orgId, {
      ...auditActor(tenant),
      sessionId: client.sessionId ?? null,
      actorIpHash: client.actorIpHash ?? null,
      actorUa: client.actorUa ?? null,
      action: 'submission.updated',
      resourceType: 'submission',
      resourceId: row.id,
      formId,
      outcome: 'success',
      metadata: { ops, count: 1, ids: [row.id] },
    });
    return { id: row.id, read: set.read ?? row.read, starred: set.starred ?? row.starred };
  });
}
