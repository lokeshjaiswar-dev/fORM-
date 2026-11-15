import type { IsolationDomain } from './types.ts';

/**
 * Cases for the routes WP-1.07 adds for form access (open and close times, limit, allowlists, password). Each is an
 * `auth: 'user'` route, so each needs a case here or the suite fails. The respondent's unlock route is `auth: 'none'`
 * and is covered by its own integration test, not by this suite. If a case needs org A rows the core fixture does not
 * have, add a `seed` that returns them by name in `f.extra`.
 */
export const ACCESS_ISOLATION: IsolationDomain = { cases: [] };
