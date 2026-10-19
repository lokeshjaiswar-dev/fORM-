import type { FastifyReply, FastifyRequest } from 'fastify';
import { audit, authThrottleHit, type AuthThrottleBucket, type Db } from '@form/db';
import { ProblemError } from '../../errors.ts';
import { hex } from './crypto.ts';

export interface Limit {
  max: number;
  windowSeconds: number;
}

/**
 * Architecture §3.5: `auth_any` per IP hash over every auth request (and every CSRF refusal or junk session cookie);
 * `auth_login` per IP hash and account over credential attempts and emailed-link requests. Beyond §3.5:
 * `auth_account` per account across IPs counts password attempts, and once spent a sign-in steps up to an emailed
 * link instead of being refused, so nobody can lock an owner out; `auth_mail` caps the links mailed to one address
 * (sign-up, magic link, reset, step-up), which failed passwords never use up; `auth_mfa` counts second-factor checks
 * per user. The PoW captcha step and the growing backoff arrive with the PoW captcha (BL-200).
 */
export const DEFAULT_AUTH_LIMITS: Record<AuthThrottleBucket, Limit> = {
  auth_any: { max: 60, windowSeconds: 60 },
  auth_login: { max: 10, windowSeconds: 900 },
  auth_account: { max: 30, windowSeconds: 3600 },
  auth_mfa: { max: 30, windowSeconds: 3600 },
  auth_mail: { max: 10, windowSeconds: 3600 },
};

export interface ThrottleKey {
  bucket: AuthThrottleBucket;
  key: Uint8Array;
}

export function createThrottle(o: { db: Db; auditDb: Db; limits: Record<AuthThrottleBucket, Limit>; now: () => Date }) {
  /** Counts one hit; past the limit, the seconds until the window ends. The first hit over is audited, once per window. */
  async function count(request: FastifyRequest, k: ThrottleKey, who: { ipHash: Uint8Array; userId?: string | null }): Promise<number | null> {
    const limit = o.limits[k.bucket];
    const { hits, windowEnds } = await authThrottleHit(o.db, k.bucket, k.key, limit.windowSeconds);
    if (hits <= limit.max) return null;
    // One record per window, not one per refused request, so a flood does not flood the audit log.
    if (hits === limit.max + 1) {
      try {
        await audit.appendDetached(o.auditDb, null, {
          actorKind: who.userId ? 'user' : 'none',
          actorId: who.userId ?? null,
          actorIpHash: hex(who.ipHash),
          actorUa: request.headers['user-agent'] ?? null,
          action: 'auth.throttled',
          resourceType: 'route',
          resourceId: `${request.method} ${request.routeOptions.url ?? ''}`,
          outcome: 'denied',
          reason: k.bucket,
          requestId: request.id,
          metadata: { bucket: k.bucket, limit: limit.max, windowSeconds: limit.windowSeconds },
        });
      } catch (err) {
        request.log.error({ err }, 'audit record of a throttled request was not written');
      }
    }
    return Math.max(1, Math.ceil((windowEnds.getTime() - o.now().getTime()) / 1000));
  }

  return {
    /** Counts one hit in each bucket; the first one over its limit answers 429 with Retry-After. */
    async hit(
      request: FastifyRequest,
      reply: FastifyReply,
      keys: readonly ThrottleKey[],
      who: { ipHash: Uint8Array; userId?: string | null },
      detail = 'Too many attempts. Try again later.',
    ): Promise<void> {
      for (const k of keys) {
        const retryAfter = await count(request, k, who);
        if (retryAfter === null) continue;
        reply.header('retry-after', String(retryAfter));
        throw new ProblemError('RATE_LIMITED', detail);
      }
    },
    /** Counts one hit and says whether the bucket is spent, for limits that change the answer instead of refusing. */
    async spent(request: FastifyRequest, k: ThrottleKey, who: { ipHash: Uint8Array; userId?: string | null }): Promise<boolean> {
      return (await count(request, k, who)) !== null;
    },
  };
}

export type Throttle = ReturnType<typeof createThrottle>;
