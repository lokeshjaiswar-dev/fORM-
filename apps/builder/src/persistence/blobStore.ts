import { createStore, del, get, set, type UseStore } from 'idb-keyval';

/** Respondent files kept in this browser until the form (or the file) is deleted. */
export type StoredBlob = { blob: Blob; name: string; mime: string };

let store: UseStore | null = null;

function db(): UseStore {
  store ??= createStore('fORM-blobs', 'files');
  return store;
}

export async function putSubmissionFile(id: string, file: Blob, name: string, mime: string): Promise<void> {
  await set(id, { blob: file, name, mime } satisfies StoredBlob, db());
}

export async function getSubmissionFile(id: string): Promise<StoredBlob | undefined> {
  const row: unknown = await get(id, db());
  if (!row || typeof row !== 'object') return undefined;
  const rec = row as { blob?: unknown; name?: unknown; mime?: unknown };
  if (!(rec.blob instanceof Blob) || typeof rec.name !== 'string' || typeof rec.mime !== 'string') return undefined;
  return { blob: rec.blob, name: rec.name, mime: rec.mime };
}

export async function deleteSubmissionFiles(ids: readonly string[]): Promise<void> {
  await Promise.all(ids.map((id) => del(id, db())));
}

/** File ids stored on answers (uploads and signatures). */
export function fileIdsFromAnswers(answers: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const rec = value as Record<string, unknown>;
    if (typeof rec.fileId === 'string') ids.add(rec.fileId);
    for (const nested of Object.values(rec)) walk(nested);
  };
  walk(answers);
  return [...ids];
}
