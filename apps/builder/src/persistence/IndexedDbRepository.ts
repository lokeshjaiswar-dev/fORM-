import { createStore, get, set, values, type UseStore } from 'idb-keyval';
import { StoredFormSchema, newestFirst, summarize, type DocumentRepository, type FormSummary, type StoredForm } from '@/persistence/DocumentRepository';

/** Forms in this browser's IndexedDB (idb-keyval), one record per form id. The database opens on first use. */
export class IndexedDbRepository implements DocumentRepository {
  private store: UseStore | null = null;
  private readonly dbName: string;
  private readonly storeName: string;

  constructor(dbName = 'fORM-builder', storeName = 'forms') {
    this.dbName = dbName;
    this.storeName = storeName;
  }

  private db(): UseStore {
    this.store ??= createStore(this.dbName, this.storeName);
    return this.store;
  }

  async list(): Promise<FormSummary[]> {
    const records = await values(this.db());
    return records
      .flatMap((record) => {
        const parsed = StoredFormSchema.safeParse(record);
        return parsed.success ? [summarize(parsed.data)] : [];
      })
      .sort(newestFirst);
  }

  async load(id: string): Promise<StoredForm | null> {
    const record: unknown = await get(id, this.db());
    if (record === undefined) return null;
    const parsed = StoredFormSchema.safeParse(record);
    if (!parsed.success || parsed.data.id !== id) throw new Error(`the stored record for form '${id}' is unreadable`);
    return parsed.data;
  }

  async save(form: StoredForm): Promise<void> {
    await set(form.id, form, this.db());
  }
}
