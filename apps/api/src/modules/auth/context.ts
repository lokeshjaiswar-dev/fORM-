import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  audit,
  authSession,
  authTokens,
  PLATFORM_ORG_KEY,
  sessions,
  users,
  withUser,
  type AuthTokenPurpose,
  type AuthUser,
  type Db,
  type FirstFactor,
  type Tx,
} from '@form/db';
import type { KeyProvider, Mailer } from '@form/ports';
import { z } from 'zod';
import { clientInfo, type Account } from '../../auth.ts';
import type { ApiConfig } from '../../config.ts';
import type { PlatformNotice } from '../account/notice.ts';
import { accountKey, equalBytes, hex, hmac, randomToken, TOKEN_PATTERN, tokenHash } from './crypto.ts';
import { LINK_MINUTES, LINK_PATHS, type AuthMail, type AuthMailer } from './mail.ts';
import type { BreachCheck } from './passwords.ts';
import { issueSession, revokeSession, SESSION_COOKIE, SESSION_IDLE_SECONDS, setSessionCookie, type ClientInfo } from './sessions.ts';
import type { Throttle, ThrottleKey } from './throttle.ts';

export interface AuthModuleDeps {
  db: Db;
  auditDb: Db;
  config: ApiConfig;
  mailer: Mailer;
  /** Wraps TOTP secrets; without one, two-factor enrolment answers 503. */
  keys: KeyProvider | undefined;
  /** HIBP on SaaS (`PASSWORD_BREACH_CHECK`); undefined skips it. */
  breached: BreachCheck | undefined;
  /** The auth rate limits (architecture §3.5), shared with the session check of every other route. */
  throttle: Throttle;
  now: () => Date;
}

export interface AuthCtx extends AuthModuleDeps {
  mail: AuthMailer;
  /** The platform privacy notice as this deployment shows it (CMP-21). */
  notice: PlatformNotice;
}

export const MFA_TICKET_MINUTES = 5;

export const emailSchema = z.string().trim().max(254).pipe(z.email());
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'expected a link token');

/** Lower case after Unicode normalisation; the address as typed is kept for display and delivery. */
export const normaliseEmail = (email: string) => email.trim().normalize('NFC').toLowerCase();

export const meUser = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string().nullable(),
  emailVerified: z.boolean(),
  totpEnabled: z.boolean(),
});
export type MeUser = z.infer<typeof meUser>;

export const signInResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('signed_in'), user: meUser, recoveryCodesLeft: z.number().int().optional() }),
  z.object({ status: z.literal('mfa_required'), ticket: z.string(), methods: z.array(z.enum(['totp', 'recovery'])) }),
  // A password sign-in at an account under many failed attempts: a sign-in link went to the address if it was right.
  z.object({ status: z.literal('link_sent') }),
]);
export type SignInResult = z.infer<typeof signInResult>;

export const toMe = (u: Pick<AuthUser, 'id' | 'email' | 'name' | 'emailVerifiedAt' | 'totpEnabledAt'>): MeUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  emailVerified: u.emailVerifiedAt !== null,
  totpEnabled: u.totpEnabledAt !== null,
});

export function client(c: AuthCtx, request: FastifyRequest): ClientInfo {
  return clientInfo(request, c.config.auth.secret, c.now());
}

/** Credential attempts and link requests, per IP and account (`auth_login`): refused with 429 once spent. */
export function loginLimit(c: AuthCtx, cl: ClientInfo, account: string): ThrottleKey {
  return { bucket: 'auth_login', key: new Uint8Array([...cl.ipHash, ...accountKey(c.config.auth.secret, account)]) };
}

/** Password attempts at one account across IPs (`auth_account`): once spent, a sign-in steps up to an emailed link. */
export function accountBudget(c: AuthCtx, account: string): ThrottleKey {
  return { bucket: 'auth_account', key: accountKey(c.config.auth.secret, account) };
}

/** Links mailed to one address (`auth_mail`), whoever asks: failed passwords never use it up. */
export function mailLimit(c: AuthCtx, account: string): ThrottleKey {
  return { bucket: 'auth_mail', key: accountKey(c.config.auth.secret, `mail:${account}`) };
}

export const MAIL_LIMIT_DETAIL = 'We sent several emails to this address in the last hour. Use the newest link we sent, or try again later.';

/**
 * Counts a second-factor check against the user's `auth_mfa` budget across IPs: MFA tickets and the signed-in
 * TOTP routes share it, so a stolen session cannot guess codes faster than a stolen password can.
 */
export function secondFactorAttempt(c: AuthCtx, request: FastifyRequest, reply: FastifyReply, userId: string): Promise<void> {
  const cl = client(c, request);
  return c.throttle.hit(request, reply, [{ bucket: 'auth_mfa', key: accountKey(c.config.auth.secret, `user:${userId}`) }], { ipHash: cl.ipHash, userId });
}

/**
 * Binds an email verification link to the browser that signed up (or asked for the link at sign-in): an HttpOnly
 * cookie holding a keyed hash of the link's token. Redeeming the link in any other browser needs the password, so
 * whoever registered an address they do not own cannot have its owner verify it for them.
 */
export const SIGNUP_COOKIE = '__Host-fr_signup';

export function signupProof(c: AuthCtx, token: string): string {
  return Buffer.from(hmac(c.config.auth.secret, `fr:signup:v1:${token}`)).toString('base64url');
}

export function setSignupCookie(reply: FastifyReply, value: string): void {
  reply.setCookie(SIGNUP_COOKIE, value, { path: '/', secure: true, httpOnly: true, sameSite: 'lax', maxAge: LINK_MINUTES.verify_email * 60 });
}

export function clearSignupCookie(reply: FastifyReply): void {
  reply.clearCookie(SIGNUP_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
}

/** True when this browser holds the sign-up cookie for the verification link `token`. */
export function signedUpHere(c: AuthCtx, request: FastifyRequest, token: string): boolean {
  const presented = request.cookies[SIGNUP_COOKIE];
  if (typeof presented !== 'string') return false;
  return equalBytes(Buffer.from(presented), Buffer.from(signupProof(c, token)));
}

/** Issues a single-use token for the user (inside their context) and returns it. Earlier unused ones of the purpose go. */
export async function issueToken(
  tx: Tx,
  o: { userId: string; purpose: AuthTokenPurpose; minutes: number; now: Date; data?: Record<string, unknown> },
): Promise<string> {
  const token = randomToken();
  await tx
    .update(authTokens)
    .set({ consumedAt: o.now })
    .where(and(eq(authTokens.userId, o.userId), eq(authTokens.purpose, o.purpose), isNull(authTokens.consumedAt)));
  await tx.insert(authTokens).values({
    id: randomUUID(),
    tokenHash: tokenHash(token),
    purpose: o.purpose,
    userId: o.userId,
    data: o.data ?? {},
    expiresAt: new Date(o.now.getTime() + o.minutes * 60_000),
  });
  return token;
}

export function linkFor(c: AuthCtx, kind: keyof typeof LINK_PATHS, token: string): string {
  return `${c.config.auth.builderUrl}${LINK_PATHS[kind]}#token=${token}`;
}

/**
 * Issues a fresh verification link (sign-up, and a password sign-in before the address is confirmed) and returns
 * the message with the sign-up cookie's value. The caller sends it once the transaction has committed, so a rollback
 * never mails a dead link.
 */
export async function verificationMail(c: AuthCtx, tx: Tx, user: Pick<AuthUser, 'id' | 'email' | 'name'>): Promise<{ mail: AuthMail; proof: string }> {
  const token = await issueToken(tx, { userId: user.id, purpose: 'verify_email', minutes: LINK_MINUTES.verify_email, now: c.now() });
  return {
    mail: { kind: 'verify_email', to: { address: user.email, ...(user.name ? { name: user.name } : {}) }, link: linkFor(c, 'verify_email', token) },
    proof: signupProof(c, token),
  };
}

/** The live session this browser presents on a public auth route (sign-in replaces it), or null. */
export async function presentedAccount(c: AuthCtx, request: FastifyRequest): Promise<Account | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const s = await authSession(c.db, tokenHash(token), SESSION_IDLE_SECONDS);
  if (s?.state !== 'active') return null;
  return {
    userId: s.userId,
    session: { id: s.sessionId, userId: s.userId, mfaLevel: s.mfaLevel, activeOrgId: s.activeOrgId, createdAt: s.createdAt, absoluteExpiresAt: s.absoluteExpiresAt },
  };
}

export type SignInMethod = 'password' | 'magic_link' | 'verify_email' | 'oauth_google' | 'oauth_microsoft';

/**
 * After a first factor: an MFA ticket when the user has TOTP on, else a new session (cookie set here). A session
 * cookie this browser presented for the same user is revoked, and every sign-in gets a fresh token, so a token
 * planted before sign-in (session fixation) never becomes the signed-in session.
 */
export async function completeFirstFactor(
  c: AuthCtx,
  request: FastifyRequest,
  reply: FastifyReply,
  o: { user: AuthUser; factor: FirstFactor; method: SignInMethod; presented: Account | null; inTx?: (tx: Tx) => Promise<void> },
): Promise<SignInResult> {
  const cl = client(c, request);
  const now = c.now();
  const { user } = o;
  if (user.totpEnabledAt) {
    const ticket = await withUser(c.db, { userId: user.id, requestId: request.id }, async (tx) => {
      await o.inTx?.(tx);
      const t = await issueToken(tx, { userId: user.id, purpose: 'mfa', minutes: MFA_TICKET_MINUTES, now, data: { factor: o.factor, method: o.method } });
      await audit.append(tx, PLATFORM_ORG_KEY, {
        actorKind: 'user',
        actorId: user.id,
        actorIpHash: hex(cl.ipHash),
        actorUa: cl.ua,
        action: 'auth.mfa_challenged',
        resourceType: 'user',
        resourceId: user.id,
        outcome: 'success',
        requestId: request.id,
        metadata: { method: o.method },
      });
      return t;
    });
    return { status: 'mfa_required', ticket, methods: ['totp', 'recovery'] };
  }
  const session = await withUser(c.db, { userId: user.id, requestId: request.id }, async (tx) => {
    await o.inTx?.(tx);
    if (o.presented?.session && o.presented.userId === user.id) await revokeSession(tx, o.presented.session.id, 'rotated', now);
    const s = await issueSession(tx, { userId: user.id, mfaLevel: o.factor, client: cl, now });
    await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
    await audit.append(tx, PLATFORM_ORG_KEY, {
      actorKind: 'user',
      actorId: user.id,
      sessionId: s.id,
      actorIpHash: hex(cl.ipHash),
      actorUa: cl.ua,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      outcome: 'success',
      requestId: request.id,
      metadata: { method: o.method, mfaLevel: s.mfaLevel },
    });
    return s;
  });
  setSessionCookie(reply, session);
  return { status: 'signed_in', user: toMe(user) };
}

/** The live sessions of a user, newest first (RLS limits the query to them). */
export function liveSessions(tx: Tx, now: Date) {
  return tx
    .select({ id: sessions.id, mfaLevel: sessions.mfaLevel, uaSummary: sessions.uaSummary, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, idleExpiresAt: sessions.idleExpiresAt })
    .from(sessions)
    .where(isNull(sessions.revokedAt))
    .then((rows) => rows.filter((r) => r.idleExpiresAt > now).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()));
}
