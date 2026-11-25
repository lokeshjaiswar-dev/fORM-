import { useCallback, useEffect, useRef } from 'react';

/**
 * Warns before the page unloads while `dirty`, except after `allowLeave()`.
 *
 * A save clears `dirty` through React state and then navigates in the same tick, before React re-renders and the
 * effect removes the listener; without the flag the browser asked "Changes you made may not be saved" right after a
 * successful save. `allowLeave()` is synchronous, so the navigation that follows it never prompts.
 */
export function useLeaveGuard(dirty: boolean): () => void {
  const leaving = useRef(false);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (leaving.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  return useCallback(() => {
    leaving.current = true;
  }, []);
}
