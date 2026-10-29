import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProblemError } from '../../errors.ts';
import { SESSION_COOKIE } from './sessions.ts';

export const CLIENT_HEADER = 'x-fr-client';
export const CLIENT_BUILDER = 'builder';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'fastify' {
  interface FastifyContextConfig {
    /** False for endpoints browsers call without the builder's header (CSP reports). */
    csrf?: boolean;
  }
}

export type CsrfVerdict = 'ok' | 'missing_client_header' | 'cross_site' | 'no_fetch_metadata';

/**
 * ADR-0008: an unsafe request from a browser needs `X-FR-Client: builder` (a custom header, so any cross-origin
 * caller first needs a CORS preflight, which only the builder origin passes) and `Sec-Fetch-Site: same-origin`.
 * `same-site` passes only together with an `Origin` that is the configured builder origin: SaaS serves the builder
 * and the API on sibling hosts of one site (architecture §3.1), while respondent pages live on another site.
 * No tokens.
 */
export function csrfVerdict(request: Pick<FastifyRequest, 'headers'>, builderOrigins: readonly string[]): CsrfVerdict {
  const client = request.headers[CLIENT_HEADER];
  if (client !== CLIENT_BUILDER) return 'missing_client_header';
  const site = request.headers['sec-fetch-site'];
  if (site === undefined) return 'no_fetch_metadata';
  if (site === 'same-origin') return 'ok';
  const origin = request.headers.origin;
  if (site === 'same-site' && typeof origin === 'string' && builderOrigins.includes(origin)) return 'ok';
  return 'cross_site';
}

/**
 * Guards every unsafe request that rides on the session cookie, and every unsafe auth request (sign-in, sign-up,
 * resets), so a cross-site page can neither act as a signed-in user nor sign a victim into another account. Requests
 * authenticated by the development header without a cookie are not cookie-authenticated and are not guarded. A
 * refusal first counts against the caller's per-IP budget (`refused`, which answers 429 once it is spent), then is
 * a 403 that the error handler audits (`request.authorize`, reason `csrf_*`), so refusals cannot flood the audit log.
 */
export function registerCsrfGuard(
  app: FastifyInstance,
  o: { builderOrigins: readonly string[]; devHeader: string | null; refused?: (request: FastifyRequest, reply: FastifyReply) => Promise<void> },
): void {
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE.has(request.method) || request.routeOptions.config.csrf === false) return;
    const hasCookie = typeof request.headers.cookie === 'string' && request.headers.cookie.includes(`${SESSION_COOKIE}=`);
    const authRoute = request.routeOptions.url?.startsWith('/v1/auth/') === true;
    if (!hasCookie && !authRoute) return;
    if (!hasCookie && o.devHeader && request.headers[o.devHeader] !== undefined) return;
    const verdict = csrfVerdict(request, o.builderOrigins);
    if (verdict === 'ok') return;
    await o.refused?.(request, reply);
    throw new ProblemError('CSRF_REJECTED', 'Cross-site request refused.', { orgId: null, actorId: null, reason: `csrf_${verdict}` });
  });
}
