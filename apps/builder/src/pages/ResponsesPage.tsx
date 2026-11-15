import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Inbox } from 'lucide-react';
import type { OnChangeFn, RowSelectionState } from '@tanstack/react-table';
import { Button } from '@dmacq/ui';
import { defineMessages, type MessageId } from '@form/i18n';
import { t } from '@/i18n';
import { builderPath } from '@/pages/useBuilderMode';
import { useRepository } from '@/persistence/repository';
import { MAX_BULK, bulkSubmissions, patchSubmission, type BulkAction, type BulkResult, type GridRow, type View } from '@/persistence/submissionsApi';
import { BulkBar } from '@/components/responses/BulkBar';
import { DetailPane } from '@/components/responses/DetailPane';
import { ResponsesGrid } from '@/components/responses/ResponsesGrid';
import { PANEL_ID, tabId } from '@/components/responses/panelIds';
import { ResponsesToolbar } from '@/components/responses/ResponsesToolbar';
import { describeFailure } from '@/components/responses/errors';
import { NO_FILTERS, toGridQuery, useDebounced, hasFilters, type ResponseFilters } from '@/components/responses/filters';
import { useResponsesGrid } from '@/components/responses/useResponsesGrid';

const M = defineMessages('builder', {
  'responses.title': 'Responses',
  'responses.back': 'Back to forms',
  'responses.open_form': 'Open form',
  'responses.untitled': 'Untitled form',
  'responses.loading': 'Loading responses…',
  'responses.load_failed': 'Responses could not be loaded.',
  'responses.reload': 'Try again',
  'responses.empty_inbox': 'No responses yet. They appear here when someone submits the published form.',
  'responses.empty_archived': 'Nothing is archived.',
  'responses.empty_trash': 'The trash is empty. Responses you move here can be restored or deleted forever.',
  'responses.empty_filtered': 'No responses match these filters.',
  'responses.select_limit': 'You can select up to {n} responses at a time.',
  'responses.bulk_failed': 'That could not be done. Nothing was changed.',
  'responses.star_failed': 'The star could not be saved.',
  'responses.done.mark_read': '{n, plural, one {# response marked as read.} other {# responses marked as read.}}',
  'responses.done.mark_unread': '{n, plural, one {# response marked as unread.} other {# responses marked as unread.}}',
  'responses.done.star': '{n, plural, one {# response starred.} other {# responses starred.}}',
  'responses.done.unstar': '{n, plural, one {# response unstarred.} other {# responses unstarred.}}',
  'responses.done.archive': '{n, plural, one {# response archived.} other {# responses archived.}}',
  'responses.done.unarchive': '{n, plural, one {# response moved to the inbox.} other {# responses moved to the inbox.}}',
  'responses.done.trash': '{n, plural, one {# response moved to the trash.} other {# responses moved to the trash.}}',
  'responses.done.restore': '{n, plural, one {# response restored.} other {# responses restored.}}',
  'responses.done.delete': '{n, plural, one {# response deleted forever.} other {# responses deleted forever.}}',
  'responses.done.missing': '{n, plural, one {# response was already gone.} other {# responses were already gone.}}',
});

/** What the member is told after a bulk action. */
const DONE: Record<BulkAction, MessageId> = {
  mark_read: M['responses.done.mark_read'],
  mark_unread: M['responses.done.mark_unread'],
  star: M['responses.done.star'],
  unstar: M['responses.done.unstar'],
  archive: M['responses.done.archive'],
  unarchive: M['responses.done.unarchive'],
  trash: M['responses.done.trash'],
  restore: M['responses.done.restore'],
  delete: M['responses.done.delete'],
};

/** The actions that take a response out of the folder it is listed in; the others change a flag and leave it there. */
const LEAVES: Record<View, ReadonlySet<BulkAction>> = {
  inbox: new Set<BulkAction>(['archive', 'trash']),
  archived: new Set<BulkAction>(['unarchive', 'trash']),
  trash: new Set<BulkAction>(['restore', 'delete']),
};

const FLAGS: Partial<Record<BulkAction, { read?: boolean; starred?: boolean }>> = {
  mark_read: { read: true },
  mark_unread: { read: false },
  star: { starred: true },
  unstar: { starred: false },
};

const EMPTY: Record<View, MessageId> = {
  inbox: M['responses.empty_inbox'],
  archived: M['responses.empty_archived'],
  trash: M['responses.empty_trash'],
};

/** How long the search box waits after the last key before it asks the API. */
const SEARCH_PAUSE_MS = 300;

type Notice = { kind: 'done' | 'error'; text: string };

/**
 * The responses of a published form (WP-1.15): a grid of every response with the columns of every version of the form,
 * the folders (Inbox, Archived, Trash), search and filters, bulk actions, and an inbox-style reader. Everything comes
 * from the API for the signed-in member's org; the preview's rehearsal responses stay in the browser and are not shown
 * here. A change the API accepted is applied to the rows already loaded, so it costs no new read of the page (each is audited).
 */
export function ResponsesPage() {
  const { id = '' } = useParams();
  const forms = useRepository();
  const [title, setTitle] = useState<string | null>(null);
  const [view, setView] = useState<View>('inbox');
  const [filters, setFilters] = useState<ResponseFilters>(NO_FILTERS);
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  // The title is the form's own, from this browser's copy of the drafts (the grid needs nothing from it).
  useEffect(() => {
    let live = true;
    const untitled = () => t(M['responses.untitled']);
    forms.load(id).then(
      (form) => {
        if (!live) return;
        const doc = form?.doc as { title?: unknown } | undefined;
        setTitle(typeof doc?.title === 'string' && doc.title.trim() ? doc.title.trim() : untitled());
      },
      () => live && setTitle(untitled()),
    );
    return () => {
      live = false;
    };
  }, [forms, id]);

  const settledQuery = useDebounced(filters.q, SEARCH_PAUSE_MS);
  const query = useMemo(() => toGridQuery(view, { ...filters, q: settledQuery }), [view, filters, settledQuery]);
  const queryKey = JSON.stringify(query);
  const grid = useResponsesGrid(id, query);
  const { state, patchRows, dropRows } = grid;

  // A different folder, filter or search is a different list: nothing selected or open in the old one carries over.
  const [listedFor, setListedFor] = useState(queryKey);
  if (listedFor !== queryKey) {
    setListedFor(queryKey);
    setSelection({});
    setOpenId(null);
    setNotice(null);
  }

  const changeSelection = useCallback<OnChangeFn<RowSelectionState>>(
    (updater) => {
      const next = typeof updater === 'function' ? updater(selection) : updater;
      const ids = Object.keys(next);
      if (ids.length > MAX_BULK) {
        // One bulk call names at most MAX_BULK responses, and it is atomic: the selection stops there instead of splitting into calls.
        setSelection(Object.fromEntries(ids.slice(0, MAX_BULK).map((rowId) => [rowId, true as const])));
        setNotice({ kind: 'error', text: t(M['responses.select_limit'], { n: MAX_BULK }) });
        return;
      }
      setSelection(next);
    },
    [selection],
  );

  const selectedIds = Object.keys(selection);

  async function act(action: BulkAction) {
    if (selectedIds.length === 0 || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result: BulkResult = await bulkSubmissions(id, action, selectedIds);
      const ids = new Set(selectedIds);
      const flags = FLAGS[action];
      if (LEAVES[view].has(action)) dropRows(ids);
      else if (flags) patchRows(ids, flags);
      setSelection({});
      const done = t(DONE[action], { n: result.requested - result.missing });
      setNotice({ kind: 'done', text: result.missing > 0 ? `${done} ${t(M['responses.done.missing'], { n: result.missing })}` : done });
    } catch (failure) {
      setNotice({ kind: 'error', text: describeFailure(failure, M['responses.bulk_failed']) });
    } finally {
      setBusy(false);
    }
  }

  const toggleStar = useCallback(
    async (row: GridRow) => {
      try {
        const flags = await patchSubmission(id, row.id, { starred: !row.starred });
        patchRows(new Set([row.id]), { starred: flags.starred, read: flags.read });
      } catch (failure) {
        setNotice({ kind: 'error', text: describeFailure(failure, M['responses.star_failed']) });
      }
    },
    [id, patchRows],
  );

  const rows = state.rows;
  const openIndex = openId === null ? -1 : rows.findIndex((row) => row.id === openId);
  const openRow = openIndex >= 0 ? rows[openIndex] : undefined;
  const open = useCallback((rowId: string) => setOpenId(rowId), []);
  const flagsChanged = useCallback((rowId: string, change: { read?: boolean; starred?: boolean }) => patchRows(new Set([rowId]), change), [patchRows]);
  const hasMore = state.nextCursor !== null;

  let body;
  if (state.phase === 'loading') {
    body = (
      <p role="status" className="py-10 text-center text-[14px] text-muted-foreground">
        {t(M['responses.loading'])}
      </p>
    );
  } else if (state.phase === 'failed') {
    body = (
      <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-[14px] text-destructive">{describeFailure(state.failure, M['responses.load_failed'])}</p>
        <Button type="button" variant="outline" size="sm" onClick={grid.reload}>
          {t(M['responses.reload'])}
        </Button>
      </div>
    );
  } else if (rows.length === 0 && !hasMore && !state.loadingMore) {
    body = (
      <div className="mx-auto mt-10 flex max-w-[400px] flex-col items-center rounded-[12px] border border-dashed border-border bg-surface-subtle px-6 py-12 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border">
          <Inbox className="size-5" />
        </span>
        <p className="mt-4 text-[15px] leading-6 text-muted-foreground">{t(hasFilters(filters) ? M['responses.empty_filtered'] : EMPTY[view])}</p>
      </div>
    );
  } else {
    body = (
      <ResponsesGrid
        columns={state.columns}
        rows={rows}
        hasMore={hasMore}
        loadingMore={state.loadingMore}
        moreFailed={state.moreFailed}
        onLoadMore={grid.loadMore}
        onRetryMore={grid.retryMore}
        selection={selection}
        onSelectionChange={changeSelection}
        openId={openId}
        onOpen={open}
        onToggleStar={(row) => void toggleStar(row)}
      />
    );
  }

  return (
    <main className="mx-auto flex h-svh w-full max-w-[1600px] flex-col gap-4 px-6 pb-6 pt-8 text-foreground">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-3">
          <Link to="/forms">
            <ArrowLeft />
            {t(M['responses.back'])}
          </Link>
        </Button>
        <p className="text-[13px] font-medium uppercase tracking-[0.04em] text-muted-foreground">{t(M['responses.title'])}</p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-[28px] font-bold leading-[1.15] tracking-[-0.02em]">{title ?? t(M['responses.title'])}</h1>
          {id ? (
            <Button variant="outline" size="sm" asChild>
              <Link to={builderPath(id)}>{t(M['responses.open_form'])}</Link>
            </Button>
          ) : null}
        </div>
      </div>

      <ResponsesToolbar formId={id} view={view} onView={setView} filters={filters} onFilters={setFilters} selectedIds={selectedIds} />

      {selectedIds.length > 0 ? <BulkBar view={view} count={selectedIds.length} busy={busy} onAct={(action) => void act(action)} onClear={() => setSelection({})} /> : null}
      <div role="status" aria-live="polite" className={notice?.kind === 'error' ? 'text-[13px] text-destructive' : 'text-[13px] text-muted-foreground'}>
        {notice?.text}
      </div>

      <div id={PANEL_ID} role="tabpanel" aria-labelledby={tabId(view)} className="flex min-h-0 flex-1 gap-4">
        <div className="min-w-0 flex-1">{body}</div>
        {openRow ? (
          <div className="fixed inset-0 z-40 flex flex-col bg-background lg:static lg:z-auto lg:w-[420px] lg:shrink-0">
            <DetailPane
              formId={id}
              id={openRow.id}
              hasPrevious={openIndex > 0}
              hasNext={openIndex < rows.length - 1}
              onPrevious={() => setOpenId(rows[openIndex - 1]?.id ?? null)}
              onNext={() => setOpenId(rows[openIndex + 1]?.id ?? null)}
              onClose={() => setOpenId(null)}
              onFlags={flagsChanged}
            />
          </div>
        ) : null}
      </div>
    </main>
  );
}
