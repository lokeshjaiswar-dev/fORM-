import { mergeForms, type FormDefinition, type MergeConflict, type MergeResolution } from '@form/schema';
import { uid } from '@/lib/utils';
import { newStoredForm, openStored } from '@/persistence/openForm';
import type { DocumentRepository, StoredForm } from '@/persistence/DocumentRepository';

export type MergeOutcome =
  | { ok: true; form: StoredForm }
  | { ok: false; conflicts: MergeConflict[] }
  | { ok: false; error: string };

/** Merge already-loaded drafts in this browser (used when the API is unreachable). */
export function mergeLoaded(forms: Array<{ id: string; title: string; definition: FormDefinition }>, resolutions?: MergeResolution[]): MergeOutcome {
  const id = uid();
  const result = mergeForms(forms, { newFormId: id, resolutions, newId: uid });
  if (!result.ok) return result;
  return { ok: true, form: newStoredForm(id, new Date().toISOString(), result.definition) };
}

export async function mergeFromRepository(
  repo: DocumentRepository,
  ids: string[],
  resolutions?: MergeResolution[],
): Promise<MergeOutcome> {
  const loaded: Array<{ id: string; title: string; definition: FormDefinition }> = [];
  for (const id of ids) {
    const stored = await repo.load(id);
    if (!stored) return { ok: false, error: 'One of the selected forms could not be read.' };
    const opened = openStored(stored, new Date().toISOString());
    if (!opened.ok) return { ok: false, error: opened.error };
    loaded.push({ id, title: opened.doc.title, definition: opened.doc });
  }
  return mergeLoaded(loaded, resolutions);
}
