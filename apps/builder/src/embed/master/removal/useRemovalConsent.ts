import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskRemoval, RemovalNeed } from '@/embed/master/DmsMasterRepository';

/*
 * The consent dialogs of a save that removes stored fields (SEC-DESIGN 7.3, DESIGN 5.2). `DmsMasterRepository.commit` calls `ask` once per
 * field, in order; the page renders `pending` in a `RemovalDialog`. Exactly one dialog is open at a time, so a second ask while one is
 * open waits for it. An answer is either the typed name or `null` (cancel); the repository checks the name again before it sends.
 */

export interface PendingRemoval {
  need: RemovalNeed;
  /** The author pressed Remove with this text in the name box; the dialog only calls it when the text equals the field name exactly. */
  confirm: (typedName: string) => void;
  cancel: () => void;
}

export function useRemovalConsent(): { ask: AskRemoval; pending: PendingRemoval | null } {
  const [pending, setPending] = useState<PendingRemoval | null>(null);
  const waiting = useRef<Array<() => void>>([]);
  const open = useRef(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const ask = useCallback<AskRemoval>(async (need) => {
    // One dialog at a time: a later ask queues behind the open one.
    while (open.current) await new Promise<void>((resolve) => waiting.current.push(resolve));
    open.current = true;
    try {
      return await new Promise<string | null>((resolve) => {
        const done = (answer: string | null) => {
          if (live.current) setPending(null);
          resolve(answer);
        };
        if (!live.current) return resolve(null);
        setPending({ need, confirm: (typed) => done(typed), cancel: () => done(null) });
      });
    } finally {
      open.current = false;
      waiting.current.shift()?.();
    }
  }, []);

  return { ask, pending };
}
