import { useState } from 'react';
import { Alert, AlertActions, AlertButton, AlertDescription, AlertTitle } from '@dmacq/ui';
import { DraftConflictDialog } from '@/components/builder/DraftConflictDialog';
import { discardPending } from '@/persistence/autosave';
import { useUiStore } from '@/state/uiStore';

const CONFLICT = {
  open_elsewhere: 'This form is also open in another tab. If both change it, the later save asks which version to keep.',
  saved_elsewhere: 'This form was changed in another tab. Reload to see those changes, or keep editing: your next save asks which version to keep.',
} as const;

/** Load and import notes, the other-tab warning, and the merge dialog for a draft the server has moved on (WP-1.06). */
export function SessionBanners() {
  return (
    <>
      <Banners />
      <DraftConflictDialog />
    </>
  );
}

function Banners() {
  const notes = useUiStore((s) => s.notes);
  const conflict = useUiStore((s) => s.conflict);
  const dismissNotes = useUiStore((s) => s.dismissNotes);
  const dismissConflict = useUiStore((s) => s.dismissConflict);
  const [expanded, setExpanded] = useState(false);
  if (!notes.length && !conflict) return null;

  return (
    <div className="space-y-1 p-2">
      {conflict ? (
        <Alert variant="warning" icon onClose={dismissConflict} closeLabel="Dismiss tab warning">
          <AlertDescription>{CONFLICT[conflict]}</AlertDescription>
          {conflict === 'saved_elsewhere' ? (
            <AlertActions>
              <AlertButton type="button" onClick={reload}>
                Reload
              </AlertButton>
            </AlertActions>
          ) : null}
        </Alert>
      ) : null}
      {notes.length ? (
        <div role="region" aria-label="Form notes">
          <Alert variant="info" icon onClose={dismissNotes} closeLabel="Dismiss notes">
            <AlertTitle>{notes.length === 1 ? '1 note' : `${notes.length} notes`} about how this form was read.</AlertTitle>
            <AlertActions>
              <AlertButton type="button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                {expanded ? 'Hide' : 'Show'}
              </AlertButton>
            </AlertActions>
            {expanded ? (
              <AlertDescription>
                <ul className="mt-2 max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-[13px]">
                  {notes.map((note, i) => (
                    <li key={i}>
                      {note.detail} <code>{note.path}</code>
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            ) : null}
          </Alert>
        </div>
      ) : null}
    </div>
  );
}

/** Reloads to the other tab's save; this tab's unsaved change is dropped, not flushed over it on the way out. */
function reload() {
  discardPending();
  window.location.reload();
}
