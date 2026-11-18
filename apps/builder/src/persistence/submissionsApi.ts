import { z } from 'zod';
import { ApiProblem, ApiUnreachable, api, orgApi } from '@/auth/client';
import type { StoredSubmission, SubmissionSummary } from '@/persistence/SubmissionsRepository';

const created = z.object({ id: z.string() });
const listSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      formId: z.string(),
      submittedAt: z.string(),
      fieldCount: z.number(),
    }),
  ),
});
const detailSchema = z.object({
  id: z.string(),
  formId: z.string(),
  submittedAt: z.string(),
  locale: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  fields: z.array(z.object({ key: z.string(), label: z.string(), value: z.string(), table: z.object({ headers: z.array(z.string()), rows: z.array(z.array(z.string())) }).optional(), choices: z.array(z.string()).optional() })),
});

/** Best-effort API calls: signed-out or unreachable servers are ignored. */
async function quiet<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiUnreachable || err instanceof ApiProblem) return null;
    return null;
  }
}

export async function ensureRemoteForm(id: string, title: string): Promise<void> {
  await quiet(() => orgApi('POST', '/v1/forms', created, { id, title }));
}

export async function postRemoteSubmission(formId: string, record: StoredSubmission): Promise<string | null> {
  const published = await quiet(() =>
    api('POST', `/v1/p/by-form/${formId}/submissions`, created, {
      answers: record.answers,
      fields: record.fields,
      locale: record.locale ?? 'en-IN',
    }),
  );
  if (published?.id) return published.id;
  const res = await quiet(() =>
    orgApi('POST', `/v1/forms/${formId}/submissions`, created, {
      answers: record.answers,
      fields: record.fields,
      locale: record.locale ?? 'en-IN',
    }),
  );
  return res?.id ?? null;
}

export async function listRemoteSubmissions(formId: string): Promise<SubmissionSummary[] | null> {
  const published = await quiet(() => api('GET', `/v1/p/by-form/${formId}/submissions`, listSchema));
  if (published) return published.items;
  const res = await quiet(() => orgApi('GET', `/v1/forms/${formId}/submissions`, listSchema));
  return res?.items ?? null;
}

export async function getRemoteSubmission(formId: string, id: string): Promise<StoredSubmission | null> {
  const published = await quiet(() => api('GET', `/v1/p/by-form/${formId}/submissions/${id}`, detailSchema));
  if (published) return published;
  const res = await quiet(() => orgApi('GET', `/v1/forms/${formId}/submissions/${id}`, detailSchema));
  return res;
}
