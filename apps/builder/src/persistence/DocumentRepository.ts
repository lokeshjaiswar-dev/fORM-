import { z } from 'zod';

/*
 * Where the builder keeps its forms. IndexedDbRepository keeps them in this browser; WP-1.06 adds an ApiRepository
 * behind the same interface and keeps IndexedDB as the offline cache.
 */

/** The stored document's shape: a v2 `FormDefinition`. Drafts an older build saved as `v1` are migrated on load. */
export const DOCUMENT_FORMAT = 'v2';
export const LEGACY_FORMAT = 'v1';

export interface StoredForm {
  id: string;
  format: string;
  /**
   * The saving tab's load revision plus its saves since. Informational only: saves are last-writer-wins and nothing
   * compares it, so two tabs can write the same or a lower rev. Another tab's save is noticed through `tabChannel`;
   * WP-1.06 adds server revisions that reject a stale write.
   */
  rev: number;
  savedAt: string;
  /** Read through `openStored`, which runs the reader for `format`: stored data is never trusted as typed. */
  doc: unknown;
  /** The form's local FormOps (open, closed screen, password); absent on drafts saved before WP-0.11b. */
  ops?: unknown;
}

export interface FormSummary {
  id: string;
  title: string;
  savedAt: string;
  blocks: number;
}

export interface DocumentRepository {
  /** Every stored form, most recently saved first. */
  list(): Promise<FormSummary[]>;
  load(id: string): Promise<StoredForm | null>;
  save(form: StoredForm): Promise<void>;
}

export const StoredFormSchema = z.strictObject({
  id: z.string().min(1),
  format: z.string(),
  rev: z.number().int().nonnegative(),
  savedAt: z.string(),
  doc: z.unknown(),
  ops: z.unknown().optional(),
});

export function summarize(form: StoredForm): FormSummary {
  const doc = typeof form.doc === 'object' && form.doc !== null ? (form.doc as { title?: unknown; blocks?: unknown }) : {};
  const blocks = Array.isArray(doc.blocks) ? doc.blocks.length : typeof doc.blocks === 'object' && doc.blocks !== null ? Object.keys(doc.blocks).length : 0;
  return { id: form.id, title: typeof doc.title === 'string' ? doc.title : '', savedAt: form.savedAt, blocks };
}

export const newestFirst = (a: FormSummary, b: FormSummary) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0);
