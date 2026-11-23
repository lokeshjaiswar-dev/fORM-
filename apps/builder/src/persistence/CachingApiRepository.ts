import { ApiUnreachable } from '@/auth/client';
import { DOCUMENT_FORMAT, newestFirst, summarize, type DocumentRepository, type FormSummary, type StoredForm } from '@/persistence/DocumentRepository';
import { hydrateThemeImages, themeMediaForDraft } from '@/components/builder/design/uploads';
import { deleteRemoteForm, getRemoteDraft, listRemoteForms, putRemoteDraft } from '@/persistence/draftsApi';

/**
 * Uses the API database when it answers, and this browser's store when it does not.
 * IndexedDB still keeps a copy after a successful API write, including local FormOps
 * (open / closed screen / plaintext password) that are not sent to the server.
 */
export class CachingApiRepository implements DocumentRepository {
  private readonly cache: DocumentRepository;
  /** Null until the first probe. False after the API cannot be reached. */
  private online: boolean | null = null;
  private probe: Promise<boolean> | null = null;
  private probed: Awaited<ReturnType<typeof listRemoteForms>> | undefined = undefined;
  private listFlight: Promise<FormSummary[]> | null = null;
  private readonly loadFlight = new Map<string, Promise<StoredForm | null>>();

  constructor(cache: DocumentRepository) {
    this.cache = cache;
  }

  private apiUp(): Promise<boolean> {
    if (this.online !== null) return Promise.resolve(this.online);
    this.probe ??= listRemoteForms()
      .then((rows) => {
        this.probed = rows;
        this.online = rows !== null;
        return this.online;
      })
      .catch(() => {
        this.online = false;
        this.probed = null;
        return false;
      });
    return this.probe;
  }

  /**
   * The definition the API stores. Theme image bytes stay out of the form document: `FormDefinition` rejects a
   * `media` key, which is what made a new form fail to open.
   */
  private draftBody(form: StoredForm): unknown {
    if (!form.doc || typeof form.doc !== 'object') return form.doc;
    const doc = { ...(form.doc as Record<string, unknown>) };
    const media = themeMediaForDraft(form.doc);
    if (Object.keys(media).length > 0) doc.media = media;
    else delete doc.media;
    return doc;
  }

  async list(): Promise<FormSummary[]> {
    if (this.listFlight) return this.listFlight;
    this.listFlight = this.fetchList().finally(() => {
      this.listFlight = null;
    });
    return this.listFlight;
  }

  private async fetchList(): Promise<FormSummary[]> {
    const local = await this.cache.list();
    if (!(await this.apiUp())) return local;
    let remote = this.probed;
    this.probed = undefined;
    if (remote === undefined) {
      try {
        remote = await listRemoteForms();
      } catch (err) {
        if (err instanceof ApiUnreachable) {
          this.online = false;
          return local;
        }
        throw err;
      }
    }
    if (!remote) {
      this.online = false;
      return local;
    }
    const blocks = new Map(local.map((form) => [form.id, form.blocks]));
    return remote
      .map((row) => ({ id: row.id, title: row.title, savedAt: row.updatedAt, blocks: blocks.get(row.id) ?? 0 }))
      .sort(newestFirst);
  }

  async load(id: string): Promise<StoredForm | null> {
    const pending = this.loadFlight.get(id);
    if (pending) return pending;
    const flight = this.fetchLoad(id).finally(() => {
      this.loadFlight.delete(id);
    });
    this.loadFlight.set(id, flight);
    return flight;
  }

  private async fetchLoad(id: string): Promise<StoredForm | null> {
    const local = await this.cache.load(id);
    if (!(await this.apiUp())) return local;
    let remote: Awaited<ReturnType<typeof getRemoteDraft>> = null;
    try {
      remote = await getRemoteDraft(id);
    } catch (err) {
      if (err instanceof ApiUnreachable) {
        this.online = false;
        return local;
      }
      throw err;
    }
    if (!remote) return null;
    const draft = { ...remote.draft };
    const media = draft.media;
    delete draft.media;
    if (media && typeof media === 'object') hydrateThemeImages(media as Record<string, string>);
    const stored: StoredForm = {
      id,
      format: DOCUMENT_FORMAT,
      rev: remote.draftRev,
      savedAt: remote.updatedAt,
      doc: draft,
      ops: local?.ops,
    };
    await this.cache.save(stored);
    return stored;
  }

  async save(form: StoredForm): Promise<void> {
    if (await this.apiUp()) {
      try {
        await putRemoteDraft(form.id, this.draftBody(form), summarize(form).title);
      } catch (err) {
        if (!(err instanceof ApiUnreachable)) throw err;
        this.online = false;
      }
    }
    await this.cache.save(form);
  }

  async remove(id: string): Promise<void> {
    if (await this.apiUp()) {
      try {
        await deleteRemoteForm(id);
      } catch (err) {
        if (!(err instanceof ApiUnreachable)) throw err;
        this.online = false;
      }
    }
    await this.cache.remove(id);
  }
}
