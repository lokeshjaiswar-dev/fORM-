import { FormDefinitionSchema, type FormDefinition, type FormId } from '@form/schema';
import { ApiProblem, loadSession } from '@/auth/client';
import { blockOrder } from '@/lib/definition';
import { DOCUMENT_FORMAT, DraftConflict, type DocumentRepository, type SaveResult, type ServerDraft } from '@/persistence/DocumentRepository';
import { useDocumentStore } from '@/state/documentStore';
import { loadDocument } from '@/state/history';
import { useOpsStore, type LocalOps } from '@/state/opsStore';
import { resetUi, useUiStore, type SaveState } from '@/state/uiStore';

/** A change is written to this browser this long after the last keystroke. */
export const AUTOSAVE_MS = 400;
/** ... and sent to the server this long after the last one (WP-1.06: autosave every 2 s idle). */
export const API_SAVE_MS = 2000;
/** An unreachable server is tried again this often, and as soon as the browser is back online. */
export const RETRY_MS = 15_000;

/** Every local write in this page, in order, so a reader that opens next sees the last one. */
let localWrites: Promise<void> = Promise.resolve();
/** Every server write, in order. Kept apart from the local ones so a slow network never holds back the copy in this browser. */
let remoteWrites: Promise<void> = Promise.resolve();

/** Settles when every write asked for so far, local and server, has finished (or failed). */
export function whenSaved(): Promise<void> {
  return Promise.all([localWrites, remoteWrites]).then(() => undefined);
}

/** What a flush leaves: the server draft revision that holds exactly the open document, or null when the server does not have it (yet). */
export interface FlushResult {
  serverRev: number | null;
}

/** Writes a pending change now, to this browser and the server, so Publish sends the document on screen. */
export async function flushAutosave(): Promise<FlushResult> {
  return active ? active.flush() : whenSaved().then(() => ({ serverRev: null }));
}

/** The autosave of the form open in this page. */
let active: Autosave | null = null;

/** Drops the open form's unsaved change and stops its autosave, so a reload shows what another tab saved. */
export function discardPending(): void {
  active?.discard();
}

/** The server holds a draft this page has not seen (a publish found it): shows the merge dialog. */
export function raiseDraftConflict(server: ServerDraft): void {
  active?.conflict(server);
}

/** The merge dialog's choices, applied to the form open in this page. */
export const keepMine = (): Promise<void> => active?.keepMine() ?? Promise.resolve();
export const takeTheirs = (): Promise<void> => active?.takeTheirs() ?? Promise.resolve();

export interface AutosaveOptions {
  repo: DocumentRepository;
  id: string;
  /** The revision the open document was loaded at. */
  rev: number;
  /** The server draft revision the open document was loaded at; 0 for a form the server has not seen. */
  serverRev?: number | undefined;
  delayMs?: number;
  apiDelayMs?: number;
  now?: () => string;
  onState?: (state: SaveState) => void;
  onSaved?: (rev: number) => void;
}

export interface Autosave {
  /** Saves a pending change now, here and on the server. */
  flush: () => Promise<FlushResult>;
  /** Stops watching the document and saves a pending change; save states are no longer reported. */
  stop: () => Promise<void>;
  /** Stops watching the document and drops a pending change unsaved. */
  discard: () => void;
  /** The server's draft moved on: stops sending, keeps saving here, and shows the merge dialog. */
  conflict: (server: ServerDraft) => void;
  /** Sends the document on screen on top of the server's draft (the merge dialog's "keep mine"). */
  keepMine: () => Promise<void>;
  /** Loads the server's draft over the document on screen (the merge dialog's "take theirs"). */
  takeTheirs: () => Promise<void>;
}

interface Snapshot {
  doc: FormDefinition;
  ops: LocalOps;
  /** Given at the first write of this snapshot, so every try of it (here and on the server) carries one number. */
  rev?: number;
}

const snapshot = (): Snapshot => ({ doc: useDocumentStore.getState().doc, ops: useOpsStore.getState() });

/** Two snapshots of the same document and ops: the stores replace their objects on every change, so identity is enough. */
const sameSnapshot = (a: Snapshot, b: Snapshot): boolean => a.doc === b.doc && a.ops === b.ops;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Saves the open document and its local FormOps (undo and redo included), one write at a time.
 *
 * With a repository that has a server behind it (`saveLocal`): the change is written to this browser 400 ms after the
 * last edit and sent to the server 2 s after it, with `If-Match` = the server revision this tab last saw. The state is
 * `saving` until the server has it; `local` when it could not be reached (the change is safe here and goes up on a
 * retry); `conflict` when the server answered 409, which stops sending until the author chooses in the merge dialog.
 * With a local-only repository the 400 ms write is all there is.
 *
 * A write that fails stays pending and is written again by the next flush, unless a newer change was queued after it:
 * an older document never overwrites a newer one (BL-147). The server write always takes the newest change at the
 * moment it runs, so a queue of them sends one document.
 */
export function startAutosave({
  repo, id, rev, serverRev = 0, delayMs = AUTOSAVE_MS, apiDelayMs = API_SAVE_MS, now = () => new Date().toISOString(), onState, onSaved,
}: AutosaveOptions): Autosave {
  const split = repo.saveLocal !== undefined;
  let localTimer: ReturnType<typeof setTimeout> | null = null;
  let apiTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The newest change not yet written to this browser. */
  let pending: Snapshot | null = null;
  /** The last snapshot handed to a local write. */
  let queued: Snapshot | null = null;
  /** The last snapshot a local write finished. */
  let lastLocal: Snapshot | null = null;
  /** The newest document the server does not have (server mode). */
  let unsynced: Snapshot | null = null;
  /** The server draft revision this tab last saw: what the next save sends as `If-Match`. */
  let confirmedRev = serverRev;
  let revCounter = rev;
  let disputed: ServerDraft | null = null;
  let suppressed = false;
  let stopped = false;
  let discarded = false;

  const revOf = (snap: Snapshot): number => (snap.rev ??= revCounter += 1);

  const report = (state: SaveState) => {
    if (!stopped) onState?.(state);
  };

  const record = (snap: Snapshot, savedAt: string) => ({ id, format: DOCUMENT_FORMAT, rev: revOf(snap), savedAt, doc: snap.doc, ops: snap.ops, serverRev: confirmedRev });

  const clearTimers = () => {
    for (const timer of [localTimer, apiTimer, retryTimer]) if (timer !== null) clearTimeout(timer);
    localTimer = apiTimer = retryTimer = null;
  };

  const raise = (server: ServerDraft) => {
    if (server.draft === null) {
      // The server holds no draft to merge with (it was never saved, or was lost): ours goes up as the first one.
      confirmedRev = server.draftRev;
      unsynced ??= snapshot();
      arm('api');
      return;
    }
    disputed = server;
    unsynced ??= snapshot();
    if (apiTimer !== null) clearTimeout(apiTimer);
    apiTimer = null;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    report({ state: 'conflict' });
    useUiStore.getState().raiseDraftConflict(server);
  };

  /** What a save that failed means for the author. A refusal that only a fresh sign-in fixes sends them there. */
  const fail = (e: unknown) => {
    if (e instanceof DraftConflict) {
      raise(e.server);
      return;
    }
    if (e instanceof ApiProblem && e.status === 401) void loadSession();
    report({ state: 'error', message: messageOf(e) });
  };

  const writeLocal = (snap: Snapshot): Promise<void> => {
    queued = snap;
    localWrites = localWrites.then(async () => {
      const savedAt = now();
      try {
        if (split) await repo.saveLocal?.(record(snap, savedAt));
        else await repo.save(record(snap, savedAt));
        lastLocal = snap;
        if (!split && pending === null && queued === snap) report({ state: 'saved', at: savedAt });
        onSaved?.(revOf(snap));
      } catch (e) {
        if (pending === null && !discarded && queued === snap) pending = snap;
        fail(e);
      }
    });
    return localWrites;
  };

  const flushLocal = (): Promise<void> => {
    if (localTimer !== null) clearTimeout(localTimer);
    localTimer = null;
    const snap = pending;
    pending = null;
    return snap ? writeLocal(snap) : localWrites;
  };

  /** Sends the newest unsent document, now. A no-op when there is none or the author has a merge to resolve. */
  const pushRemote = (): Promise<void> => {
    if (apiTimer !== null) clearTimeout(apiTimer);
    apiTimer = null;
    remoteWrites = remoteWrites.then(async () => {
      // Local writes first, so the copy in this browser is never older than what the server is sent.
      await flushLocal();
      const snap = unsynced;
      if (!snap || disputed !== null || discarded) return;
      let result: SaveResult;
      try {
        result = (await repo.save(record(snap, now()))) ?? { serverRev: confirmedRev, synced: true };
      } catch (e) {
        fail(e);
        return;
      }
      if (!result.synced) {
        report({ state: 'local', at: now() });
        arm('retry');
        return;
      }
      confirmedRev = result.serverRev;
      if (unsynced === snap) unsynced = null;
      if (unsynced === null && pending === null) report({ state: 'saved', at: now() });
      // A newer change was written here while this one travelled: its cached copy still names the older server revision.
      if (lastLocal !== null && !sameSnapshot(lastLocal, snap)) void writeLocal(lastLocal);
    });
    return remoteWrites;
  };

  const arm = (which: 'local' | 'api' | 'retry') => {
    if (which === 'local') {
      if (localTimer !== null) clearTimeout(localTimer);
      localTimer = setTimeout(() => void flushLocal(), delayMs);
    } else if (which === 'api') {
      if (apiTimer !== null) clearTimeout(apiTimer);
      apiTimer = setTimeout(() => void pushRemote(), apiDelayMs);
    } else {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void pushRemote(), RETRY_MS);
    }
  };

  const changed = () => {
    if (suppressed) return;
    if (pending === null && unsynced === null) report({ state: 'saving' });
    pending = snapshot();
    arm('local');
    if (split) {
      unsynced = pending;
      if (disputed === null) arm('api');
    }
  };

  const unsubscribeDoc = useDocumentStore.subscribe((state, prev) => {
    if (state.doc !== prev.doc) changed();
  });
  const unsubscribeOps = useOpsStore.subscribe(changed);

  const flush = async (): Promise<FlushResult> => {
    if (split) {
      await pushRemote();
      // Anything typed while the server write travelled, or a local write that failed, is written here too.
      await flushLocal();
    } else await flushLocal();
    return { serverRev: split && unsynced === null && disputed === null ? confirmedRev : null };
  };

  const onHide = () => void flush();
  const onOnline = () => {
    if (unsynced !== null && disputed === null) void pushRemote();
  };
  window.addEventListener('pagehide', onHide);
  window.addEventListener('online', onOnline);

  const detach = () => {
    stopped = true;
    unsubscribeDoc();
    unsubscribeOps();
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('online', onOnline);
    if (active === autosave) active = null;
  };

  const autosave: Autosave = {
    flush,
    stop: async () => {
      detach();
      await flush();
    },
    discard: () => {
      detach();
      discarded = true;
      clearTimers();
      pending = null;
      unsynced = null;
    },
    conflict: raise,
    keepMine: async () => {
      const server = disputed;
      if (!server) return;
      confirmedRev = server.draftRev;
      disputed = null;
      unsynced = snapshot();
      useUiStore.getState().clearDraftConflict();
      report({ state: 'saving' });
      await flush();
    },
    takeTheirs: async () => {
      const server = disputed;
      if (!server) return;
      const parsed = FormDefinitionSchema.safeParse(server.draft);
      if (!parsed.success) throw new Error('The saved version of this form cannot be read.');
      clearTimers();
      pending = null;
      unsynced = null;
      suppressed = true;
      try {
        loadDocument({ ...(parsed.data as FormDefinition), formId: id as FormId });
      } finally {
        suppressed = false;
      }
      confirmedRev = server.draftRev;
      disputed = null;
      // After every write already queued, so an older write cannot land on top of the server's draft in the cache.
      const doc = useDocumentStore.getState().doc;
      localWrites = localWrites.then(() => repo.adopt?.(id, server)).catch(() => undefined);
      await localWrites;
      resetUi({ started: doc.pages.some((page) => page.children.length > 0) });
      const first = blockOrder(doc)[0];
      if (first) useUiStore.getState().openInspector(first);
      report({ state: 'saved', at: now() });
    },
  };
  active = autosave;
  return autosave;
}
