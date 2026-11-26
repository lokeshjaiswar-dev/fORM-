import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Combine, Copy, FileText, Globe, Inbox, Plus, Search, Trash2, Upload } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import type { FormDefinition, IsoInstant, MergeConflict, MergeResolution } from '@form/schema';
import { BUILDER_LOCALE, t } from '@/i18n';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@dmacq/ui';
import { EmptyState, PageHeader, StatCard } from '@dmacq/ui/patterns';
import { WorkspaceShell } from '@/components/workspace/WorkspaceShell';
import { SortableHead, TablePagination, useTableView } from '@/components/workspace/tableView';
import { preloadGallery } from '@/components/templates/gallery';
import { CreateFormDialog, type CreateStep } from '@/components/forms/CreateFormDialog';
import { mergeFromRepository } from '@/lib/mergeSelected';
import { uid } from '@/lib/utils';
import { DOCUMENT_FORMAT, type FormSummary, type StoredForm } from '@/persistence/DocumentRepository';
import { whenSaved } from '@/persistence/autosave';
import { ApiUnreachable } from '@/auth/client';
import { mergeRemoteForms } from '@/persistence/draftsApi';
import { newStoredForm, openStored } from '@/persistence/openForm';
import { parseFormJson } from '@/lib/formJson';
import { deleteSubmissionFiles, fileIdsFromAnswers } from '@/persistence/blobStore';
import { useOptionalSubmissions } from '@/persistence/SubmissionsContext';
import { useRepository } from '@/persistence/repository';
import { builderPath } from '@/pages/useBuilderMode';
import { navigateWithTransition } from '@/lib/viewTransition';
import { rememberedSlug } from '@/persistence/publishApi';

const M = defineMessages('builder', {
  'forms.title': 'Forms',
  'forms.new': 'New form',
  'forms.empty': 'No forms yet. Start a new one.',
  'forms.untitled': 'Untitled form',
  'forms.responses': 'Responses',
  'forms.responses_n': '{n, plural, one {# response} other {# responses}}',
  'forms.blocks': '{n, plural, one {# block} other {# blocks}}',
  'forms.unreadable': 'Saved forms could not be read.',
  'forms.not_saved': 'The form could not be saved in this browser.',
  'forms.merge': 'Merge selected',
  'forms.merge_need_two': 'Select at least two forms to merge.',
  'forms.merge_failed': 'Those forms could not be merged.',
  'forms.merge_unreachable': 'The server cannot be reached, so these forms could not be merged. Check that the backend is running and try again.',
  'forms.merge_conflict_title': 'These fields cannot be combined',
  'forms.merge_conflict_help':
    'The same question appears in more than one form, but the extra rules do not fit together. Pick which version to keep.',
  'forms.merge_use': 'Use this version',
  'forms.merge_continue': 'Merge with these choices',
  'forms.duplicate': 'Duplicate',
  'forms.duplicate_title': 'Copy of {title}',
  'forms.duplicate_failed': 'That form could not be duplicated.',
});

const dateTime = new Intl.DateTimeFormat(BUILDER_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });

function savedWhen(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : dateTime.format(at);
}

/** The forms saved in this browser: open one, or start a new one (blank or from a template). */
export function FormsPage() {
  const repo = useRepository();
  const submissions = useOptionalSubmissions();
  const navigate = useNavigate();
  const [forms, setForms] = useState<FormSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* Which step of the Create a form overlay is open: the choice (New form) or the templates (Browse templates). */
  const [creating, setCreating] = useState<CreateStep | null>(null);
  /** A new form is being saved and opened: a second click on a start option does nothing. */
  const startingRef = useRef(false);
  const [removing, setRemoving] = useState<FormSummary | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [conflicts, setConflicts] = useState<MergeConflict[] | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [merging, setMerging] = useState(false);
  const [query, setQuery] = useState('');
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(preloadGallery, []);

  useEffect(() => {
    let live = true;
    whenSaved()
      .then(() => repo.list())
      .then(async (list) => {
        // A blank form nobody added a field to is not kept: drop those untitled, empty drafts.
        const empty = list.filter((form) => form.blocks === 0 && !form.title.trim());
        if (empty.length === 0) return list;
        await Promise.all(empty.map((form) => repo.remove(form.id).catch(() => undefined)));
        const gone = new Set(empty.map((form) => form.id));
        return list.filter((form) => !gone.has(form.id));
      })
      .then(
        (list) => live && setForms(list),
        () => live && setError(t(M['forms.unreadable'])),
      );
    return () => {
      live = false;
    };
  }, [repo]);

  useEffect(() => {
    if (!submissions || !forms) return;
    let live = true;
    Promise.all(forms.map(async (form) => [form.id, (await submissions.listByForm(form.id)).length] as const)).then(
      (pairs) => {
        if (!live) return;
        setCounts(Object.fromEntries(pairs));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [forms, submissions]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = forms ?? [];
    if (!needle) return list;
    return list.filter((form) => (form.title || t(M['forms.untitled'])).toLowerCase().includes(needle));
  }, [forms, query]);

  const view = useTableView<FormSummary, 'name' | 'status' | 'blocks' | 'savedAt' | 'responses'>(
    visible,
    {
      name: (form: FormSummary) => form.title || t(M['forms.untitled']),
      status: (form: FormSummary) => (rememberedSlug(form.id) ? 1 : 0),
      blocks: (form: FormSummary) => form.blocks,
      savedAt: (form: FormSummary) => new Date(form.savedAt).getTime(),
      responses: (form: FormSummary) => counts[form.id] ?? 0,
    },
    { key: 'savedAt', dir: 'desc' },
  );

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

  /** Reads a form JSON file (an export, a bare definition or a v1 export) into a new form, then opens it. */
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    setImporting(true);
    try {
      const text = await file.text();
      const id = uid();
      const now = new Date().toISOString() as IsoInstant;
      const opened = parseFormJson(text, id, now);
      if (!opened.ok) {
        setError(opened.error);
        return;
      }
      await saveThenOpen({ id, format: DOCUMENT_FORMAT, rev: 0, savedAt: now, doc: opened.doc, ops: opened.ops });
    } catch {
      setError('This file could not be read.');
    } finally {
      setImporting(false);
    }
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

  /** Copies a saved form under a new id, titled "Copy of …", and adds it to the list without leaving the dashboard. */
  async function duplicate(form: FormSummary) {
    setError(null);
    setDuplicating(form.id);
    try {
      const stored = await repo.load(form.id);
      if (!stored) throw new Error(t(M['forms.duplicate_failed']));
      const opened = openStored(stored, new Date().toISOString() as IsoInstant);
      if (!opened.ok) throw new Error(t(M['forms.duplicate_failed']));
      const id = uid();
      const now = new Date().toISOString();
      const title = t(M['forms.duplicate_title'], { title: form.title || t(M['forms.untitled']) });
      const copy = newStoredForm(id, now, { ...opened.doc, title });
      await repo.save({ ...copy, ops: stored.ops });
      const copied: FormSummary = { id, title, savedAt: now, blocks: form.blocks };
      setForms((list) => (list ? [copied, ...list] : [copied]));
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t(M['forms.duplicate_failed']));
    } finally {
      setDuplicating(null);
    }
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
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
        if (err instanceof ApiUnreachable) setError(t(M['forms.merge_unreachable']));
        else setError(err instanceof Error && err.message ? err.message : t(M['forms.merge_failed']));
        return;
      }
      if (remote?.ok) {
        setConflicts(null);
        setSelected(new Set());
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
        setSelected(new Set());
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
    if (!removing) return;
    const id = removing.id;
    setRemoving(null);
    try {
      if (submissions) {
        const gone = await submissions.removeByForm(id);
        await deleteSubmissionFiles(gone.flatMap((row) => fileIdsFromAnswers(row.answers)));
      }
      await repo.remove(id);
      setForms((list) => list?.filter((form) => form.id !== id) ?? null);
    } catch {
      setError(t(M['forms.unreadable']));
    }
  }

  const totalResponses = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const publishedCount = forms?.filter((form) => rememberedSlug(form.id)).length ?? 0;
  const selectedCount = selected.size;

  return (
    <WorkspaceShell
      crumb="All forms"
      forms={forms}
      actions={
        <>
          {forms && forms.length >= 2 ? (
            <Button type="button" variant="outline" size="sm" disabled={selectedCount < 2 || merging} onClick={() => void runMerge()}>
              <Combine />
              {t(M['forms.merge'])}
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" disabled={importing} onClick={() => importInput.current?.click()}>
            <Upload />
            {importing ? 'Importing…' : 'Import'}
          </Button>
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Import form file"
            onChange={(event) => void importFile(event)}
          />
          <Button size="sm" onClick={() => setCreating('choose')}>
            <Plus />
            {t(M['forms.new'])}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <PageHeader
          title={t(M['forms.title'])}
          description="Create, share and merge the forms you build. Select two or more forms to merge them into one."
        />

        {error ? (
          <div role="alert" className="ws-enter rounded-[8px] border border-destructive/40 bg-destructive/10 px-4 py-3 text-[14px] text-destructive">
            {error}
          </div>
        ) : null}

        {forms !== null && forms.length > 0 ? (
          <section aria-label="Overview" className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Forms" value={<span className="ws-count inline-block">{forms.length}</span>} hint="Saved in this browser" icon={<FileText className="size-4" />} />
            <StatCard label="Published" value={<span className="ws-count inline-block">{publishedCount}</span>} hint="Forms with a live link" icon={<Globe className="size-4" />} />
            <StatCard label="Responses" value={<span className="ws-count inline-block">{totalResponses}</span>} hint="Submissions received" icon={<Inbox className="size-4" />} />
          </section>
        ) : null}

        <section aria-labelledby="forms-heading" className="ws-enter overflow-hidden rounded-[12px] border border-border bg-background">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 id="forms-heading" className="text-[15px] font-semibold">
                All forms
              </h2>
              {forms ? <Badge variant="secondary">{forms.length}</Badge> : null}
              {selectedCount > 0 ? <Badge variant="outline">{selectedCount} selected</Badge> : null}
            </div>
            {forms && forms.length > 0 ? (
              <div className="relative w-full max-w-[260px]">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  className="pl-8"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search forms"
                  aria-label="Search forms"
                />
              </div>
            ) : null}
          </div>

          {forms === null ? (
            <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading forms">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-10 animate-pulse rounded-[6px] bg-surface-subtle" />
              ))}
            </div>
          ) : forms.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<FileText className="size-8" />}
                title="Your forms will appear here"
                description={t(M['forms.empty'])}
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button size="sm" onClick={() => setCreating('choose')}>
                      <Plus />
                      Create your first form
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setCreating('templates')}>
                      Browse templates
                    </Button>
                  </div>
                }
              />
            </div>
          ) : visible.length === 0 ? (
            <p className="px-4 py-10 text-center text-[14px] text-muted-foreground">No forms match “{query}”.</p>
          ) : (
            <div className="ws-scroll-table overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <span className="sr-only">Select</span>
                  </TableHead>
                  <SortableHead label="Name" sortKey="name" active={view.sortKey} dir={view.sortDir} onSort={view.toggleSort} />
                  <SortableHead className="w-32" label="Status" sortKey="status" active={view.sortKey} dir={view.sortDir} onSort={view.toggleSort} />
                  <SortableHead className="w-28" label="Fields" sortKey="blocks" active={view.sortKey} dir={view.sortDir} onSort={view.toggleSort} />
                  <SortableHead className="w-48" label="Last saved" sortKey="savedAt" active={view.sortKey} dir={view.sortDir} onSort={view.toggleSort} />
                  <SortableHead className="w-40" label="Responses" sortKey="responses" active={view.sortKey} dir={view.sortDir} onSort={view.toggleSort} />
                  <TableHead className="w-44 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.pageItems.map((form, i) => {
                  const responses = counts[form.id] ?? 0;
                  const name = form.title || t(M['forms.untitled']);
                  return (
                    <TableRow
                      key={form.id}
                      data-state={selected.has(form.id) ? 'selected' : undefined}
                      className="ws-row"
                      style={{ ['--ws-delay' as string]: `${Math.min(i, 12) * 30}ms` }}
                    >
                      <TableCell>
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={selected.has(form.id)}
                          aria-label={`Select ${name}`}
                          onChange={() => toggleSelected(form.id)}
                        />
                      </TableCell>
                      <TableCell>
                        <Link to={builderPath(form.id)} className="flex items-center gap-2.5 font-medium hover:text-primary">
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-primary/10 text-primary">
                            <FileText className="size-3.5" />
                          </span>
                          <span className="truncate">{name}</span>
                        </Link>
                      </TableCell>
                      <TableCell>
                        {rememberedSlug(form.id) ? (
                          <Badge variant="success">
                            <span className="size-1.5 rounded-full bg-current" aria-hidden />
                            Published
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Draft</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{t(M['forms.blocks'], { n: form.blocks })}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{savedWhen(form.savedAt)}</TableCell>
                      <TableCell>
                        <Link
                          to={`/forms/${form.id}/responses`}
                          className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-[12px] hover:bg-state-hover"
                        >
                          <Inbox className="size-3" />
                          {responses ? t(M['forms.responses_n'], { n: responses }) : t(M['forms.responses'])}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center justify-end gap-1">
                          <Button variant="outline" size="sm" asChild>
                            <Link to={builderPath(form.id)}>Open</Link>
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`${t(M['forms.duplicate'])} ${name}`}
                            title={t(M['forms.duplicate'])}
                            disabled={duplicating !== null}
                            onClick={() => void duplicate(form)}
                          >
                            <Copy className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Delete"
                            onClick={() => setRemoving(form)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </div>
          )}
          {forms && visible.length > 0 ? (
            <TablePagination
              page={view.page}
              pageCount={view.pageCount}
              total={view.total}
              pageSize={view.pageSize}
              onPage={view.setPage}
              onPageSize={view.setPageSize}
              noun="forms"
            />
          ) : null}
        </section>
      </div>

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
              Cancel
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
            <DialogTitle>Delete this form?</DialogTitle>
            <DialogDescription>
              "{removing?.title || t(M['forms.untitled'])}" will be removed from this browser. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => void confirmDelete()}>
              Delete form
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </WorkspaceShell>
  );
}
