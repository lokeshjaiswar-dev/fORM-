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
});
export type StoredSubmission = z.infer<typeof storedSubmissionSchema>;

export type SubmissionSummary = Pick<StoredSubmission, 'id' | 'formId' | 'submittedAt'> & { fieldCount: number };

export interface SubmissionsRepository {
  listByForm(formId: string): Promise<SubmissionSummary[]>;
  get(formId: string, id: string): Promise<StoredSubmission | null>;
  create(record: StoredSubmission): Promise<void>;
}

export function summarizeSubmission(record: StoredSubmission): SubmissionSummary {
  return { id: record.id, formId: record.formId, submittedAt: record.submittedAt, fieldCount: record.fields.length };
}

export const newestSubmissionFirst = (a: SubmissionSummary, b: SubmissionSummary) =>
  a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : 0;
