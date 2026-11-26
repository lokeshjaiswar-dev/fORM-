import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import type { FormDefinition, MergeConflict, MergeResolution } from '@form/schema';
import { t } from '@/i18n';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@dmacq/ui';
import { AccountMenu } from '@/auth/AccountMenu';
import { useActiveOrg } from '@/auth/client';
import { preloadGallery } from '@/components/templates/gallery';
import { CreateFormDialog, type CreateStep } from '@/components/forms/CreateFormDialog';
import { mergeFromRepository } from '@/lib/mergeSelected';
import { uid } from '@/lib/utils';
import type { StoredForm } from '@/persistence/DocumentRepository';
import { mergeRemoteForms } from '@/persistence/draftsApi';
import { newStoredForm } from '@/persistence/openForm';
import { useRepository } from '@/persistence/repository';
import { FormsListPanel } from '@/pages/forms/FormsListPanel';
import { FormsNotice } from '@/pages/forms/FormsNotice';
import { FormsTabs } from '@/pages/forms/FormsTabs';
import { FormsToolbar } from '@/pages/forms/FormsToolbar';
import { rowTitle } from '@/pages/forms/rowTitle';
import { useFormActions } from '@/pages/forms/useFormActions';
import { useFormsList, type ListRow } from '@/pages/forms/useFormsList';
import { builderPath } from '@/pages/useBuilderMode';
import { navigateWithTransition } from '@/lib/viewTransition';

const M = defineMessages('builder', {
  'forms.title': 'Forms',
  'forms.new': 'New form',
  'forms.untitled': 'Untitled form',
  'forms.not_saved': 'The form could not be saved in this browser.',
  'forms.cancel': 'Cancel',
  'forms.delete_title': 'Delete this form?',
  'forms.delete_body': '“{title}” was never saved to the server, so it cannot be restored. This cannot be undone.',
  'forms.delete_confirm': 'Delete form',
  'forms.merge': 'Merge selected',
  'forms.merge_need_two': 'Select at least two forms to merge.',
  'forms.merge_failed': 'Those forms could not be merged.',
  'forms.merge_conflict_title': 'These fields cannot be combined',
  'forms.merge_conflict_help': 'The same question appears in more than one form, but the extra rules do not fit together. Pick which version to keep.',
  'forms.merge_use': 'Use this version',
  'forms.merge_continue': 'Merge with these choices',
});

const NONE_SELECTED: ReadonlySet<string> = new Set();

/**
 * The forms of the active org (BL-267): search, sort, stars, the Active, Archived and Trash folders, and clone, archive,
 * restore and trash on each row. The list itself is the server's (`useFormsList`); this page adds creating a form and
 * merging the selected ones.
 */
export function FormsPage() {
  const repo = useRepository();
  const org = useActiveOrg()?.id ?? null;
  const navigate = useNavigate();
  const list = useFormsList(repo, org);
  const [error, setError] = useState<string | null>(null);
  const actions = useFormActions(repo, org, list, setError);
  /* Which step of the Create a form overlay is open: the choice (New form), or null while it is closed. */
  const [creating, setCreating] = useState<CreateStep | null>(null);
  /** A new form is being saved and opened: a second click on a start option does nothing. */
  const startingRef = useRef(false);
  /** A form only this browser has, asked to be deleted: it cannot be restored, so the member confirms first. */
  const [removing, setRemoving] = useState<ListRow | null>(null);
  const { lifecycle, sort, favourite } = list;
  // The forms ticked for a merge belong to the list they were ticked in: in another folder, search or order they may not
  // be on screen, and merging forms nobody can see would be a surprise. So the selection names its list, and a list
  // that is loaded again starts with nothing ticked.
  const [selection, setSelection] = useState<{ view: object; ids: ReadonlySet<string> }>({ view: list.view, ids: new Set() });
  const selected = selection.view === list.view ? selection.ids : NONE_SELECTED;
  const [conflicts, setConflicts] = useState<MergeConflict[] | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [merging, setMerging] = useState(false);
  const loaded = list.state.status === 'ready' ? list.state : null;

  useEffect(preloadGallery, []);

  async function saveThenOpen(form: StoredForm): Promise<boolean> {
    try {
      await repo.save(form);
    } catch {
      setError(t(M['forms.not_saved']));
      return false;
    }
    /* Crossfades the page into the builder where the browser supports view transitions (see index.css). */
    navigateWithTransition(() => navigate(builderPath(form.id)));
    return true;
  }

  /*
   * The create window stays open while the new form is saved, so the page crossfades from it straight into the builder
   * instead of closing first and showing the list for a moment. It closes here only if the save fails.
   */
  async function create(doc?: FormDefinition) {
    if (startingRef.current) return;
    startingRef.current = true;
    setError(null);
    const id = uid();
    const now = new Date().toISOString();
    const opened = await saveThenOpen(doc ? newStoredForm(id, now, doc) : newStoredForm(id, now));
    startingRef.current = false;
    if (!opened) setCreating(null);
  }

  function toggleSelected(id: string) {
    setSelection((prev) => {
      const next = new Set(prev.view === list.view ? prev.ids : []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { view: list.view, ids: next };
    });
  }

  async function runMerge(resolutions?: MergeResolution[]) {
    const ids = [...selected];
    if (ids.length < 2) {
      setError(t(M['forms.merge_need_two']));
      return;
    }
    setError(null);
    setMerging(true);
    try {
      let remote: Awaited<ReturnType<typeof mergeRemoteForms>> = null;
      try {
        remote = await mergeRemoteForms(ids, resolutions);
      } catch (err) {
        setError(err instanceof Error ? err.message : t(M['forms.merge_failed']));
        return;
      }
      if (remote?.ok) {
        setConflicts(null);
        setSelection({ view: list.view, ids: new Set() });
        const stored = await repo.load(remote.id);
        if (stored) await saveThenOpen(stored);
        else navigate(builderPath(remote.id));
        return;
      }
      if (remote && !remote.ok) {
        setConflicts(remote.conflicts);
        return;
      }
      const local = await mergeFromRepository(repo, ids, resolutions);
      if (local.ok) {
        setConflicts(null);
        setSelection({ view: list.view, ids: new Set() });
        await saveThenOpen(local.form);
        return;
      }
      if ('conflicts' in local && local.conflicts) {
        setConflicts(local.conflicts);
        return;
      }
      setError('error' in local ? local.error : t(M['forms.merge_failed']));
    } finally {
      setMerging(false);
    }
  }

  async function confirmDelete() {
    const row = removing;
    setRemoving(null);
    if (row) await actions.trash(row);
  }

  return (
    <main className="mx-auto w-full max-w-[800px] px-8 pb-24 pt-[72px] text-foreground">
      <div className="-mt-12 mb-6 flex justify-end">
        <AccountMenu />
      </div>
      <h1 className="text-[40px] font-bold leading-[1.15] tracking-[-0.02em]">{t(M['forms.title'])}</h1>
      <div className="mt-6 flex gap-2">
        <Button onClick={() => setCreating('choose')}>
          <Plus /> {t(M['forms.new'])}
        </Button>
        {loaded && lifecycle !== 'trashed' && loaded.items.length >= 2 ? (
          <Button
            type="button"
            variant="outline"
            disabled={selected.size < 2 || merging}
            onClick={() => void runMerge()}
          >
            {t(M['forms.merge'])}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-[14px] text-destructive">
          {error}
        </p>
      ) : null}
      <FormsNotice notice={actions.notice} onDismiss={actions.dismissNotice} />
      <div className="mt-8 flex flex-col gap-3">
        <FormsTabs value={lifecycle} onChange={list.setLifecycle} />
        <FormsToolbar
          search={list.search}
          onSearch={list.setSearch}
          sort={sort}
          onSort={list.setSort}
          favourite={favourite}
          onFavourite={list.setFavourite}
          serverControls={loaded?.source !== 'local'}
        />
      </div>
      <FormsListPanel list={list} actions={actions} selected={selected} onToggleSelected={toggleSelected} onConfirmDelete={setRemoving} />
      <CreateFormDialog
        open={creating !== null}
        onOpenChange={(next) => !next && setCreating(null)}
        initialStep={creating ?? 'choose'}
        onBlank={() => void create()}
        onTemplate={(definition) => void create(definition)}
      />
      <Dialog open={conflicts !== null} onOpenChange={(next) => !next && setConflicts(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t(M['forms.merge_conflict_title'])}</DialogTitle>
            <DialogDescription>{t(M['forms.merge_conflict_help'])}</DialogDescription>
          </DialogHeader>
          <ul className="space-y-6">
            {conflicts?.map((conflict) => {
              const key = `${conflict.label}::${conflict.type}`;
              return (
                <li key={key} className="space-y-2">
                  <p className="text-[15px] font-medium">
                    {conflict.label || conflict.type}: {conflict.message}
                  </p>
                  {conflict.sides.map((side) => (
                    <label key={side.formId + side.blockId} className="flex cursor-pointer items-start gap-2 text-[14px]">
                      <input
                        type="radio"
                        name={key}
                        checked={choices[key] === side.formId}
                        onChange={() => setChoices((prev) => ({ ...prev, [key]: side.formId }))}
                      />
                      <span>
                        <span className="font-medium">{side.formTitle || t(M['forms.untitled'])}</span>
                        {side.summary ? <span className="block text-muted-foreground">{side.summary}</span> : null}
                      </span>
                    </label>
                  ))}
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setConflicts(null)}>
              {t(M['forms.cancel'])}
            </Button>
            <Button
              type="button"
              disabled={!conflicts?.every((c) => choices[`${c.label}::${c.type}`]) || merging}
              onClick={() =>
                void runMerge(
                  conflicts?.map((c) => ({
                    label: c.label,
                    type: c.type,
                    chosenFormId: choices[`${c.label}::${c.type}`] ?? '',
                  })),
                )
              }
            >
              {t(M['forms.merge_continue'])}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={removing !== null} onOpenChange={(next) => !next && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(M['forms.delete_title'])}</DialogTitle>
            <DialogDescription>{t(M['forms.delete_body'], { title: removing ? rowTitle(removing) : '' })}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setRemoving(null)}>
              {t(M['forms.cancel'])}
            </Button>
            <Button type="button" variant="destructive" onClick={() => void confirmDelete()}>
              {t(M['forms.delete_confirm'])}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
