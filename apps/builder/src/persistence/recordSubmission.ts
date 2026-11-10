import type { Answers, FormDefinition } from '@form/schema';
import { uid } from '@/lib/utils';
import { answerRows } from '@/persistence/answerRows';
import { ensureRemoteForm, postRemoteSubmission } from '@/persistence/submissionsApi';
import type { StoredSubmission, SubmissionsRepository } from '@/persistence/SubmissionsRepository';

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
  await ensureRemoteForm(definition.formId, definition.title);
  await postRemoteSubmission(definition.formId, record);
  return record;
}
