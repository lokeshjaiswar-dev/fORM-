import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from '@dmacq/ui';
import { defineMessages, type MessageId } from '@form/i18n';
import { t } from '@/i18n';
import type { BulkAction, View } from '@/persistence/submissionsApi';

const M = defineMessages('builder', {
  'responses.bulk.label': 'Actions for the selected responses',
  'responses.bulk.selected': '{n, plural, one {# response selected} other {# responses selected}}',
  'responses.bulk.clear': 'Clear selection',
  'responses.bulk.mark_read': 'Mark read',
  'responses.bulk.mark_unread': 'Mark unread',
  'responses.bulk.star': 'Star',
  'responses.bulk.unstar': 'Unstar',
  'responses.bulk.archive': 'Archive',
  'responses.bulk.unarchive': 'Move to inbox',
  'responses.bulk.trash': 'Move to trash',
  'responses.bulk.restore': 'Restore',
  'responses.bulk.delete': 'Delete forever',
  'responses.bulk.confirm_title': '{n, plural, one {Delete # response forever?} other {Delete # responses forever?}}',
  'responses.bulk.confirm_text': 'The answers and any files they hold are removed for good. This cannot be undone.',
  'responses.bulk.cancel': 'Cancel',
});

const LABELS: Record<BulkAction, MessageId> = {
  mark_read: M['responses.bulk.mark_read'],
  mark_unread: M['responses.bulk.mark_unread'],
  star: M['responses.bulk.star'],
  unstar: M['responses.bulk.unstar'],
  archive: M['responses.bulk.archive'],
  unarchive: M['responses.bulk.unarchive'],
  trash: M['responses.bulk.trash'],
  restore: M['responses.bulk.restore'],
  delete: M['responses.bulk.delete'],
};

/** The actions that make sense in each folder: the trash only brings responses back or removes them. */
const ACTIONS: Record<View, readonly BulkAction[]> = {
  inbox: ['mark_read', 'mark_unread', 'star', 'unstar', 'archive', 'trash'],
  archived: ['mark_read', 'mark_unread', 'star', 'unstar', 'unarchive', 'trash'],
  trash: ['restore', 'delete'],
};

export interface BulkBarProps {
  view: View;
  /** How many responses are selected (across every page loaded so far). */
  count: number;
  /** An action is on its way: the bar waits for it instead of sending a second one. */
  busy: boolean;
  onAct: (action: BulkAction) => void;
  onClear: () => void;
}

/**
 * What the member can do with the responses they selected. Deleting forever is the one action that asks first: it
 * removes the answers and the uploaded files and cannot be undone. Everything else can be undone by the opposite action.
 */
export function BulkBar({ view, count, busy, onAct, onClear }: BulkBarProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div role="toolbar" aria-label={t(M['responses.bulk.label'])} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-surface-primary-subtle px-3 py-2">
      <span className="mr-2 text-[13px] font-medium">{t(M['responses.bulk.selected'], { n: count })}</span>
      {ACTIONS[view].map((action) => (
        <Button
          key={action}
          type="button"
          size="sm"
          variant={action === 'delete' ? 'destructive' : 'outline'}
          disabled={busy}
          onClick={() => (action === 'delete' ? setConfirming(true) : onAct(action))}
        >
          {t(LABELS[action])}
        </Button>
      ))}
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClear}>
        {t(M['responses.bulk.clear'])}
      </Button>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(M['responses.bulk.confirm_title'], { n: count })}</AlertDialogTitle>
            <AlertDialogDescription>{t(M['responses.bulk.confirm_text'])}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(M['responses.bulk.cancel'])}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => onAct('delete')}>
              {t(M['responses.bulk.delete'])}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
