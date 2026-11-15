import { Link } from 'react-router-dom';
import { Archive, ArchiveRestore, Copy, Ellipsis, FileText, Inbox, RotateCcw, Star, Trash2 } from 'lucide-react';
import { Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@dmacq/ui';
import { defineMessages } from '@form/i18n';
import { BUILDER_LOCALE, t } from '@/i18n';
import { cn } from '@/lib/utils';
import { builderPath } from '@/pages/useBuilderMode';
import { rowTitle } from '@/pages/forms/rowTitle';
import type { FormActions } from '@/pages/forms/useFormActions';
import type { ListRow, ListSource } from '@/pages/forms/useFormsList';

const M = defineMessages('builder', {
  'forms.responses': 'Responses',
  'forms.responses_n': '{n, plural, one {# response} other {# responses}}',
  'forms.select': 'Select {title}',
  'forms.star': 'Star {title}',
  'forms.updated': 'Updated {when}',
  'forms.saved': 'Saved {when}',
  'forms.trashed_since': 'In the trash since {when}',
  'forms.live': 'Live',
  'forms.unsynced': 'Not saved to the server yet',
  'forms.actions': 'Actions for {title}',
  'forms.clone': 'Make a copy',
  'forms.archive': 'Archive',
  'forms.unarchive': 'Move back to Active',
  'forms.trash': 'Move to trash',
  'forms.delete': 'Delete form',
  'forms.restore': 'Restore',
  'forms.restore_label': 'Restore {title}',
});

const dateTime = new Intl.DateTimeFormat(BUILDER_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });

function when(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : dateTime.format(at);
}

export interface FormListItemProps {
  row: ListRow;
  /** Where the list comes from: the server's pages, or only this browser's copy (offline). */
  source: ListSource;
  actions: FormActions;
  selected: boolean;
  onToggleSelected: (id: string) => void;
  /** Asks to delete a form that exists only in this browser: that cannot be undone, so the page confirms first. */
  onConfirmDelete: (row: ListRow) => void;
}

/** One form in the list: select for merging, star, open, responses, and the actions of its folder. */
export function FormListItem({ row, source, actions, selected, onToggleSelected, onConfirmDelete }: FormListItemProps) {
  const title = rowTitle(row);
  const inTrash = row.lifecycle === 'trashed';
  const busy = actions.busy.has(row.id);
  // The server's verbs (star, copy, archive, restore) need a form the server holds, and a server that answers.
  const onServer = source === 'server' && !row.unsynced;
  const count = row.submissionCount > 0 ? ` · ${t(M['forms.responses_n'], { n: row.submissionCount })}` : '';
  const stamp = when(row.updatedAt);
  const meta = !stamp ? '' : inTrash ? t(M['forms.trashed_since'], { when: stamp }) : t(M[source === 'server' ? 'forms.updated' : 'forms.saved'], { when: stamp });

  const content = (
    <>
      <FileText className="size-4 shrink-0 text-text-subtle" />
      <span className="min-w-0 flex-1 truncate text-[15px]">{title}</span>
      {row.isLive ? (
        <Badge variant="success" size="sm">
          {t(M['forms.live'])}
        </Badge>
      ) : null}
      {row.unsynced ? (
        <Badge variant="warning" size="sm">
          {t(M['forms.unsynced'])}
        </Badge>
      ) : null}
      <span className="shrink-0 text-[13px] text-muted-foreground">{meta}</span>
    </>
  );

  return (
    <li className={cn('-mx-2 flex items-center gap-2 rounded-[6px] px-2 py-3 hover:bg-state-hover', busy && 'opacity-60')} aria-busy={busy}>
      {inTrash ? null : (
        <input type="checkbox" className="size-4 shrink-0" checked={selected} aria-label={t(M['forms.select'], { title })} onChange={() => onToggleSelected(row.id)} />
      )}
      {onServer && !inTrash ? (
        <Button type="button" variant="ghost" size="icon-sm" pressed={row.favourite} disabled={busy} aria-label={t(M['forms.star'], { title })} onClick={() => void actions.star(row)}>
          <Star className={cn('size-4', row.favourite && 'fill-current')} />
        </Button>
      ) : null}
      {inTrash ? (
        // A trashed form is not opened from here: restoring it comes first.
        <div className="flex min-w-0 flex-1 items-center gap-3 text-muted-foreground">{content}</div>
      ) : (
        <Link to={builderPath(row.id)} className="flex min-w-0 flex-1 items-center gap-3">
          {content}
        </Link>
      )}
      {inTrash ? (
        <Button type="button" variant="outline" size="sm" disabled={busy} aria-label={t(M['forms.restore_label'], { title })} onClick={() => void actions.restore(row)}>
          <RotateCcw />
          {t(M['forms.restore'])}
        </Button>
      ) : (
        <>
          <Button variant="outline" size="sm" asChild>
            <Link to={`/forms/${row.id}/responses`}>
              <Inbox />
              {t(M['forms.responses'])}
              {count}
            </Link>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" disabled={busy} aria-label={t(M['forms.actions'], { title })}>
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onServer ? (
                <>
                  <DropdownMenuItem onSelect={() => void actions.clone(row)}>
                    <Copy />
                    {t(M['forms.clone'])}
                  </DropdownMenuItem>
                  {row.lifecycle === 'archived' ? (
                    <DropdownMenuItem onSelect={() => void actions.restore(row)}>
                      <ArchiveRestore />
                      {t(M['forms.unarchive'])}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => void actions.archive(row)}>
                      <Archive />
                      {t(M['forms.archive'])}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                </>
              ) : null}
              {row.unsynced ? (
                <DropdownMenuItem variant="destructive" onSelect={() => onConfirmDelete(row)}>
                  <Trash2 />
                  {t(M['forms.delete'])}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem variant="destructive" onSelect={() => void actions.trash(row)}>
                  <Trash2 />
                  {t(M['forms.trash'])}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </li>
  );
}
