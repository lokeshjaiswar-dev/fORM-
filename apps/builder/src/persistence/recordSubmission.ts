import type { Answers, FormDefinition } from '@form/schema';
import { uid } from '@/lib/utils';
import { answerRows } from '@/persistence/answerRows';
import type { StoredSubmission, SubmissionsRepository } from '@/persistence/SubmissionsRepository';

/**
 * A submission made in the builder's preview stays in this browser (IndexedDB) so the form's author can see what a
 * response looks like. It is a rehearsal, not a response: nothing is sent to the API, which only takes real answers
 * from the published page (`POST /v1/p/:slug/submissions`, validated against the live version).
 */
export async function recordSubmission(
  repo: SubmissionsRepository,
  definition: FormDefinition,
  answers: Answers,
  locale: string,
): Promise<StoredSubmission> {
  const record: StoredSubmission = {
    id: uid(),
    formId: definition.formId,
    submittedAt: new Date().toISOString(),
    locale,
    answers,
    fields: answerRows(definition, answers),
  };
  await repo.create(record);
  return record;
}
