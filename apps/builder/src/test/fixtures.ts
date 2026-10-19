import type { FieldType, FormBlock, FormSchema } from '@/types/form';
import { defaultSettings } from '@/lib/defaultSettings';
import { newestFirst, summarize, type DocumentRepository, type FormSummary, type StoredForm } from '@/persistence/DocumentRepository';
import { currentDoc } from '@/state/documentStore';
import { loadDocument } from '@/state/history';
import { resetUi } from '@/state/uiStore';

export function block(type: FieldType, patch: Partial<FormBlock> = {}): FormBlock {
  return { id: type, type, label: '', order: 0, ...patch };
}

export function formWith(blocks: FormBlock[]): FormSchema {
  return {
    id: 'test',
    title: 'Test form',
    description: '',
    blocks: blocks.map((b, i) => ({ ...b, order: i })),
    settings: { ...defaultSettings(), successAnimation: false },
  };
}

/** Opens a form of `blocks` with an empty history and a fresh, started UI. */
export function resetStore(blocks: FormBlock[] = []) {
  loadDocument(formWith(blocks));
  resetUi({ started: true });
}

export const doc = () => currentDoc();
export const blockIds = () => currentDoc().blocks.map((b) => b.id);

/** A repository in memory; records are cloned in and out as IndexedDB would. */
export class MemoryRepository implements DocumentRepository {
  readonly records = new Map<string, StoredForm>();

  async list(): Promise<FormSummary[]> {
    return [...this.records.values()].map(summarize).sort(newestFirst);
  }

  async load(id: string): Promise<StoredForm | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async save(form: StoredForm): Promise<void> {
    this.records.set(form.id, structuredClone(form));
  }
}
