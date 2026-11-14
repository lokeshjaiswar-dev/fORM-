import { z } from 'zod';
import type { FileRef } from '@form/schema';
import type { UploadRequest } from '@form/renderer';
import { ApiProblem, ApiUnreachable, ensureSession, orgBlob } from '@/auth/client';
import { API_BASE } from '@/edition/edition';
import { getSubmissionFile } from '@/persistence/blobStore';

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const uploadedSchema = z.object({
  fileId: z.string(),
  name: z.string(),
  sizeBytes: z.number(),
  mime: z.string(),
  sha256: z.string(),
  scan: z.literal('skipped'),
});

/**
 * The uploader of a published form's public page (`/f/:slug`): each file goes to `POST /v1/p/:slug/files`, which only
 * takes files for an upload or signature field of that form, within the field's rules, and names the file itself.
 * Nothing is kept in this browser: the respondent may be on a shared computer, and the file belongs to the form's org.
 */
export function publicUploader(slug: string): (request: UploadRequest) => Promise<FileRef> {
  return async ({ blockId, purpose, file, name }) => {
    const res = await fetch(`${API_BASE}/v1/p/${encodeURIComponent(slug)}/files`, {
      method: 'POST',
      credentials: 'omit',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ blockId, purpose, name, mime: file.type || 'application/octet-stream', data: await blobToBase64(file) }),
    });
    if (!res.ok) throw new Error('file upload failed');
    const parsed = uploadedSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error('file upload failed');
    return parsed.data as unknown as FileRef;
  };
}

/**
 * A respondent's file for the Responses page: a preview file kept in this browser, else the org's copy, which only a
 * signed-in member with `submissions.read` can download (`GET /v1/forms/:formId/files/:id`).
 */
export async function loadSubmissionFile(formId: string, id: string): Promise<{ blob: Blob; name: string; mime: string } | undefined> {
  const local = await getSubmissionFile(id);
  if (local) return local;
  if ((await ensureSession()).status !== 'signed_in') return undefined;
  let blob: Blob;
  try {
    blob = await orgBlob(`/v1/forms/${encodeURIComponent(formId)}/files/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ApiProblem || err instanceof ApiUnreachable) return undefined;
    throw err;
  }
  // Not kept in this browser: the next person to use it would read the file without the API's checks.
  return { blob, name: 'file', mime: blob.type || 'application/octet-stream' };
}
