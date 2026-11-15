import { z } from 'zod';

/*
 * Where the builder keeps its forms. CachingApiRepository writes the v2 definition to Postgres and keeps IndexedDB
 * as the offline cache plus local FormOps (open / closed / password). Tests pass a MemoryRepository.
 */

/** The stored document's shape: a v2 `FormDefinition`. Drafts an older build saved as `v1` are migrated on load. */
export const DOCUMENT_FORMAT = 'v2';
export const LEGACY_FORMAT = 'v1';

export interface StoredForm {
  id: string;
  format: string;
  /**
   * The saving tab's load revision plus its saves since. Informational only: nothing compares it to a server value
   * (`serverRev` is that), so two tabs can write the same or a lower rev. Another tab's save is noticed through
   * `tabChannel`; the server refuses a stale write with a 409.
   */
  rev: number;
  savedAt: string;
  /** Read through `openStored`, which runs the reader for `format`: stored data is never trusted as typed. */
  doc: unknown;
  /** The form's local FormOps (open, closed screen, password); absent on drafts saved before WP-0.11b. */
  ops?: unknown;
  /**
   * The server draft revision (`form_drafts.draft_rev`) this document was last in step with: what a save sends as
   * `If-Match`. Absent or 0 for a form the server has not seen yet. Only a repository that talks to the server sets it.
   */
  serverRev?: number | undefined;
  /**
   * True while the document holds changes the server has not accepted. `load` takes a newer server draft over a clean
   * cache, and raises `DraftConflict` over a dirty one. A read from the server is saved with `dirty: false`.
   */
  dirty?: boolean | undefined;
}

/** A server draft as `GET /v1/forms/:id/draft` or a 409 describes it. `draft` is null for a form the server holds no draft of. */
export interface ServerDraft {
  draftRev: number;
  draft: unknown;
  updatedAt: string;
  updatedBy?: string | null | undefined;
}

/**
 * The server has a draft this browser has not seen, and this browser has changes of its own: `load` raises it for a
 * dirty cache that is behind the server, and a save raises it for a 409. Nothing was lost: `server` is what the server
 * holds and `local` (when known) what this browser holds. The builder shows both and lets the author choose.
 */
export class DraftConflict extends Error {
  readonly server: ServerDraft;
  readonly local: StoredForm | null;
  constructor(server: ServerDraft, local: StoredForm | null = null) {
    super('This form was changed somewhere else since you opened it.');
    this.name = 'DraftConflict';
    this.server = server;
    this.local = local;
  }
}

/** What a full save answers: the server revision the form is at now, and whether the server has the document. */
export interface SaveResult {
  serverRev: number;
  /** False when the server could not be reached: the document is safe here and goes up with a later save. */
  synced: boolean;
}

export interface FormSummary {
  id: string;
  title: string;
  savedAt: string;
  blocks: number;
  /** Set on a form from the cache: the server revision it was last in step with (see `StoredForm.serverRev`). */
  serverRev?: number;
}

export interface DocumentRepository {
  /** Every stored form, most recently saved first. */
  list(): Promise<FormSummary[]>;
  /** Throws `DraftConflict` when this browser has unsent changes and the server's draft moved on. */
  load(id: string): Promise<StoredForm | null>;
  /**
   * Keeps the form for good: in this browser and, for a repository with a server behind it, on the server (`If-Match` =
   * `form.serverRev`; a 409 is a `DraftConflict`). A repository with no server returns nothing.
   */
  save(form: StoredForm): Promise<SaveResult | void>;
  /** The fast half of `save`: this browser only, marked dirty. Only a repository with a server has it; autosave uses it every 400 ms. */
  saveLocal?(form: StoredForm): Promise<void>;
  /** Replaces the cached copy with a server draft the author chose to take over theirs (`serverRev` = its revision, clean). */
  adopt?(id: string, server: ServerDraft): Promise<void>;
  remove(id: string): Promise<void>;
}

export const StoredFormSchema = z.strictObject({
  id: z.string().min(1),
  format: z.string(),
  rev: z.number().int().nonnegative(),
  savedAt: z.string(),
  doc: z.unknown(),
  ops: z.unknown().optional(),
  serverRev: z.number().int().nonnegative().optional(),
  dirty: z.boolean().optional(),
});

export function summarize(form: StoredForm): FormSummary {
  const doc = typeof form.doc === 'object' && form.doc !== null ? (form.doc as { title?: unknown; blocks?: unknown }) : {};
  const blocks = Array.isArray(doc.blocks) ? doc.blocks.length : typeof doc.blocks === 'object' && doc.blocks !== null ? Object.keys(doc.blocks).length : 0;
  return {
    id: form.id,
    title: typeof doc.title === 'string' ? doc.title : '',
    savedAt: form.savedAt,
    blocks,
    ...(form.serverRev === undefined ? {} : { serverRev: form.serverRev }),
  };
}

export const newestFirst = (a: FormSummary, b: FormSummary) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0);
