import { ApiProblem, ApiUnreachable } from '@/auth/client';
import { sameDefinition } from '@/lib/draftDiff';
import {
  DOCUMENT_FORMAT,
  DraftConflict,
  newestFirst,
  summarize,
  type DocumentRepository,
  type FormSummary,
  type SaveResult,
  type ServerDraft,
  type StoredForm,
} from '@/persistence/DocumentRepository';
import { createRemoteForm, getRemoteDraft, listRemoteForms, putRemoteDraft, trashRemoteForm } from '@/persistence/draftsApi';

/**
 * A form's local FormOps for the cache: the plaintext password never goes to IndexedDB while signed in (BL-145). The
 * password stays in the open tab's memory for the preview; the server will hash it when access settings move there.
 */
function scrubbed(form: StoredForm): StoredForm {
  const ops = form.ops;
  if (typeof ops !== 'object' || ops === null || !('password' in ops) || ops.password === '') return form;
  return { ...form, ops: { ...ops, password: '' } };
}

/**
 * The builder's repository while signed in (WP-1.06): the v2 definition lives in Postgres (`form_drafts`), written
 * with `If-Match`, and IndexedDB is the offline cache, with the local FormOps beside it. One repository serves one
 * org: its cache is that org's database and every call names that org, so switching orgs means a new repository.
 *
 * Revisions: `serverRev` is the draft revision a cached document was last in step with, `dirty` says it holds changes
 * the server has not accepted. `load` takes a newer server draft over a clean cache; over a dirty cache it raises
 * `DraftConflict` instead of choosing for the author.
 */
export class CachingApiRepository implements DocumentRepository {
  private readonly cache: DocumentRepository;
  private readonly org: string;
  /** Cache writes run one at a time, in the order they were asked, so a slow older write never lands over a newer one. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Per form, the number of the latest local write of this tab: a server answer only marks the cache clean if nothing newer was written meanwhile. */
  private readonly latest = new Map<string, number>();

  constructor(cache: DocumentRepository, org: string) {
    this.cache = cache;
    this.org = org;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private stamp(id: string): number {
    const n = (this.latest.get(id) ?? 0) + 1;
    this.latest.set(id, n);
    return n;
  }

  async list(): Promise<FormSummary[]> {
    const local = await this.cache.list();
    let remote: Awaited<ReturnType<typeof listRemoteForms>> = null;
    try {
      remote = await listRemoteForms(this.org);
    } catch {
      remote = null;
    }
    if (!remote) return local;
    const onServer = new Set(remote.items.map((row) => row.id));
    const map = new Map<string, FormSummary>();
    for (const form of local) {
      // A form the server knew and no longer lists was archived, trashed or removed elsewhere. One that never reached the server stays.
      if (remote.complete && (form.serverRev ?? 0) > 0 && !onServer.has(form.id)) continue;
      map.set(form.id, form);
    }
    for (const row of remote.items) {
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
      remote = await getRemoteDraft(this.org, id);
    } catch (err) {
      // Offline-first: a server that cannot answer leaves the cached copy. With nothing cached, say why.
      if (!local) throw err;
    }
    if (!remote) return local;

    const behind = local?.serverRev ?? 0;
    if (local && remote.draftRev <= behind) return local;
    if (local?.dirty === true) {
      // The same document the server holds (a first push whose answer was lost): nothing to choose between.
      if (sameDefinition(local.doc, remote.draft)) {
        const same: StoredForm = { ...local, serverRev: remote.draftRev, dirty: false };
        await this.exclusive(() => this.cache.save(scrubbed(same)));
        return same;
      }
      throw new DraftConflict(remote, local);
    }
    const stored: StoredForm = {
      id,
      format: DOCUMENT_FORMAT,
      rev: remote.draftRev,
      savedAt: remote.updatedAt,
      doc: remote.draft,
      ops: local?.ops,
      serverRev: remote.draftRev,
      dirty: false,
    };
    this.stamp(id);
    await this.exclusive(() => this.cache.save(scrubbed(stored)));
    return stored;
  }

  async saveLocal(form: StoredForm): Promise<void> {
    this.stamp(form.id);
    await this.exclusive(() => this.cache.save(scrubbed({ ...form, serverRev: form.serverRev ?? 0, dirty: true })));
  }

  async save(form: StoredForm): Promise<SaveResult> {
    const serverRev = form.serverRev ?? 0;
    const token = this.stamp(form.id);
    const mine: StoredForm = { ...form, serverRev, dirty: form.dirty ?? true };
    await this.exclusive(() => this.cache.save(scrubbed(mine)));
    // A form read from the server and saved as it came (a merge result) has nothing to send.
    if (!mine.dirty) return { serverRev, synced: true };

    let saved: Awaited<ReturnType<typeof putRemoteDraft>>;
    try {
      // The first save of a form made here creates its row; a retry of that save changes nothing.
      if (serverRev === 0) await createRemoteForm(this.org, form.id, summarize(form).title);
      saved = await putRemoteDraft(this.org, form.id, form.doc, serverRev);
    } catch (err) {
      // Offline is not a failure: the document is in the cache, dirty, and goes up with a later save.
      if (err instanceof ApiUnreachable) return { serverRev, synced: false };
      if (err instanceof DraftConflict) throw new DraftConflict(err.server, mine);
      throw err;
    }
    await this.exclusive(async () => {
      if (this.latest.get(form.id) === token) await this.cache.save(scrubbed({ ...mine, serverRev: saved.draftRev, dirty: false }));
    });
    return { serverRev: saved.draftRev, synced: true };
  }

  async adopt(id: string, server: ServerDraft): Promise<void> {
    this.stamp(id);
    await this.exclusive(async () => {
      const current = await this.cache.load(id).catch(() => null);
      await this.cache.save(
        scrubbed({ id, format: DOCUMENT_FORMAT, rev: current?.rev ?? 0, savedAt: server.updatedAt, doc: server.draft, ops: current?.ops, serverRev: server.draftRev, dirty: false }),
      );
    });
  }

  /** Moves the form to the server's trash (restorable) and drops it from this browser. A form the server never saw is only dropped. */
  async remove(id: string): Promise<void> {
    try {
      await trashRemoteForm(this.org, id);
    } catch (err) {
      if (!(err instanceof ApiProblem && err.status === 404)) throw err;
    }
    this.stamp(id);
    await this.exclusive(() => this.cache.remove(id));
  }
}
