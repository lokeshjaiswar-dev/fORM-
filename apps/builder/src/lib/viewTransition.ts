import { useLayoutEffect } from 'react';

/** How long the old page may stay frozen while the next one mounts, before the crossfade runs anyway. */
const MAX_WAIT_MS = 600;

let arrive: (() => void) | null = null;

/**
 * Runs `go` (a navigation) inside a same-document view transition, so the page crossfades into the next one (the
 * animation lives in index.css under `::view-transition-*`). The router renders the new route asynchronously, so the
 * transition waits until that route calls `useViewTransitionArrival`. Without view transitions, or when the user asks
 * for reduced motion, it just navigates.
 */
export function navigateWithTransition(go: () => void): void {
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof document.startViewTransition !== 'function' || reduced) {
    go();
    return;
  }
  arrive?.();
  document.startViewTransition(
    () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(settle, MAX_WAIT_MS);
        function settle() {
          clearTimeout(timer);
          if (arrive === settle) arrive = null;
          resolve();
        }
        arrive = settle;
        try {
          go();
        } catch (error) {
          settle();
          throw error;
        }
      }),
  );
}

/** Called by a route that a view transition may be waiting for: its first commit is the new page. */
export function useViewTransitionArrival(): void {
  useLayoutEffect(() => {
    arrive?.();
  }, []);
}
