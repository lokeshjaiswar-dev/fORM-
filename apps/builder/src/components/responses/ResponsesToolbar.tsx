import { useRef, type KeyboardEvent } from 'react';
import { Button, SearchInput } from '@dmacq/ui';
import { defineMessages, type MessageId } from '@form/i18n';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import { VIEWS, type View } from '@/persistence/submissionsApi';
import { PANEL_ID, tabId } from '@/components/responses/panelIds';
import { NO_FILTERS, hasFilters, rangeIsBackwards, type ReadFilter, type ResponseFilters, type StatusFilter } from '@/components/responses/filters';
import { statusLabel } from '@/components/responses/format';

const M = defineMessages('builder', {
  'responses.tabs': 'Folders',
  'responses.tab.inbox': 'Inbox',
  'responses.tab.archived': 'Archived',
  'responses.tab.trash': 'Trash',
  'responses.search': 'Search responses',
  'responses.search_placeholder': 'Search answers',
  'responses.filter.from': 'From',
  'responses.filter.to': 'To',
  'responses.filter.read': 'Read state',
  'responses.filter.read_all': 'Read and unread',
  'responses.filter.read_unread': 'Unread only',
  'responses.filter.read_read': 'Read only',
  'responses.filter.status': 'Status',
  'responses.filter.status_all': 'Any status',
  'responses.filter.starred': 'Starred only',
  'responses.filter.clear': 'Clear filters',
  'responses.filter.backwards': 'The start date is after the end date.',
});

const TAB_LABELS: Record<View, MessageId> = {
  inbox: M['responses.tab.inbox'],
  archived: M['responses.tab.archived'],
  trash: M['responses.tab.trash'],
};

const CONTROL = 'h-8 rounded-[8px] border border-border-control bg-background px-2 text-[13px] text-foreground';

export interface ResponsesToolbarProps {
  view: View;
  onView: (view: View) => void;
  filters: ResponseFilters;
  onFilters: (filters: ResponseFilters) => void;
}

/** The folders (Inbox, Archived, Trash) as tabs, the search box, and the filters: dates, read state, starred and status. */
export function ResponsesToolbar({ view, onView, filters, onFilters }: ResponsesToolbarProps) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const set = (change: Partial<ResponseFilters>) => onFilters({ ...filters, ...change });

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const at = VIEWS.indexOf(view);
    const next = event.key === 'ArrowRight' ? (at + 1) % VIEWS.length : event.key === 'ArrowLeft' ? (at + VIEWS.length - 1) % VIEWS.length : event.key === 'Home' ? 0 : event.key === 'End' ? VIEWS.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = VIEWS[next];
    if (target) onView(target);
    tabs.current[next]?.focus();
  }

  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label={t(M['responses.tabs'])} onKeyDown={onKeyDown} className="flex gap-1 border-b border-border">
        {VIEWS.map((name, index) => {
          const selected = name === view;
          return (
            <button
              key={name}
              ref={(el) => {
                tabs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={tabId(name)}
              aria-selected={selected}
              aria-controls={PANEL_ID}
              tabIndex={selected ? 0 : -1}
              onClick={() => onView(name)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-[14px] font-medium',
                selected ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t(TAB_LABELS[name])}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          aria-label={t(M['responses.search'])}
          placeholder={t(M['responses.search_placeholder'])}
          value={filters.q}
          onValueChange={(q) => set({ q })}
          className="w-[260px]"
        />
        <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          {t(M['responses.filter.from'])}
          <input type="date" className={CONTROL} value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          {t(M['responses.filter.to'])}
          <input type="date" className={CONTROL} value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        </label>
        <select aria-label={t(M['responses.filter.read'])} className={CONTROL} value={filters.read} onChange={(e) => set({ read: e.target.value as ReadFilter })}>
          <option value="all">{t(M['responses.filter.read_all'])}</option>
          <option value="unread">{t(M['responses.filter.read_unread'])}</option>
          <option value="read">{t(M['responses.filter.read_read'])}</option>
        </select>
        <select aria-label={t(M['responses.filter.status'])} className={CONTROL} value={filters.status} onChange={(e) => set({ status: e.target.value as StatusFilter })}>
          <option value="all">{t(M['responses.filter.status_all'])}</option>
          <option value="complete">{statusLabel('complete')}</option>
          <option value="spam">{statusLabel('spam')}</option>
        </select>
        <label className="flex items-center gap-1.5 text-[13px]">
          <input type="checkbox" className="size-4" checked={filters.starred} onChange={(e) => set({ starred: e.target.checked })} />
          {t(M['responses.filter.starred'])}
        </label>
        {hasFilters(filters) ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onFilters(NO_FILTERS)}>
            {t(M['responses.filter.clear'])}
          </Button>
        ) : null}
      </div>
      {rangeIsBackwards(filters) ? (
        <p role="alert" className="text-[13px] text-destructive">
          {t(M['responses.filter.backwards'])}
        </p>
      ) : null}
    </div>
  );
}
