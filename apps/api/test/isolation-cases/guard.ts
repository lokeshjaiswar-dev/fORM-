import type { RouteOptions } from 'fastify';
import type { IsolationCase } from './types.ts';

export type RouteAuthKind = 'none' | 'account' | 'user';

export interface CollectedRoute {
  /** `METHOD /v1/pattern`. */
  key: string;
  auth: RouteAuthKind;
}

/**
 * What an `onRoute` hook saw, as `METHOD /pattern` and the route's auth. A route that sets no `auth` is `user` (default
 * deny, see `auth.ts`). HEAD and OPTIONS are skipped: HEAD is Fastify's twin of a GET route, and OPTIONS is the CORS
 * preflight, which carries no data.
 */
export function collect(into: CollectedRoute[], route: RouteOptions): void {
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  for (const method of methods) {
    if (method === 'HEAD' || method === 'OPTIONS') continue;
    into.push({ key: `${method} ${route.url}`, auth: route.config?.auth ?? 'user' });
  }
}

export interface Coverage {
  /** `auth: 'user'` or `'account'` routes with no case: the suite fails for each. */
  missing: string[];
  /** Cases that name a route that is not registered (renamed or removed): the suite fails, so cases do not rot. */
  stale: string[];
  /** Routes with more than one case, across the domain files. */
  duplicate: string[];
}

/** Which routes the cases cover. A route with `auth: 'none'` is public and needs its own review instead (CONTRIBUTING §5). */
export function coverage(routes: readonly CollectedRoute[], cases: readonly IsolationCase[]): Coverage {
  const named = new Map<string, number>();
  for (const c of cases) named.set(c.route, (named.get(c.route) ?? 0) + 1);
  const registered = new Set(routes.map((r) => r.key));
  return {
    missing: routes.filter((r) => r.auth !== 'none' && !named.has(r.key)).map((r) => r.key),
    stale: [...named.keys()].filter((key) => !registered.has(key)),
    duplicate: [...named].filter(([, n]) => n > 1).map(([key]) => key),
  };
}
