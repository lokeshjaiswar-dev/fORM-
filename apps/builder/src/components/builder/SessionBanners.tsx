import { useState } from 'react';
import { X } from 'lucide-react';
import { discardPending } from '@/persistence/autosave';
import { useUiStore } from '@/state/uiStore';

const CONFLICT = {
  open_elsewhere: 'This form is also open in another tab. Saves from either tab replace the other’s.',
  saved_elsewhere: 'This form was changed in another tab. Reload to see those changes; edits here replace them.',
} as const;

/** Load and import notes (reader repairs and what the v2 migration changes), and the other-tab warning. */
export function SessionBanners() {
  const notes = useUiStore((s) => s.notes);
  const conflict = useUiStore((s) => s.conflict);
  const dismissNotes = useUiStore((s) => s.dismissNotes);
  const dismissConflict = useUiStore((s) => s.dismissConflict);
  const [expanded, setExpanded] = useState(false);
  if (!notes.length && !conflict) return null;

  return (
    <div className="space-y-px">
      {conflict ? (
        <div role="alert" className="flex items-center gap-3 bg-amber-50 px-4 py-2 text-[14px] text-amber-900">
          <span className="min-w-0 flex-1">{CONFLICT[conflict]}</span>
          {conflict === 'saved_elsewhere' ? (
            <button type="button" className="rounded-[4px] px-1.5 py-0.5 font-medium hover:bg-amber-100" onClick={reload}>
              Reload
            </button>
          ) : null}
          <Dismiss label="Dismiss tab warning" onClick={dismissConflict} />
        </div>
      ) : null}
      {notes.length ? (
        <section aria-label="Form notes" className="bg-sky-50 px-4 py-2 text-[14px] text-sky-950">
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1">
              {notes.length === 1 ? '1 note' : `${notes.length} notes`} about how this form was read.
            </span>
            <button type="button" className="rounded-[4px] px-1.5 py-0.5 font-medium hover:bg-sky-100" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Hide' : 'Show'}
            </button>
            <Dismiss label="Dismiss notes" onClick={dismissNotes} />
          </div>
          {expanded ? (
            <ul className="mt-2 max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-[13px]">
              {notes.map((note, i) => (
                <li key={i}>
                  {note.detail} <code className="text-sky-800">{note.path}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** Reloads to the other tab's save; this tab's unsaved change is dropped, not flushed over it on the way out. */
function reload() {
  discardPending();
  window.location.reload();
}

function Dismiss({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} className="rounded-[4px] p-1 hover:bg-black/5" onClick={onClick}>
      <X className="size-3.5" />
    </button>
  );
}
