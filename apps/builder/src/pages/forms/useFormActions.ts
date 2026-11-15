import { useCallback, useRef, useState } from 'react';
import { defineMessages } from '@form/i18n';
import { ApiProblem } from '@/auth/client';
import { t } from '@/i18n';
import { builderPath } from '@/pages/useBuilderMode';
import type { DocumentRepository } from '@/persistence/DocumentRepository';
import { archiveForm, cloneForm, restoreForm, setFavourite } from '@/persistence/formsListApi';
import { rowTitle } from '@/pages/forms/rowTitle';
import { describeError, type FormsList, type ListRow } from '@/pages/forms/useFormsList';

const M = defineMessages('builder', {
  'forms.action_failed': 'That did not work. Try again.',
  'forms.forbidden': 'You do not have permission to do that.',
  'forms.notice_trashed': '“{title}” was moved to the trash.',
  'forms.notice_deleted': '“{title}” was deleted.',
  'forms.notice_archived': '“{title}” was archived.',
  'forms.notice_unarchived': '“{title}” is active again.',
  'forms.notice_restored': '“{title}” was restored.',
  'forms.notice_cloned': '“{title}” was created.',
  'forms.undo': 'Undo',
  'forms.open': 'Open',
});

/** What the page tells the member after an action: the sentence and, at most, one thing to do next. */
export interface Notice {
  text: string;
  action?: { label: string; run: () => void } | { label: string; to: string };
}

/** The action a row asks for; each is one call, and a row has at most one in flight. */
export interface FormActions {
  notice: Notice | null;
  dismissNotice: () => void;
  /** The ids of the rows with a call in flight: their controls are off until it answers. */
  busy: ReadonlySet<string>;
  star: (row: ListRow) => Promise<void>;
  clone: (row: ListRow) => Promise<void>;
  archive: (row: ListRow) => Promise<void>;
  /** Archived or trashed to Active again. */
  restore: (row: ListRow) => Promise<void>;
  /** To the server's trash through the repository (which also drops the browser's copy). A form the server never saw is deleted for good. */
  trash: (row: ListRow) => Promise<void>;
}

/** The forms list's one-form actions (BL-267). Each tells the member what happened; a failure goes to `onError`, and a refusal for want of permission says so. */
export function useFormActions(repo: DocumentRepository, org: string | null, list: FormsList, onError: (message: string | null) => void): FormActions {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const source = list.state.status === 'ready' ? list.state.source : null;

  const fail = useCallback(
    (err: unknown) => {
      // The server's own sentence says why; a refusal for want of permission with none still says that much.
      onError(describeError(err, t(M[err instanceof ApiProblem && err.status === 403 ? 'forms.forbidden' : 'forms.action_failed'])));
    },
    [onError],
  );

  /** Runs one call for a row: no second call for the same row while it is out, and the controls of that row are off meanwhile. */
  const run = useCallback(
    async (row: ListRow, call: () => Promise<void>) => {
      if (inFlight.current.has(row.id)) return;
      inFlight.current.add(row.id);
      setBusy(new Set(inFlight.current));
      onError(null);
      try {
        await call();
      } catch (err) {
        fail(err);
      } finally {
        inFlight.current.delete(row.id);
        setBusy(new Set(inFlight.current));
      }
    },
    [fail, onError],
  );

  const open = (id: string): NonNullable<Notice['action']> => ({ label: t(M['forms.open']), to: builderPath(id) });

  /** Puts a form back in the folder it came from: the undo of an archive or a move to the trash. */
  const undo = useCallback(
    async (row: ListRow) => {
      if (org === null) return;
      setNotice(null);
      try {
        await restoreForm(org, row.id);
        list.reload();
      } catch (err) {
        fail(err);
      }
    },
    [org, list, fail],
  );

  return {
    notice,
    dismissNotice: () => setNotice(null),
    busy,

    star: (row) =>
      run(row, async () => {
        if (org === null) return;
        const next = !row.favourite;
        // Shown at once; put back if the server does not take it.
        list.patchRow(row.id, { favourite: next });
        try {
          const confirmed = await setFavourite(org, row.id, next);
          list.patchRow(row.id, { favourite: confirmed });
          // In the starred view an unstarred form no longer belongs.
          if (list.favourite && !confirmed) list.removeRow(row.id);
        } catch (err) {
          list.patchRow(row.id, { favourite: row.favourite });
          throw err;
        }
      }),

    clone: (row) =>
      run(row, async () => {
        if (org === null) return;
        const copy = await cloneForm(org, row.id);
        if (list.lifecycle === 'active') list.reload();
        setNotice({ text: t(M['forms.notice_cloned'], { title: rowTitle(copy) }), action: open(copy.id) });
      }),

    archive: (row) =>
      run(row, async () => {
        if (org === null) return;
        await archiveForm(org, row.id);
        list.removeRow(row.id);
        setNotice({ text: t(M['forms.notice_archived'], { title: rowTitle(row) }), action: { label: t(M['forms.undo']), run: () => void undo(row) } });
      }),

    restore: (row) =>
      run(row, async () => {
        if (org === null) return;
        const fromTrash = row.lifecycle === 'trashed';
        await restoreForm(org, row.id);
        list.removeRow(row.id);
        setNotice({ text: t(M[fromTrash ? 'forms.notice_restored' : 'forms.notice_unarchived'], { title: rowTitle(row) }), action: open(row.id) });
      }),

    trash: (row) =>
      run(row, async () => {
        await repo.remove(row.id);
        list.removeRow(row.id);
        // Only a form the server holds can come back, and only while the server is the list's source.
        const restorable = !row.unsynced && source === 'server';
        setNotice(
          restorable
            ? { text: t(M['forms.notice_trashed'], { title: rowTitle(row) }), action: { label: t(M['forms.undo']), run: () => void undo(row) } }
            : { text: t(M[row.unsynced ? 'forms.notice_deleted' : 'forms.notice_trashed'], { title: rowTitle(row) }) },
        );
      }),
  };
}
