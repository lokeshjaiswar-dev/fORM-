import { createStore, del, get, set, values, type UseStore } from 'idb-keyval';
import { parseCustomField, type CustomField } from '@/fields/custom/model';
import { uid } from '@/lib/utils';

export interface CustomFieldRepository {
  list(): Promise<CustomField[]>;
  load(id: string): Promise<CustomField | null>;
  save(field: CustomField): Promise<void>;
  remove(id: string): Promise<void>;
}

const listeners = new Set<() => void>();

export function subscribeCustomFields(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Custom fields in this browser. A separate database from forms so the forms store is never migrated. */
export class IndexedDbCustomFieldRepository implements CustomFieldRepository {
  private store: UseStore | null = null;

  private db(): UseStore {
    this.store ??= createStore('fORM-custom-fields', 'fields');
    return this.store;
  }

  async list(): Promise<CustomField[]> {
    const records = await values(this.db());
    return records
      .flatMap((record) => {
        const field = parseCustomField(record);
        return field ? [field] : [];
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  async load(id: string): Promise<CustomField | null> {
    const record: unknown = await get(id, this.db());
    if (record === undefined) return null;
    return parseCustomField(record);
  }

  async save(field: CustomField): Promise<void> {
    await set(field.id, field, this.db());
    notify();
  }

  async remove(id: string): Promise<void> {
    await del(id, this.db());
    notify();
  }
}

export class MemoryCustomFieldRepository implements CustomFieldRepository {
  readonly records = new Map<string, CustomField>();

  async list(): Promise<CustomField[]> {
    return [...this.records.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  async load(id: string): Promise<CustomField | null> {
    return this.records.get(id) ?? null;
  }

  async save(field: CustomField): Promise<void> {
    this.records.set(field.id, field);
    notify();
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
    notify();
  }
}

let impl: CustomFieldRepository = new IndexedDbCustomFieldRepository();

export const customFields: CustomFieldRepository = {
  list: () => impl.list(),
  load: (id) => impl.load(id),
  save: (field) => impl.save(field),
  remove: (id) => impl.remove(id),
};

/** Saves a library field; a second save with the same name and type updates that row instead of duplicating it. */
export async function saveLibraryField(input: Omit<CustomField, 'id' | 'createdAt' | 'updatedAt'>): Promise<CustomField> {
  const list = await impl.list();
  const existing = list.find((field) => field.name === input.name && field.baseType === input.baseType);
  const now = new Date().toISOString();
  const field: CustomField = {
    ...input,
    id: existing?.id ?? uid(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await impl.save(field);
  return field;
}

export function setCustomFieldRepository(next: CustomFieldRepository): void {
  impl = next;
}
