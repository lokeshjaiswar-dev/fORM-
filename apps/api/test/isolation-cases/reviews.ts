import type { IsolationDomain } from './types.ts';

/**
 * Cases for the approvals routes (WP-2.33): review groups, review settings, the review queue and decisions. Each is an
 * `auth: 'user'` route, so each needs a case here or the suite fails. If a case needs org A rows the core fixture does
 * not have (a group, a held response), add a `seed` that returns them by name in `f.extra`.
 *
 * Empty until the approvals API tasks add their routes; the cases go in this file, never in `index.ts`.
 */
export const REVIEWS_ISOLATION: IsolationDomain = { cases: [] };
