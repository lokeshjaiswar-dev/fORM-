import type { IsolationDomain } from './types.ts';

/**
 * Cases for the routes WP-1.07 adds for publishing and FormOps (versions, retirement, ops). Each is an `auth: 'user'`
 * route, so each needs a case here or the suite fails. If a case needs org A rows the core fixture does not have, add a
 * `seed` that returns them by name in `f.extra`.
 */
export const PUBLISH_ISOLATION: IsolationDomain = { cases: [] };
