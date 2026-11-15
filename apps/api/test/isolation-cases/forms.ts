import type { IsolationDomain } from './types.ts';

/**
 * Cases for the routes WP-1.06 adds (forms list actions, trash and restore, favourite, clone, import). Each is an
 * `auth: 'user'` route, so each needs a case here or the suite fails. If a case needs org A rows the core fixture does
 * not have, add a `seed` that returns them by name in `f.extra`.
 */
export const FORMS_ISOLATION: IsolationDomain = { cases: [] };
