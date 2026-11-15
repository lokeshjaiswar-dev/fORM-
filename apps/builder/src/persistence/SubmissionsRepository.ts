import { z } from 'zod';

export const submissionFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
});
export type SubmissionField = z.infer<typeof submissionFieldSchema>;

export const storedSubmissionSchema = z.object({
  id: z.string().min(1),
  formId: z.string().min(1),
  submittedAt: z.string(),
  locale: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  fields: z.array(submissionFieldSchema),
  /**
   * `server`: a response read from the API, whose `fields` the server built from the answers it validated. A preview
   * response made in this browser has none; its rows were built here, by this browser, from its own answers.
   */
  source: z.literal('server').optional(),
});
export type StoredSubmission = z.infer<typeof storedSubmissionSchema>;

export type SubmissionSummary = Pick<StoredSubmission, 'id' | 'formId' | 'submittedAt'> & { fieldCount: number };

export interface SubmissionsRepository {
  listByForm(formId: string): Promise<SubmissionSummary[]>;
  get(formId: string, id: string): Promise<StoredSubmission | null>;
  create(record: StoredSubmission): Promise<void>;
  removeByForm(formId: string): Promise<StoredSubmission[]>;
}

export function summarizeSubmission(record: StoredSubmission): SubmissionSummary {
  return { id: record.id, formId: record.formId, submittedAt: record.submittedAt, fieldCount: record.fields.length };
}

export const newestSubmissionFirst = (a: SubmissionSummary, b: SubmissionSummary) =>
  a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : 0;
