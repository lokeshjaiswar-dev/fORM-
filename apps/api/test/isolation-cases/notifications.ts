import type { IsolationDomain } from './types.ts';

/**
 * Cases for the notification routes (WP-1.16): org email senders and the notifications and email log of a form. Each is
 * an `auth: 'user'` route, so each needs a case here or the suite fails. If a case needs org A rows the core fixture does
 * not have (a sender, a notification), add a `seed` that returns them by name in `f.extra`.
 *
 * Empty until the notification API task adds its routes; the cases go in this file, never in `index.ts`.
 */
export const NOTIFICATIONS_ISOLATION: IsolationDomain = { cases: [] };
