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

/** The class on <html> while the builder switches view; index.css scopes the switch's names and timing to it. */
const SWITCH_CLASS = 'builder-view-switch';
/** How long the old view may stay frozen while the next one renders, before the transition runs anyway. */
const MAX_SWITCH_WAIT_MS = 600;

let settleSwitch: (() => void) | null = null;
/** The view the running switch waits for; null when any new view will do. */
let switchTarget: string | null = null;
/** The view the builder last committed (useBuilderViewSettled). */
let committedView: string | null = null;
let currentSwitch: ViewTransition | null = null;

function canAnimate(): boolean {
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return typeof document.startViewTransition === 'function' && !reduced;
}

/**
 * Runs `update` (switching between Edit, Preview and Settings) inside a view transition, so the canvas, the toolbox,
 * the side panel and the view switch's highlight move to their new places instead of jumping (index.css,
 * `.builder-view-switch`). The new view may render asynchronously (Edit and Preview navigate), so the transition waits
 * until the builder commits `target` (`useBuilderViewSettled`), or any new view when no target is given; leaving
 * Settings for the other mode passes through that mode first, which must not be what the transition animates to.
 * Without view transitions, or with reduced motion, it just switches.
 */
export function switchBuilderView(update: () => void, target: string | null = null): void {
  if (!canAnimate()) {
    update();
    return;
  }
  settleSwitch?.();
  switchTarget = target;
  const root = document.documentElement;
  root.classList.add(SWITCH_CLASS);
  const transition = document.startViewTransition(
    () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(settle, MAX_SWITCH_WAIT_MS);
        function release() {
          clearTimeout(timer);
          if (settleSwitch === settle) {
            settleSwitch = null;
            switchTarget = null;
          }
        }
        function settle() {
          release();
          resolve();
        }
        settleSwitch = settle;
        try {
          update();
        } catch (error) {
          release();
          reject(error);
          return;
        }
        /* Already showing the target (say a quick second click): no new view will commit, so do not wait for one. */
        if (target !== null && committedView === target) settle();
      }),
  );
  currentSwitch = transition;
  /* A quicker second switch skips this one; that is expected, not an error. */
  transition.ready.catch(() => undefined);
  /* An update that throws must not vanish inside the transition: report it like any uncaught error. */
  transition.updateCallbackDone.catch((error: unknown) => reportError(error));
  const done = () => {
    if (currentSwitch !== transition) return;
    currentSwitch = null;
    root.classList.remove(SWITCH_CLASS);
  };
  transition.finished.then(done, done);
}

/** Called by the builder with its current view: committing a new one lets a waiting switch run. */
export function useBuilderViewSettled(view: string): void {
  useLayoutEffect(() => {
    committedView = view;
    if (switchTarget === null || switchTarget === view) settleSwitch?.();
  }, [view]);
}
