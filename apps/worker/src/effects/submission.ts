import { and, eq } from 'drizzle-orm';
import { formVersions, submissionKey, submissions, type SubmissionStatus, type Tx } from '@form/db';
import type { Answers, CompiledForm, FormDefinition } from '@form/schema';

/**
 * A stored response, as the effect jobs (notifications, webhooks, exports) read it. Only the columns an effect needs: not
 * the retention, hold or inbox columns, and not `principal_bidx`.
 */
export interface SubmissionRow {
  id: string;
  receivedAt: Date;
  orgId: string;
  formId: string;
  formVersionId: string;
  status: SubmissionStatus;
  /**
   * When the response was put in the trash, or null. Core trashes by setting this column (the grid's bulk action) and
   * leaves `status` as it was, so a check of `status` alone never sees a trash: every effect must refuse on this too.
   */
  trashedAt: Date | null;
  /** 0 for plain jsonb answers; a later codec (WP-1.11) stores sensitive answers sealed, which `disclosableFields` masks. */
  answerCodecVersion: number;
  /** `StoredAnswer` per block id. Typed as `Answers` for the registry; a sealed answer is not readable and is masked on the way out. */
  answers: Answers;
  computed: Record<string, unknown>;
  meta: Record<string, unknown>;
}

/** The response with the exact version it was received on: what its answers mean, and the taint of its derived values. */
export interface LoadedSubmission {
  row: SubmissionRow;
  definition: FormDefinition;
  compiled: CompiledForm;
}

/**
 * The response `submissionId` of form `formId` and the published version it was filed under, inside the caller's tenant
 * transaction (the job's `tx` or an `inTenant`): RLS answers for the org, so another org's id finds nothing. Looked up by
 * id and the partition key the id implies (`submissionKey`), so one partition is read. Null for an id that is not a
 * UUIDv7, a response that is not there (deleted since the job was sent) or one of another form.
 *
 * The definition and the compiled plan are the frozen version (`form_versions` is immutable after publish, and was
 * validated when it was published), so they are read as the contract types without parsing them again.
 */
export async function loadSubmission(tx: Tx, key: { formId: string; submissionId: string }): Promise<LoadedSubmission | null> {
  const [row] = await tx
    .select({
      id: submissions.id,
      receivedAt: submissions.receivedAt,
      orgId: submissions.orgId,
      formId: submissions.formId,
      formVersionId: submissions.formVersionId,
      status: submissions.status,
      trashedAt: submissions.trashedAt,
      answerCodecVersion: submissions.answerCodecVersion,
      answers: submissions.answers,
      computed: submissions.computed,
      meta: submissions.meta,
    })
    .from(submissions)
    .where(and(eq(submissions.formId, key.formId), submissionKey(key.submissionId)))
    .limit(1);
  if (!row) return null;
  const [version] = await tx
    .select({ definition: formVersions.definition, compiled: formVersions.compiled })
    .from(formVersions)
    .where(and(eq(formVersions.id, row.formVersionId), eq(formVersions.formId, row.formId)))
    .limit(1);
  if (!version) return null;
  return { row: { ...row, answers: row.answers as Answers }, definition: version.definition as unknown as FormDefinition, compiled: version.compiled as unknown as CompiledForm };
}
