import { API_BASE } from '@/edition/edition';
import { getSubmissionFile, putSubmissionFile } from '@/persistence/blobStore';

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Copies a respondent file to the API so another device can open it in Responses. */
export async function persistRemoteFile(id: string, file: Blob, name: string, mime: string): Promise<void> {
  const data = await blobToBase64(file);
  const res = await fetch(`${API_BASE}/v1/p/files`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ id, name, mime, data }),
  });
  if (!res.ok) throw new Error('file persist failed');
}

export async function loadSubmissionFile(id: string): Promise<{ blob: Blob; name: string; mime: string } | undefined> {
  const local = await getSubmissionFile(id);
  if (local) return local;
  const res = await fetch(`${API_BASE}/v1/p/files/${encodeURIComponent(id)}`, { headers: { accept: '*/*' } });
  if (!res.ok) return undefined;
  const blob = await res.blob();
  const mime = res.headers.get('content-type') || blob.type || 'application/octet-stream';
  const name = res.headers.get('x-file-name') || 'file';
  try {
    await putSubmissionFile(id, blob, name, mime);
  } catch {
    /* Still return the blob if IndexedDB is unavailable. */
  }
  return { blob, name, mime };
}
