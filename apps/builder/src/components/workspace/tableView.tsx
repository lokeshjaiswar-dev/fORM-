import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, TableHead } from '@dmacq/ui';

export type SortDir = 'asc' | 'desc';

/**
 * Client-side sorting and paging for a table. `accessors` maps a sort key to the value used for comparison; a key
 * that is not in the map cannot be sorted. Pages are 1-based.
 */
export function useTableView<T, K extends string>(
  items: readonly T[],
  accessors: Record<K, (item: T) => string | number>,
  initial: { key: K; dir: SortDir },
  initialPageSize = 10,
) {
  const [sortKey, setSortKey] = useState<K>(initial.key);
  const [sortDir, setSortDir] = useState<SortDir>(initial.dir);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(initialPageSize);

  function setPageSize(size: number) {
    setPageSizeState(size);
    setPage(1);
  }

  const sorted = useMemo(() => {
    const get = accessors[sortKey];
    const copy = [...items];
    if (!get) return copy;
    copy.sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [items, accessors, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pageCount);
  const pageItems = sorted.slice((current - 1) * pageSize, current * pageSize);

  function toggleSort(key: K) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
    setPage(1);
  }

  return { pageItems, total: sorted.length, page: current, pageCount, setPage, setPageSize, sortKey, sortDir, toggleSort, pageSize };
}

/** A column heading that sorts the table when clicked. Shows the current direction. */
export function SortableHead<K extends string>({
  label,
  sortKey,
  active,
  dir,
  onSort,
  className,
}: {
  label: ReactNode;
  sortKey: K;
  active: K;
  dir: SortDir;
  onSort: (key: K) => void;
  className?: string;
}) {
  const isActive = sortKey === active;
  const Icon = !isActive ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className} aria-sort={isActive ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1.5 rounded-[4px] py-0.5 hover:text-foreground"
      >
        {label}
        <Icon className={`size-3.5 ${isActive ? 'text-primary' : 'opacity-40'}`} aria-hidden />
      </button>
    </TableHead>
  );
}

/** Footer under a table: the range shown, and previous/next page controls. */
export const PAGE_SIZES = [10, 25, 50] as const;

export function TablePagination({
  page,
  pageCount,
  total,
  pageSize,
  onPage,
  onPageSize,
  noun,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
  noun: string;
}) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-[13px] text-muted-foreground">
      <div className="flex items-center gap-3">
        <span>
          Showing {from}–{to} of {total} {noun}
        </span>
        <div className="flex items-center gap-2">
          <span id="rows-per-page-label">Rows per page</span>
          <Select value={String(pageSize)} onValueChange={(value) => onPageSize(Number(value))}>
            <SelectTrigger size="sm" className="w-[72px]" aria-labelledby="rows-per-page-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="tabular-nums">
          Page {page} of {pageCount}
        </span>
        <Button type="button" variant="outline" size="icon-sm" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Next page"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
