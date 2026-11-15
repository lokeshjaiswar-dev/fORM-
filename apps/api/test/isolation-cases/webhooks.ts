import type { IsolationDomain } from './types.ts';

/**
 * Cases for the webhook routes (WP-1.18): a form's webhooks and their delivery log. Each is an `auth: 'user'` route, so
 * each needs a case here or the suite fails. If a case needs org A rows the core fixture does not have (a webhook, a
 * delivery), add a `seed` that returns them by name in `f.extra`.
 *
 * Empty until the webhook API task adds its routes; the cases go in this file, never in `index.ts`.
 */
export const WEBHOOKS_ISOLATION: IsolationDomain = { cases: [] };
