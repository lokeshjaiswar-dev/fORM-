import { useState } from 'react';

/**
 * The text of an input that writes to the store only when it is valid. The draft follows `value` when the stored
 * value changes (undo, another editor) and keeps a half-typed value the store refused. It is reset during render,
 * as React does for state derived from props, so no effect re-renders the input.
 */
export function useDraft<T>(value: T): [T, (next: T) => void] {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (!Object.is(seen, value)) {
    setSeen(value);
    setDraft(value);
  }
  return [draft, setDraft];
}
