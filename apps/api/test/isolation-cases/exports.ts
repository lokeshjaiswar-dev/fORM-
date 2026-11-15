import type { IsolationDomain } from './types.ts';

/**
 * Cases for the export routes (WP-1.17): requesting, listing and downloading a submissions export. Each is an
 * `auth: 'user'` route, so each needs a case here or the suite fails. If a case needs org A rows the core fixture does
 * not have (a finished export), add a `seed` that returns them by name in `f.extra`.
 *
 * Empty until the exports task adds its routes; the cases go in this file, never in `index.ts`.
 */
export const EXPORTS_ISOLATION: IsolationDomain = { cases: [] };
