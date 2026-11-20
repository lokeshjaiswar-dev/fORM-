import { createStore, del, get, set, values, type UseStore } from 'idb-keyval';
import {
  newestSubmissionFirst,
  storedSubmissionSchema,
  summarizeSubmission,
  type StoredSubmission,
  type SubmissionSummary,
  type SubmissionsRepository,
} from '@/persistence/SubmissionsRepository';

function key(formId: string, id: string): string {
  return `${formId}:${id}`;
}

/** Submissions in this browser (separate IndexedDB from form drafts). */
export class IndexedDbSubmissions implements SubmissionsRepository {
  private store: UseStore | null = null;

  private db(): UseStore {
    this.store ??= createStore('fORM-submissions', 'submissions');
    return this.store;
  }

  async recordsByForm(formId: string): Promise<StoredSubmission[]> {
    const records = await values(this.db());
    return records.flatMap((record) => {
      const parsed = storedSubmissionSchema.safeParse(record);
      return parsed.success && parsed.data.formId === formId ? [parsed.data] : [];
    });
  }

  async listByForm(formId: string): Promise<SubmissionSummary[]> {
    const records = await values(this.db());
    return records
      .flatMap((record) => {
        const parsed = storedSubmissionSchema.safeParse(record);
        return parsed.success && parsed.data.formId === formId ? [summarizeSubmission(parsed.data)] : [];
      })
      .sort(newestSubmissionFirst);
  }

  async get(formId: string, id: string): Promise<StoredSubmission | null> {
    const record: unknown = await get(key(formId, id), this.db());
    if (record === undefined) return null;
    const parsed = storedSubmissionSchema.safeParse(record);
    if (!parsed.success || parsed.data.formId !== formId || parsed.data.id !== id) return null;
    return parsed.data;
  }

  async create(record: StoredSubmission): Promise<void> {
    await set(key(record.formId, record.id), record, this.db());
  }

  async removeByForm(formId: string): Promise<StoredSubmission[]> {
    const records = await values(this.db());
    const removed: StoredSubmission[] = [];
    for (const record of records) {
      const parsed = storedSubmissionSchema.safeParse(record);
      if (!parsed.success || parsed.data.formId !== formId) continue;
      removed.push(parsed.data);
      await del(key(formId, parsed.data.id), this.db());
    }
    return removed;
  }
}
