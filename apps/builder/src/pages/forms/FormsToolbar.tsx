import { Star } from 'lucide-react';
import { Button, SearchInput } from '@dmacq/ui';
import { defineMessages, type MessageId } from '@form/i18n';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import { FORM_SORTS, MAX_SEARCH, type FormSort } from '@/persistence/formsListApi';

const M = defineMessages('builder', {
  'forms.search': 'Search forms',
  'forms.search_placeholder': 'Search by title',
  'forms.sort': 'Sort by',
  'forms.sort_updated': 'Last updated',
  'forms.sort_created': 'Date created',
  'forms.sort_title': 'Title, A to Z',
  'forms.starred_only': 'Starred only',
});

const SORT_LABELS: Record<FormSort, MessageId> = {
  updated: M['forms.sort_updated'],
  created: M['forms.sort_created'],
  title: M['forms.sort_title'],
};

const CONTROL = 'h-8 rounded-[8px] border border-border-control bg-background px-2 text-[13px] text-foreground disabled:opacity-50';

export interface FormsToolbarProps {
  search: string;
  onSearch: (search: string) => void;
  sort: FormSort;
  onSort: (sort: FormSort) => void;
  favourite: boolean;
  onFavourite: (favourite: boolean) => void;
  /** Sorting and the starred filter are the server's: they are off while the list is the browser's own copy. */
  serverControls: boolean;
}

/** The search box, the sort menu and the starred-only filter of the forms list (BL-267). */
export function FormsToolbar({ search, onSearch, sort, onSort, favourite, onFavourite, serverControls }: FormsToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="search">
      <SearchInput
        aria-label={t(M['forms.search'])}
        placeholder={t(M['forms.search_placeholder'])}
        value={search}
        maxLength={MAX_SEARCH}
        onValueChange={onSearch}
        className="w-[240px]"
      />
      <select
        aria-label={t(M['forms.sort'])}
        className={CONTROL}
        value={sort}
        disabled={!serverControls}
        onChange={(event) => onSort(event.target.value as FormSort)}
      >
        {FORM_SORTS.map((name) => (
          <option key={name} value={name}>
            {t(SORT_LABELS[name])}
          </option>
        ))}
      </select>
      <Button type="button" variant="outline" size="sm" pressed={favourite} disabled={!serverControls} onClick={() => onFavourite(!favourite)}>
        <Star className={cn(favourite && 'fill-current')} />
        {t(M['forms.starred_only'])}
      </Button>
    </div>
  );
}
