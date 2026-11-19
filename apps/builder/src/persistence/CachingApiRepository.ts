import { DOCUMENT_FORMAT, newestFirst, summarize, type DocumentRepository, type FormSummary, type StoredForm } from '@/persistence/DocumentRepository';
import { hydrateThemeImages, themeMediaForDraft } from '@/components/builder/design/uploads';
import { getRemoteDraft, listRemoteForms, putRemoteDraft } from '@/persistence/draftsApi';

/**
 * Writes the v2 definition to Postgres (`form_drafts`) when signed in, and keeps IndexedDB as the offline cache
 * plus the home of local FormOps (open / closed screen / plaintext password).
 */
export class CachingApiRepository implements DocumentRepository {
  private readonly cache: DocumentRepository;

  constructor(cache: DocumentRepository) {
    this.cache = cache;
  }

  async list(): Promise<FormSummary[]> {
    const local = await this.cache.list();
    let remote: Awaited<ReturnType<typeof listRemoteForms>> = null;
    try {
      remote = await listRemoteForms();
    } catch {
      remote = null;
    }
    if (!remote) return local;
    const map = new Map(local.map((form) => [form.id, form]));
    for (const row of remote) {
      const existing = map.get(row.id);
      if (!existing) {
        map.set(row.id, { id: row.id, title: row.title, savedAt: row.updatedAt, blocks: 0 });
      } else if (row.updatedAt > existing.savedAt) {
        map.set(row.id, { ...existing, title: row.title || existing.title, savedAt: row.updatedAt });
      }
    }
    return [...map.values()].sort(newestFirst);
  }

  async load(id: string): Promise<StoredForm | null> {
    const local = await this.cache.load(id);
    let remote: Awaited<ReturnType<typeof getRemoteDraft>> = null;
    try {
      remote = await getRemoteDraft(id);
    } catch {
      remote = null;
    }
    if (!remote) return local;
    if (local && local.savedAt > remote.updatedAt) return local;
    const stored: StoredForm = {
      id,
      format: DOCUMENT_FORMAT,
      rev: remote.draftRev,
      savedAt: remote.updatedAt,
      doc: remote.draft,
      ops: local?.ops,
    };
    const media = remote.draft.media;
    if (media && typeof media === 'object') hydrateThemeImages(media as Record<string, string>);
    await this.cache.save(stored);
    return stored;
  }

  async save(form: StoredForm): Promise<void> {
    await this.cache.save(form);
    const title = summarize(form).title;
    try {
      const doc = form.doc && typeof form.doc === 'object' ? { ...(form.doc as Record<string, unknown>), media: themeMediaForDraft(form.doc) } : form.doc;
      await putRemoteDraft(form.id, doc, title);
    } catch {
      /* Local save is enough; org/API refusals must not block creating a form in this browser. */
    }
  }

  async remove(id: string): Promise<void> {
    await this.cache.remove(id);
  }
}
