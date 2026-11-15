import { Button } from '@dmacq/ui';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { FORMS_PANEL_ID, formsTabId } from '@/pages/forms/panelIds';
import { FormListItem } from '@/pages/forms/FormListItem';
import type { FormActions } from '@/pages/forms/useFormActions';
import type { FormsList, ListRow } from '@/pages/forms/useFormsList';

const M = defineMessages('builder', {
  'forms.empty': 'No forms yet. Start a new one.',
  'forms.empty_search': 'No forms match “{q}”.',
  'forms.empty_starred': 'No starred forms yet. Star a form to find it here quickly.',
  'forms.empty_archived': 'No archived forms. Archive a form to take it off your list without deleting it.',
  'forms.empty_trash': 'The trash is empty. Forms in the trash can be restored, and nothing is deleted for good.',
  'forms.trash_note': 'Forms in the trash can be restored. Nothing is deleted for good yet.',
  'forms.offline': 'The server cannot be reached, so this is the list saved in this browser. Stars, sorting, Archived, Trash and copies need the server.',
  'forms.offline_folder': 'Archived forms and the trash are kept on the server, which cannot be reached right now.',
  'forms.loading': 'Loading forms…',
  'forms.retry': 'Try again',
  'forms.showing': 'Showing {n, plural, one {# form} other {# forms}}',
  'forms.showing_first': 'Showing the first {n, plural, one {# form} other {# forms}}',
  'forms.load_more': 'Load more',
});

export interface FormsListPanelProps {
  list: FormsList;
  actions: FormActions;
  selected: ReadonlySet<string>;
  onToggleSelected: (id: string) => void;
  onConfirmDelete: (row: ListRow) => void;
}

/** The body of the forms list: the rows of the chosen folder, or why there are none, and "Load more" while the server has another page. */
export function FormsListPanel({ list, actions, selected, onToggleSelected, onConfirmDelete }: FormsListPanelProps) {
  const { state, lifecycle, favourite, appliedSearch } = list;

  const emptyText = (): string => {
    if (state.status === 'ready' && state.source === 'local' && lifecycle !== 'active') return t(M['forms.offline_folder']);
    if (lifecycle === 'trashed') return t(M['forms.empty_trash']);
    if (appliedSearch) return t(M['forms.empty_search'], { q: appliedSearch });
    if (favourite) return t(M['forms.empty_starred']);
    if (lifecycle === 'archived') return t(M['forms.empty_archived']);
    return t(M['forms.empty']);
  };

  return (
    <div id={FORMS_PANEL_ID} role="tabpanel" aria-labelledby={formsTabId(lifecycle)} aria-busy={state.status === 'loading'} className="mt-4">
      {state.status === 'loading' ? <p className="mt-6 text-[14px] text-muted-foreground">{t(M['forms.loading'])}</p> : null}
      {state.status === 'error' ? (
        <div className="mt-6 flex items-center gap-3">
          <p role="alert" className="text-[14px] text-destructive">
            {state.message}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={list.reload}>
            {t(M['forms.retry'])}
          </Button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <>
          {state.source === 'local' ? <p className="mb-3 text-[13px] text-muted-foreground">{t(M['forms.offline'])}</p> : null}
          {lifecycle === 'trashed' && state.source === 'server' && state.items.length > 0 ? (
            <p className="mb-3 text-[13px] text-muted-foreground">{t(M['forms.trash_note'])}</p>
          ) : null}
          {state.items.length === 0 ? (
            <p className="mt-6 text-[15px] text-muted-foreground">{emptyText()}</p>
          ) : (
            <>
              <p className="text-[13px] text-muted-foreground">{t(M[state.nextCursor ? 'forms.showing_first' : 'forms.showing'], { n: state.items.length })}</p>
              <ul className="mt-2 divide-y divide-border">
                {state.items.map((row) => (
                  <FormListItem
                    key={row.id}
                    row={row}
                    source={state.source}
                    actions={actions}
                    selected={selected.has(row.id)}
                    onToggleSelected={onToggleSelected}
                    onConfirmDelete={onConfirmDelete}
                  />
                ))}
              </ul>
              {list.more.error ? (
                <p role="alert" className="mt-3 text-[14px] text-destructive">
                  {list.more.error}
                </p>
              ) : null}
              {state.nextCursor ? (
                <div className="mt-4 flex justify-center">
                  <Button type="button" variant="outline" disabled={list.more.busy} onClick={() => void list.loadMore()}>
                    {t(M['forms.load_more'])}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
