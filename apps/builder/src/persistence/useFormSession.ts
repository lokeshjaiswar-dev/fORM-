import { useEffect, useState } from 'react';
import type { IsoInstant } from '@form/schema';
import { activeOrgOf, useSessionStore } from '@/auth/client';
import { loadDocument } from '@/state/history';
import { loadOps } from '@/state/opsStore';
import { blockOrder } from '@/lib/definition';
import { resetUi, useUiStore, type LoadNote, type TabConflict } from '@/state/uiStore';
import { startAutosave, whenSaved, type Autosave } from '@/persistence/autosave';
import { openStored, settleLegacyAccess } from '@/persistence/openForm';
import { DOCUMENT_FORMAT, DraftConflict, type DocumentRepository, type StoredForm } from '@/persistence/DocumentRepository';
import { useRepository } from '@/persistence/repository';
import { watchTabs, type TabWatch } from '@/persistence/tabChannel';

export type Session = { status: 'loading' } | { status: 'ready' } | { status: 'missing' } | { status: 'error'; message: string };

/** Notes from an import, shown when the imported form first opens. */
const pendingNotes = new Map<string, LoadNote[]>();

export function noteImport(id: string, notes: LoadNote[]): void {
  pendingNotes.set(id, notes);
}

const raise = (conflict: TabConflict) =>
  useUiStore.setState((s) => ({ conflict: s.conflict === 'saved_elsewhere' ? s.conflict : conflict }));

/**
 * Opens form `id` from the repository into the document store (history starts empty), autosaves every change and
 * watches other tabs on the same form. A v1 draft is migrated once and saved back as v2 before editing starts
 * (BL-143). Leaving the form flushes the last change.
 *
 * A form whose cached copy has unsent changes while the server's draft moved on opens with the cached copy and the
 * merge dialog (WP-1.06): autosave stays paused until the author chooses.
 */
export function useFormSession(id: string): Session {
  const repo = useRepository();
  const [opened, setOpened] = useState<{ id: string; repo: DocumentRepository; session: Session } | null>(null);

  useEffect(() => {
    let live = true;
    let autosave: Autosave | null = null;
    let tabs: TabWatch | null = null;
    const setSession = (session: Session) => setOpened({ id, repo, session });
    const open = async () => {
      await whenSaved();
      let stored: StoredForm | null;
      let disputed: DraftConflict | null = null;
      try {
        stored = await repo.load(id);
      } catch (e) {
        if (!(e instanceof DraftConflict) || !e.local) throw e;
        stored = e.local;
        disputed = e;
      }
      if (!live) return;
      if (!stored) {
        setSession({ status: 'missing' });
        return;
      }
      const now = new Date().toISOString();
      const result = openStored(stored, now as IsoInstant);
      if (!result.ok) {
        setSession({ status: 'error', message: result.error });
        return;
      }
      // The FormOps this session works with and autosave writes over the cached copy on every save. A closed state the server has not taken is part of them (`pendingAccess`); without it the first save would drop it.
      let ops = result.ops;
      if (result.legacy) {
        // A password or closed state an older build kept in this browser goes to the API now, before a v1 file is replaced by its conversion (BL-145). A form behind the merge dialog is no exception: the access settings are not part of the draft being disputed, and a plaintext password may not wait for the author's choice (BL-273).
        const session = useSessionStore.getState();
        const org = session.status === 'signed_in' ? (activeOrgOf(session.me)?.id ?? null) : null;
        const settled = await settleLegacyAccess(stored, result, { org, repo });
        result.notes.push(...settled.notes);
        ops = settled.ops;
        if (!live) return;
      }
      let rev = stored.rev;
      let serverRev = stored.serverRev;
      // Unsent changes in the cached copy go up once the form is open, unless the author has a merge to resolve first.
      let dirty = stored.dirty === true && disputed === null;
      if (result.migrated) {
        rev += 1;
        const saved = await repo.save({ id, format: DOCUMENT_FORMAT, rev, savedAt: now, doc: result.doc, ops, serverRev });
        if (saved) {
          serverRev = saved.serverRev;
          // The migrated copy is on the server now, or (offline) cached dirty and still to be sent.
          dirty = !saved.synced && disputed === null;
        }
        if (!live) return;
      }
      const imported = pendingNotes.get(id) ?? [];
      pendingNotes.delete(id);
      loadDocument(result.doc);
      loadOps(ops);
      const started = result.doc.pages.some((p) => p.children.length > 0);
      resetUi({ started, notes: [...imported, ...result.notes] });
      const first = blockOrder(result.doc)[0];
      if (first) useUiStore.getState().openInspector(first);
      const watch = watchTabs(id, raise);
      tabs = watch;
      autosave = startAutosave({ repo, id, rev, serverRev, dirty, onState: (save) => useUiStore.setState({ save }), onSaved: watch.saved });
      if (disputed) autosave.conflict(disputed.server);
      setSession({ status: 'ready' });
    };
    open().catch((e: unknown) => {
      /* A failure while opening (not only while loading) shows the error instead of leaving the page loading. */
      if (live) setSession({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      live = false;
      const watch = tabs;
      void (autosave?.stop() ?? Promise.resolve()).finally(() => watch?.close());
    };
  }, [repo, id]);

  return opened?.id === id && opened.repo === repo ? opened.session : { status: 'loading' };
}
