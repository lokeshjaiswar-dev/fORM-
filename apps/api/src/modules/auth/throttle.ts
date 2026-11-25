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
  // Anonymous respondent writes (`POST /v1/p/:slug/files` and `/submissions`), counted the same way. Per IP hash over
  // every form, so one address cannot spray many forms; and per IP hash and form, so it cannot flood one. A person
  // fills a form in a few requests, so these are far above that, and still enough for a classroom behind one address.
  // Ten-minute windows. (A flood from many addresses is a job for the edge: rate limits and a captcha.)
  auth_files_ip: { max: 240, windowSeconds: 600 },
  auth_files_form: { max: 120, windowSeconds: 600 },
  auth_submit_ip: { max: 120, windowSeconds: 600 },
  auth_submit_form: { max: 60, windowSeconds: 600 },
  // Password attempts on a protected form (`POST /v1/p/:slug/unlock`). Every attempt counts, the right password too (a
  // refund after the fact would let parallel guesses through), and each one costs an argon2id check (64 MiB, in the
  // libuv threadpool) whether or not the form has a password. Two budgets, both counted before any hashing:
  // `auth_unlock_ip` per IP hash over every form, so one address cannot aim at many published slugs (its own org can
  // publish as many as it likes, each with a fresh per-form budget) and starve the threadpool that sign-in hashing,
  // file and crypto work share; and `auth_unlock_form` per IP hash and form, the sign-in limit (`auth_login`): ten tries
  // in fifteen minutes at one form. The per-address cap is three of those budgets, enough for a person with a few
  // protected forms to open. The per-visit-token budget that spares a shared address arrives with the runtime host
  // (WP-1.09, architecture §3.5 `runtime_unlock`).
  auth_unlock_ip: { max: 30, windowSeconds: 900 },
  auth_unlock_form: { max: 10, windowSeconds: 900 },
  // Server-side lookups (`POST /v1/p/:slug/lookups|fields/...`): a respondent types, and each pause is one call, so the budgets
  // are well above filling a form but bound what one address, one address on one form, and every address together on one
  // form can ask the form owner's upstream API for (the proxy is the only caller of that API). Ten-minute windows. The author's
  // Test and preview calls (`POST /v1/forms/:id/remote/test`) are counted per user. None of these touches the submit buckets,
  // so an exhausted lookup budget never blocks a submission.
  auth_remote_ip: { max: 600, windowSeconds: 600 },
  auth_remote_form: { max: 300, windowSeconds: 600 },
  auth_remote_formall: { max: 20000, windowSeconds: 600 },
  auth_remote_test: { max: 120, windowSeconds: 600 },
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
