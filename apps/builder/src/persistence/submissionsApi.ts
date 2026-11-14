import { z } from 'zod';
import { ApiProblem, ApiUnreachable, api, ensureSession, orgApi } from '@/auth/client';
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
  fields: z.array(z.object({ key: z.string(), label: z.string(), value: z.string() })),
});

async function signedIn(): Promise<boolean> {
  return (await ensureSession()).status === 'signed_in';
}

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

/**
 * Responses are read only by signed-in members of the form's org (`submissions.read`, under the database's row
 * security). The session cookie and the active org ride on `orgApi`; a signed-out visitor sees the local ones only.
 */
export async function listRemoteSubmissions(formId: string): Promise<SubmissionSummary[] | null> {
  if (!(await signedIn())) return null;
  const res = await quiet(() => orgApi('GET', `/v1/forms/${formId}/submissions`, listSchema));
  return res?.items ?? null;
}

export async function getRemoteSubmission(formId: string, id: string): Promise<StoredSubmission | null> {
  if (!(await signedIn())) return null;
  return quiet(() => orgApi('GET', `/v1/forms/${formId}/submissions/${id}`, detailSchema));
}
