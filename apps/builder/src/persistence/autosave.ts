import type { FormDefinition } from '@form/schema';
import { DOCUMENT_FORMAT, type DocumentRepository } from '@/persistence/DocumentRepository';
import { useDocumentStore } from '@/state/documentStore';
import { useOpsStore, type LocalOps } from '@/state/opsStore';
import type { SaveState } from '@/state/uiStore';

export const AUTOSAVE_MS = 400;

/** Every autosave write in this page, in order, so a reader that opens next sees the last one. */
let writes: Promise<void> = Promise.resolve();

export function whenSaved(): Promise<void> {
  return writes;
}

/** The autosave of the form open in this page. */
let active: Autosave | null = null;

/** Drops the open form's unsaved change and stops its autosave, so a reload shows what another tab saved. */
export function discardPending(): void {
  active?.discard();
}

export interface AutosaveOptions {
  repo: DocumentRepository;
  id: string;
  /** The revision the open document was loaded at. */
  rev: number;
  delayMs?: number;
  now?: () => string;
  onState?: (state: SaveState) => void;
  onSaved?: (rev: number) => void;
}

export interface Autosave {
  /** Saves a pending change now. */
  flush: () => Promise<void>;
  /** Stops watching the document and saves a pending change; save states are no longer reported. */
  stop: () => Promise<void>;
  /** Stops watching the document and drops a pending change unsaved. */
  discard: () => void;
}

interface Snapshot {
  doc: FormDefinition;
  ops: LocalOps;
}

const snapshot = (): Snapshot => ({ doc: useDocumentStore.getState().doc, ops: useOpsStore.getState() });

/**
 * Saves the open document and its local FormOps a short while after each change (undo and redo included), one save
 * at a time. The state is `saving` from the first unsaved change until every change is written. A change that fails
 * to save stays pending and is written again by the next flush, unless a newer change was queued after it: an older
 * document never overwrites a newer one (BL-147).
 */
export function startAutosave({ repo, id, rev, delayMs = AUTOSAVE_MS, now = () => new Date().toISOString(), onState, onSaved }: AutosaveOptions): Autosave {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Snapshot | null = null;
  /** The last snapshot handed to `write`. */
  let queued: Snapshot | null = null;
  let stopped = false;
  let discarded = false;

  const report = (state: SaveState) => {
    if (!stopped) onState?.(state);
  };

  const write = (snap: Snapshot) => {
    queued = snap;
    writes = writes.then(async () => {
      const savedAt = now();
      try {
        await repo.save({ id, format: DOCUMENT_FORMAT, rev: rev + 1, savedAt, doc: snap.doc, ops: snap.ops });
        rev += 1;
        if (pending === null && queued === snap) report({ state: 'saved', at: savedAt });
        onSaved?.(rev);
      } catch (e) {
        if (pending === null && !discarded && queued === snap) pending = snap;
        report({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    });
    return writes;
  };

  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const snap = pending;
    pending = null;
    return snap ? write(snap) : writes;
  };

  const changed = () => {
    if (pending === null) report({ state: 'saving' });
    pending = snapshot();
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void flush(), delayMs);
  };
  const unsubscribeDoc = useDocumentStore.subscribe((state, prev) => {
    if (state.doc !== prev.doc) changed();
  });
  const unsubscribeOps = useOpsStore.subscribe(changed);

  const onHide = () => void flush();
  window.addEventListener('pagehide', onHide);

  const detach = () => {
    stopped = true;
    unsubscribeDoc();
    unsubscribeOps();
    window.removeEventListener('pagehide', onHide);
    if (active === autosave) active = null;
  };

  const autosave: Autosave = {
    flush,
    stop: () => {
      detach();
      return flush();
    },
    discard: () => {
      detach();
      discarded = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
  active = autosave;
  return autosave;
}
