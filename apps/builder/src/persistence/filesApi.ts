import { z } from 'zod';
import type { FileRef } from '@form/schema';
import type { UploadRequest } from '@form/renderer';
import { activeOrgOf, ensureSession, ORG_HEADER } from '@/auth/client';
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
 * The file name a download response names: the RFC 5987 `filename*` when there is one (the full name), else the quoted
 * `filename` fallback. Never a path: only the last part, so a header can only ever name a file in the Downloads folder.
 */
export function downloadName(contentDisposition: string | null): string | undefined {
  if (!contentDisposition) return undefined;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(contentDisposition)?.[1];
  let name: string | undefined;
  if (encoded) {
    try {
      name = decodeURIComponent(encoded.trim());
    } catch {
      name = undefined;
    }
  }
  name ??= /filename\s*=\s*"([^"]*)"/i.exec(contentDisposition)?.[1];
  // eslint-disable-next-line no-control-regex
  const last = name?.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return last ? last : undefined;
}

/**
 * A respondent's file for the Responses page: a preview file kept in this browser, else the org's copy, which only a
 * signed-in member with `submissions.read` can download (`GET /v1/forms/:formId/files/:id`). The name comes from the
 * server's `Content-Disposition` (the name the upload check approved), never from the answer, which a respondent
 * typed: the browser takes a link's `download` name over the response's header, so a name from the answer could turn
 * `notes.txt` into `Invoice.exe`.
 */
export async function loadSubmissionFile(formId: string, id: string): Promise<{ blob: Blob; name: string; mime: string } | undefined> {
  const local = await getSubmissionFile(id);
  if (local) return local;
  const session = await ensureSession();
  if (session.status !== 'signed_in') return undefined;
  const org = activeOrgOf(session.me)?.id;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/forms/${encodeURIComponent(formId)}/files/${encodeURIComponent(id)}`, {
      method: 'GET',
      credentials: 'include',
      headers: org ? { [ORG_HEADER]: org } : {},
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const blob = await res.blob();
  // Not kept in this browser: the next person to use it would read the file without the API's checks.
  return { blob, name: downloadName(res.headers.get('content-disposition')) ?? 'file', mime: blob.type || 'application/octet-stream' };
}
