import { uid } from '@/lib/utils';
import type { TabConflict } from '@/state/uiStore';

/*
 * Tabs of this builder tell each other which form they have open and when they save it, over a BroadcastChannel.
 * Saves are last-writer-wins, so a second tab on the same form gets a warning instead of silently overwriting.
 */

export const TAB_CHANNEL = 'fORM-builder';

type Message =
  | { type: 'hello'; formId: string; tab: string }
  | { type: 'here'; formId: string; tab: string }
  | { type: 'saved'; formId: string; tab: string; rev: number };

export interface TabWatch {
  /** Tells the other tabs this tab saved `rev`. */
  saved: (rev: number) => void;
  close: () => void;
}

const isMessage = (data: unknown): data is Message =>
  typeof data === 'object' && data !== null && typeof (data as Message).formId === 'string' && typeof (data as Message).tab === 'string';

/** Watches the other tabs for `formId`; a no-op where BroadcastChannel is missing. */
export function watchTabs(formId: string, onConflict: (conflict: TabConflict) => void): TabWatch {
  if (typeof BroadcastChannel === 'undefined') return { saved: () => {}, close: () => {} };
  const channel = new BroadcastChannel(TAB_CHANNEL);
  const tab = uid();
  const post = (message: Message) => channel.postMessage(message);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!isMessage(message) || message.formId !== formId || message.tab === tab) return;
    if (message.type === 'hello') post({ type: 'here', formId, tab });
    onConflict(message.type === 'saved' ? 'saved_elsewhere' : 'open_elsewhere');
  };
  post({ type: 'hello', formId, tab });
  return {
    saved: (rev) => post({ type: 'saved', formId, tab, rev }),
    close: () => channel.close(),
  };
}
