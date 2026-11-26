import { useEffect, useRef, useState } from 'react';
import { setTitle } from '@/state/actions';
import { useDoc } from '@/state/documentStore';

const UNTITLED = 'Form Name';

/**
 * The form's name in the top bar; clicking it (or Enter on it) renames it in place. Enter or leaving the field saves,
 * Escape cancels, and an empty name keeps the old one. The rename is one undoable step, like editing the title on the
 * canvas. The button's name starts with "Rename form", so a title such as "Edit" never shares a name with the Edit tab.
 */
export function FormName() {
  const title = useDoc((d) => d.title);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLButtonElement>(null);
  /** Set once Enter, Escape or blur has finished this edit, so a blur fired as the input unmounts does nothing. */
  const settled = useRef(false);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.select();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      nameRef.current?.focus();
    }
  }, [editing]);

  const start = () => {
    settled.current = false;
    setDraft(title);
    setEditing(true);
  };

  const finish = (save: boolean, refocus: boolean) => {
    if (settled.current) return;
    settled.current = true;
    restoreFocus.current = refocus;
    setEditing(false);
    const next = draft.trim();
    if (save && next && next !== title) setTitle(next);
  };

  const shown = title || UNTITLED;
  return (
    <div className="flex min-w-0 items-center gap-3">
      {editing ? (
        <input
          ref={inputRef}
          aria-label="Form name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finish(true, false)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') finish(true, true);
            if (e.key === 'Escape') finish(false, true);
          }}
          className="h-7 w-full max-w-[240px] min-w-0 rounded-[4px] border border-sidebar-border bg-transparent px-1.5 text-[14px] font-bold leading-5 text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        />
      ) : (
        <button
          ref={nameRef}
          type="button"
          onClick={start}
          title={shown}
          className="h-7 min-w-0 cursor-text truncate rounded-[4px] px-1.5 text-left text-[14px] font-bold leading-5 text-sidebar-foreground outline-none hover:bg-sidebar-border focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <span className="sr-only">Rename form: </span>
          {shown}
        </button>
      )}
    </div>
  );
}
