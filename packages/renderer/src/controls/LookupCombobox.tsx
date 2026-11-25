import { useEffect, useId, useRef, useState } from 'react';
import type { RemoteLookupRow } from '../remote.ts';
import type { LookupSource } from './lookupContext.tsx';

const DEBOUNCE_MS = 300;

/**
 * The picker of a server-side lookup: a searchable combobox. It waits 300 ms after the last keystroke, asks the source
 * only from `minChars` characters, aborts the older request when a newer one starts, shows at most `maxRows` rows, and on a
 * pick gives the row to `onPick` (the answer becomes the row's label; the mapped fields are filled by the lookup).
 */
export function LookupCombobox({
  source,
  inputProps,
  value,
  onType,
  onPick,
  onBlur,
  placeholder,
}: {
  source: LookupSource;
  inputProps: Record<string, unknown>;
  value: string;
  onType: (text: string) => void;
  onPick: (row: RemoteLookupRow) => void;
  onBlur: () => void;
  placeholder: string | undefined;
}) {
  const listId = useId();
  const [rows, setRows] = useState<RemoteLookupRow[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const ask = useRef<{ timer?: ReturnType<typeof setTimeout>; controller?: AbortController }>({});
  const { lookup, remote } = source;

  useEffect(() => () => {
    clearTimeout(ask.current.timer);
    ask.current.controller?.abort();
  }, []);

  const search = (text: string) => {
    clearTimeout(ask.current.timer);
    ask.current.controller?.abort();
    if (text.trim().length < lookup.minChars) {
      setRows([]);
      setOpen(false);
      return;
    }
    ask.current.timer = setTimeout(() => {
      const controller = new AbortController();
      ask.current.controller = controller;
      remote.lookup(lookup.id, text, controller.signal).then(
        (result) => {
          if (controller.signal.aborted) return;
          setRows(result.rows.slice(0, lookup.maxRows));
          setActive(-1);
          setOpen(true);
        },
        () => {
          if (!controller.signal.aborted) setRows([]);
        },
      );
    }, DEBOUNCE_MS);
  };

  const pick = (row: RemoteLookupRow) => {
    setOpen(false);
    setRows([]);
    onPick(row);
  };

  return (
    <span className="fr-lookup">
      <input
        className="fr-input"
        placeholder={placeholder}
        {...inputProps}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && rows.length > 0}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        onChange={(e) => {
          onType(e.target.value);
          search(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && rows.length) {
            e.preventDefault();
            setOpen(true);
            setActive((i) => (i + 1) % rows.length);
          } else if (e.key === 'ArrowUp' && rows.length) {
            e.preventDefault();
            setActive((i) => (i <= 0 ? rows.length - 1 : i - 1));
          } else if (e.key === 'Enter' && open && active >= 0 && rows[active]) {
            e.preventDefault();
            pick(rows[active]);
          } else if (e.key === 'Escape') setOpen(false);
        }}
        onBlur={() => {
          // A click on an option arrives after the blur; the list closes a moment later.
          setTimeout(() => setOpen(false), 150);
          onBlur();
        }}
      />
      {open && rows.length > 0 ? (
        <ul className="fr-lookup-list" id={listId} role="listbox">
          {rows.map((row, i) => (
            <li
              key={`${i}:${row.label}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              data-active={i === active || undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(row);
              }}
            >
              {row.label}
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}
