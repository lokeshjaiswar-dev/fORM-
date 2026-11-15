import type { FastifyRequest } from 'fastify';
import { accountOf, clientInfo } from '../../auth.ts';
import { hex } from '../auth/crypto.ts';
import type { ReviewModuleDeps } from './context.ts';

/** The `security` of every approvals route in the OpenAPI document: a session, or the development header, and the org. */
export const REVIEW_SECURITY = [{ session: [], org: [] }, { devUser: [], org: [] }];

/**
 * The audit fields every record of a signed-in caller carries besides the actor: the session, a keyed hash of the address
 * (never the address) and the user agent.
 */
export function auditClient(deps: Pick<ReviewModuleDeps, 'secret' | 'now'>, request: FastifyRequest) {
  const info = clientInfo(request, deps.secret, deps.now());
  return { sessionId: accountOf(request).session?.id ?? null, actorIpHash: hex(info.ipHash), actorUa: info.ua };
}
