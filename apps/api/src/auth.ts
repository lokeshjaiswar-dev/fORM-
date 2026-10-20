import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit, authSession, isUuid, membershipFor, type Db, type MembershipRole, type MfaLevel, type TenantCtx } from '@form/db';
import { permissionsFor, type Permission } from './authz/roles.ts';
import { ProblemError } from './errors.ts';
import { hex, ipHash, TOKEN_PATTERN, tokenHash } from './modules/auth/crypto.ts';
import { clearSessionCookie, SESSION_COOKIE, SESSION_IDLE_SECONDS, type ClientInfo } from './modules/auth/sessions.ts';

/**
 * `none`: public; `account`: a signed-in user, no org; `user`: a signed-in member of the org named in `X-FR-Org`
 * (or, when the request names none, the org the session's switcher chose).
 */
export type RouteAuth = 'none' | 'account' | 'user';

export interface RequestSession {
  id: string;
  userId: string;
  mfaLevel: MfaLevel;
  activeOrgId: string | null;
  createdAt: Date;
  absoluteExpiresAt: Date;
}

/** The signed-in caller: a session, or the development header (no session). */
export interface Account {
  userId: string;
  session: RequestSession | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set for routes with `config.auth: 'user'` once the caller and the active org are verified. */
    tenant: TenantCtx | null;
    /** Set for `account` and `user` routes. */
    account: Account | null;
    /** Set with `tenant`: the caller's role in the active org and the permissions it carries. */
    member: Member | null;
  }
  interface FastifyContextConfig {
    auth?: RouteAuth;
    perm?: Permission;
  }
}

export interface Member {
  role: MembershipRole;
  perms: readonly Permission[];
}

export const DEV_USER_HEADER = 'x-fr-dev-user';
export const ORG_HEADER = 'x-fr-org';

export interface AuthOptions {
  db: Db;
  auditDb: Db;
  /** Keys the IP hash of audit records. */
  secret: Uint8Array;
  /**
   * Tests and local development: the caller may name a user id in `X-FR-Dev-User` instead of a session. Refused
   * in production by the config.
   */
  devHeaders: boolean;
  /**
   * Counts a request with a cookie that leads to no session against the caller's per-IP budget (throws 429 once
   * spent), so junk cookies cannot flood the audit chain.
   */
  throttleRejected?: (request: FastifyRequest, reply: FastifyReply, ipHash: Uint8Array) => Promise<void>;
  now: () => Date;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return typeof v === 'string' ? v.trim() : undefined;
}

/** What auth audit records say about the client: a keyed hash of the IP (never the IP), the user agent, the request. */
export function clientInfo(request: FastifyRequest, secret: Uint8Array, now: Date): ClientInfo {
  const ua = request.headers['user-agent'];
  return { ipHash: ipHash(secret, request.ip, now), ua: typeof ua === 'string' ? ua : null, requestId: request.id };
}

/**
 * Request context: the caller (session cookie via auth_session(), or the development header), the active org
 * (validated with membership_for) and permissions. A cookie that does not lead to an active session is cleared,
 * audited and answered 401. A refusal of the org is a 403 that the error handler audits: a non-member under the
 * platform chain (with the org they named), a missing permission under the member's org.
 */
export function registerAuth(app: FastifyInstance, options: AuthOptions): void {
  app.decorateRequest('tenant', null);
  app.decorateRequest('account', null);
  app.decorateRequest('member', null);

  const deny = (request: FastifyRequest, orgId: string | null, userId: string, reason: string, detail: string): never => {
    throw new ProblemError('FORBIDDEN', detail, { orgId, actorId: userId, reason, claimedOrgId: orgId ? undefined : header(request, ORG_HEADER) });
  };

  async function rejectSession(request: FastifyRequest, reply: FastifyReply, reason: string, userId: string | null, sessionId: string | null): Promise<never> {
    clearSessionCookie(reply);
    const client = clientInfo(request, options.secret, options.now());
    await options.throttleRejected?.(request, reply, client.ipHash);
    try {
      await audit.appendDetached(options.auditDb, null, {
        actorKind: userId ? 'user' : 'none',
        actorId: userId,
        sessionId,
        actorIpHash: hex(client.ipHash),
        actorUa: client.ua,
        action: 'auth.session_rejected',
        resourceType: 'session',
        resourceId: sessionId,
        outcome: 'denied',
        reason,
        requestId: request.id,
      });
    } catch (err) {
      request.log.error({ err }, 'audit record of a rejected session was not written');
    }
    throw new ProblemError('UNAUTHENTICATED', 'Your session has ended. Sign in again.');
  }

  async function identify(request: FastifyRequest, reply: FastifyReply): Promise<Account> {
    if (options.devHeaders && request.headers[DEV_USER_HEADER] !== undefined) {
      const userId = header(request, DEV_USER_HEADER);
      if (!isUuid(userId)) throw new ProblemError('UNAUTHENTICATED', `${DEV_USER_HEADER} must be a user id`);
      return { userId, session: null };
    }
    const token = request.cookies[SESSION_COOKIE];
    if (!token) throw new ProblemError('UNAUTHENTICATED');
    if (!TOKEN_PATTERN.test(token)) return rejectSession(request, reply, 'malformed', null, null);
    const found = await authSession(options.db, tokenHash(token), SESSION_IDLE_SECONDS);
    if (!found) return rejectSession(request, reply, 'unknown', null, null);
    if (found.state !== 'active') return rejectSession(request, reply, found.state, found.userId, found.sessionId);
    return {
      userId: found.userId,
      session: {
        id: found.sessionId,
        userId: found.userId,
        mfaLevel: found.mfaLevel,
        activeOrgId: found.activeOrgId,
        createdAt: found.createdAt,
        absoluteExpiresAt: found.absoluteExpiresAt,
      },
    };
  }

  app.addHook('preHandler', async (request, reply) => {
    const { auth, perm } = request.routeOptions.config;
    if (auth !== 'user' && auth !== 'account') return;
    const account = await identify(request, reply);
    request.account = account;
    request.log = request.log.child({ userId: account.userId });
    reply.log = request.log;
    if (auth === 'account') return;

    const { userId } = account;
    const named = header(request, ORG_HEADER);
    const orgId = named === undefined ? (account.session?.activeOrgId ?? undefined) : named;
    if (!isUuid(orgId)) throw new ProblemError('BAD_REQUEST', `${ORG_HEADER} must be an org id`);

    const membership = await membershipFor(options.db, userId, orgId);
    if (!membership) return deny(request, null, userId, 'not_a_member', 'You are not a member of this org.');
    const perms = permissionsFor(membership.role, membership.grants);
    if (perm && !perms.includes(perm)) return deny(request, orgId, userId, `missing_permission:${perm}`, `Requires ${perm}.`);

    request.member = { role: membership.role, perms };
    request.tenant = { orgId, actor: 'user', userId, perms, teamIds: [], requestId: request.id };
    request.log = request.log.child({ orgId });
    reply.log = request.log;
  });
}

/** The verified context of an authenticated route. */
export function tenantOf(request: FastifyRequest): TenantCtx {
  if (!request.tenant) throw new ProblemError('UNAUTHENTICATED');
  return request.tenant;
}

/** The caller's membership in the active org, for `user` routes. */
export function memberOf(request: FastifyRequest): Member {
  if (!request.member) throw new ProblemError('UNAUTHENTICATED');
  return request.member;
}

/** The signed-in caller of an `account` or `user` route. */
export function accountOf(request: FastifyRequest): Account {
  if (!request.account) throw new ProblemError('UNAUTHENTICATED');
  return request.account;
}
