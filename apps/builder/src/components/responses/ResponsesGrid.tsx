import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import {
  columnSizingFeature,
  createColumnHelper,
  rowSelectionFeature,
  tableFeatures,
  useTable,
  type CellContext,
  type HeaderContext,
  type OnChangeFn,
  type RowSelectionState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Lock, Star } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import type { GridColumn, GridRow } from '@/persistence/submissionsApi';
import { formatWhen, statusLabel, versionLabel } from '@/components/responses/format';

const M = defineMessages('builder', {
  'responses.grid.label': 'Responses',
  'responses.col.received': 'Received',
  'responses.col.status': 'Status',
  'responses.col.version': 'Version',
  'responses.select_all': 'Select all loaded responses',
  'responses.select_row': 'Select response received {when}',
  'responses.star': 'Star response received {when}',
  'responses.unread': 'Unread',
  'responses.masked': 'Hidden: this answer is protected',
  'responses.loading_more': 'Loading more responses…',
  'responses.more_failed': 'More responses could not be loaded.',
  'responses.retry': 'Try again',
});

const features = tableFeatures({ rowSelectionFeature, columnSizingFeature });
type Features = typeof features;
const helper = createColumnHelper<Features, GridRow>();

/** Height of a row: fixed, so the list can be windowed without measuring what is not on screen. */
const ROW_HEIGHT = 44;
/** Rows kept rendered above and below the visible ones. */
const OVERSCAN = 8;
/** The next page is asked for when the last row on screen is this close to the last row loaded. */
const PREFETCH_ROWS = 10;
const FIELD_PREFIX = 'field:';

interface Actions {
  onOpen: (id: string) => void;
  onToggleStar: (row: GridRow) => void;
  openId: string | null;
}
const ActionsContext = createContext<Actions>({ onOpen: () => undefined, onToggleStar: () => undefined, openId: null });

function ReceivedHeader({ table }: HeaderContext<Features, GridRow, unknown>) {
  const all = table.getIsAllRowsSelected();
  return (
    <div className="flex items-center gap-2 px-3">
      <input
        type="checkbox"
        className="size-4 shrink-0"
        aria-label={t(M['responses.select_all'])}
        checked={all}
        ref={(el) => {
          if (el) el.indeterminate = !all && table.getIsSomeRowsSelected();
        }}
        onChange={table.getToggleAllRowsSelectedHandler()}
      />
      <span className="ml-6">{t(M['responses.col.received'])}</span>
    </div>
  );
}

function ReceivedCell({ row }: CellContext<Features, GridRow, unknown>) {
  const { onOpen, onToggleStar, openId } = useContext(ActionsContext);
  const data = row.original;
  const when = formatWhen(data.receivedAt);
  return (
    <div className="flex h-full items-center gap-2 px-3">
      <input
        type="checkbox"
        className="size-4 shrink-0"
        aria-label={t(M['responses.select_row'], { when })}
        checked={row.getIsSelected()}
        onChange={row.getToggleSelectedHandler()}
      />
      <button
        type="button"
        aria-pressed={data.starred}
        aria-label={t(M['responses.star'], { when })}
        onClick={() => onToggleStar(data)}
        className="shrink-0 rounded-[4px] p-0.5 text-text-subtle hover:text-foreground"
      >
        <Star aria-hidden className={cn('size-4', data.starred && 'fill-current text-warning')} />
      </button>
      <button
        type="button"
        aria-current={openId === data.id ? 'true' : undefined}
        onClick={() => onOpen(data.id)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-[4px] text-left hover:underline"
      >
        {data.read ? null : <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />}
        <span className={cn('truncate text-[14px]', !data.read && 'font-semibold')}>{when}</span>
        {data.read ? null : <span className="sr-only">{t(M['responses.unread'])}</span>}
      </button>
    </div>
  );
}

function StatusCell({ row }: CellContext<Features, GridRow, unknown>) {
  return <span className="truncate px-3 text-[13px] text-muted-foreground">{statusLabel(row.original.status)}</span>;
}

function VersionCell({ row }: CellContext<Features, GridRow, unknown>) {
  return <span className="truncate px-3 text-[13px] text-muted-foreground">{versionLabel(row.original.versionNumber)}</span>;
}

/** One answer as text, cut to the cell; the whole text is on hover and in the detail pane. A protected one shows its mask and a lock. */
function AnswerCell({ row, column, getValue }: CellContext<Features, GridRow, string>) {
  const text = getValue();
  const masked = row.original.masked.includes(column.id.slice(FIELD_PREFIX.length));
  return (
    <span className={cn('flex items-center gap-1 px-3 text-[14px]', masked && 'text-muted-foreground')} title={masked ? t(M['responses.masked']) : text}>
      {masked ? <Lock aria-label={t(M['responses.masked'])} role="img" className="size-3 shrink-0" /> : null}
      <span className="truncate">{text}</span>
    </span>
  );
}

/** The columns of the grid: the fixed ones, then one per field of the API's union over every version of the form. */
function columnsFor(fields: readonly GridColumn[]) {
  return helper.columns([
    helper.display({ id: 'received', header: ReceivedHeader, cell: ReceivedCell, size: 300 }),
    helper.display({ id: 'status', header: () => t(M['responses.col.status']), cell: StatusCell, size: 150 }),
    helper.display({ id: 'version', header: () => t(M['responses.col.version']), cell: VersionCell, size: 110 }),
    ...fields.map((field) =>
      helper.accessor((row) => row.cells[field.id] ?? '', {
        id: `${FIELD_PREFIX}${field.id}`,
        header: field.label || field.key,
        cell: AnswerCell,
        size: 220,
      }),
    ),
  ]);
}

export interface ResponsesGridProps {
  columns: readonly GridColumn[];
  rows: readonly GridRow[];
  hasMore: boolean;
  loadingMore: boolean;
  moreFailed: boolean;
  onLoadMore: () => void;
  onRetryMore: () => void;
  selection: RowSelectionState;
  onSelectionChange: OnChangeFn<RowSelectionState>;
  openId: string | null;
  onOpen: (id: string) => void;
  onToggleStar: (row: GridRow) => void;
}

/**
 * The responses of a form as a table that scrolls both ways and draws only the rows on screen (TanStack Table for the
 * rows, selection and column sizes; TanStack Virtual for the window). The first column stays in view while the answer
 * columns scroll, and the header stays at the top. Selection is keyed by response id, so it stays through the pages
 * that load while the member scrolls. The next page is asked for when the last row on screen is near the end of what
 * is loaded.
 */
export function ResponsesGrid(props: ResponsesGridProps) {
  const { rows: data, hasMore, loadingMore, moreFailed, onLoadMore, onRetryMore, selection, onSelectionChange } = props;
  const columns = useMemo(() => columnsFor(props.columns), [props.columns]);
  const actions = useMemo<Actions>(
    () => ({ onOpen: props.onOpen, onToggleStar: props.onToggleStar, openId: props.openId }),
    [props.onOpen, props.onToggleStar, props.openId],
  );
  // The table takes a mutable array type; the rows are never changed in place.
  const table = useTable({
    features,
    columns,
    data: data as GridRow[],
    getRowId: (row) => row.id,
    state: { rowSelection: selection },
    onRowSelectionChange: onSelectionChange,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: OVERSCAN,
  });
  const visible = virtualizer.getVirtualItems();
  const lastVisible = visible.at(-1)?.index ?? -1;

  // Near the end of what is loaded (or nothing loaded yet, as when a search page held no hit): ask for the next page.
  useEffect(() => {
    if (hasMore && !loadingMore && !moreFailed && lastVisible >= rows.length - 1 - PREFETCH_ROWS) onLoadMore();
  }, [hasMore, loadingMore, moreFailed, lastVisible, rows.length, onLoadMore]);

  const width = table.getTotalSize();
  const headers = table.getHeaderGroups();

  return (
    <ActionsContext.Provider value={actions}>
      <div
        ref={scrollRef}
        role="table"
        aria-label={t(M['responses.grid.label'])}
        aria-rowcount={hasMore ? -1 : rows.length + 1}
        aria-colcount={columns.length}
        className="relative h-full overflow-auto rounded-[12px] border border-border bg-background"
      >
        <div style={{ width, minWidth: '100%' }}>
          <div role="rowgroup" className="sticky top-0 z-20">
            {headers.map((group) => (
              <div key={group.id} role="row" aria-rowindex={1} className="flex border-b border-border bg-surface-subtle" style={{ width }}>
                {group.headers.map((header) => (
                  <div
                    key={header.id}
                    role="columnheader"
                    className={cn(
                      'flex h-10 shrink-0 items-center truncate text-[12px] font-medium uppercase tracking-wide text-muted-foreground',
                      header.column.id === 'received' ? 'sticky left-0 z-10 border-r border-border bg-surface-subtle' : 'px-3',
                    )}
                    style={{ width: header.getSize() }}
                  >
                    {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div role="rowgroup" className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {visible.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              const selected = row.getIsSelected();
              const unread = !row.original.read;
              return (
                <div
                  key={row.id}
                  role="row"
                  aria-rowindex={item.index + 2}
                  aria-selected={selected}
                  data-unread={unread || undefined}
                  className={cn('group absolute left-0 top-0 flex border-b border-border', selected ? 'bg-surface-primary-subtle' : unread ? 'bg-background' : 'bg-surface-subtle')}
                  style={{ width, height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
                >
                  {row.getAllCells().map((cell) => (
                    <div
                      key={cell.id}
                      role="cell"
                      className={cn(
                        'flex shrink-0 items-center overflow-hidden',
                        cell.column.id === 'received' && cn('sticky left-0 z-10 border-r border-border', selected ? 'bg-surface-primary-subtle' : unread ? 'bg-background' : 'bg-surface-subtle'),
                      )}
                      style={{ width: cell.column.getSize() }}
                    >
                      <table.FlexRender cell={cell} />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          {loadingMore || moreFailed ? (
            <div role="status" className="sticky left-0 flex w-full max-w-[480px] items-center gap-3 px-4 py-3 text-[13px] text-muted-foreground">
              {moreFailed ? (
                <>
                  <span>{t(M['responses.more_failed'])}</span>
                  <button type="button" className="text-primary underline" onClick={onRetryMore}>
                    {t(M['responses.retry'])}
                  </button>
                </>
              ) : (
                <span>{t(M['responses.loading_more'])}</span>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </ActionsContext.Provider>
  );
}
