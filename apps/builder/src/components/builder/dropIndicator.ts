import { createContext, useContext } from 'react';

/** Where a field dragged from the palette will be inserted: before or after the block with this id. */
export interface DropIndicator {
  id: string;
  after: boolean;
}

export const DropIndicatorContext = createContext<DropIndicator | null>(null);

/** The insertion line a block shows while a palette field is dragged over it, if any. */
export function useDropIndicator(id: string): 'before' | 'after' | null {
  const at = useContext(DropIndicatorContext);
  if (!at || at.id !== id) return null;
  return at.after ? 'after' : 'before';
}
