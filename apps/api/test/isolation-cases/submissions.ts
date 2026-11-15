import type { IsolationDomain } from './types.ts';

/**
 * Cases for the routes WP-1.12 and WP-1.15 add or rewrite for submissions (the responses list, detail, reveal, export,
 * file download). Each is an `auth: 'user'` route, so each needs a case here or the suite fails; the rewritten routes
 * move their case here from `core.ts`. If a case needs org A rows the core fixture does not have, add a `seed` that
 * returns them by name in `f.extra`.
 */
export const SUBMISSIONS_ISOLATION: IsolationDomain = { cases: [] };
