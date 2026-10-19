import { randomUUID } from 'node:crypto';
import { and, eq, isNull, or, lt, TransactionRollbackError } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  audit,
  authCreateUser,
  authMfaTicket,
  authRecoveryCodeUse,
  authTokenPeek,
  authTokenTake,
  authUserByEmail,
  authUserCredentials,
  FIRST_FACTORS,
  PLATFORM_ORG_KEY,
  users,
  withUser,
  type AuthCredentials,
  type AuthUser,
  type FirstFactor,
  type MfaLevel,
} from '@form/db';
import { z } from 'zod';
import { accountOf, type Account } from '../../auth.ts';
import { ProblemError } from '../../errors.ts';
import { recordNoticeAck } from '../account/notice.ts';
import {
  accountBudget,
  clearSignupCookie,
  client,
  completeFirstFactor,
  emailSchema,
  issueToken,
  linkFor,
  loginLimit,
  MAIL_LIMIT_DETAIL,
  mailLimit,
  normaliseEmail,
  presentedAccount,
  secondFactorAttempt,
  setSignupCookie,
  signedUpHere,
  signInResult,
  toMe,
  tokenSchema,
  type AuthCtx,
  type SignInMethod,
  verificationMail,
} from './context.ts';
import { base32Encode, hex, randomToken, tokenHash } from './crypto.ts';
import { LINK_MINUTES } from './mail.ts';
import { hashPassword, passwordProblem, PASSWORD_PROBLEMS, verifyPassword } from './passwords.ts';
import { hashRecoveryCode, newRecoveryCodes, normaliseRecoveryCode, RECOVERY_CODE } from './recovery.ts';
import { openTotpSecret, sealTotpSecret } from './secrets.ts';
import { clearSessionCookie, type ClientInfo, issueSession, revokeOtherSessions, revokeSession, rotateSession, setSessionCookie } from './sessions.ts';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp.ts';

const accepted = z.object({ status: z.enum(['verification_sent', 'link_sent']) });
const passwordSchema = z.string().min(1).max(1024);
const codeSchema = z.string().trim().min(6).max(32);
const ticketSchema = z.object({ ticket: tokenSchema, code: codeSchema });

/** Enrolling an authenticator needs a sign-in this recent, so a session taken over later cannot lock its owner out. */
export const RECENT_SIGN_IN_MINUTES = 15;

const firstFactorOf = (level: MfaLevel): FirstFactor => {
  const f = level.split('+')[0] as FirstFactor;
  return (FIRST_FACTORS as readonly string[]).includes(f) ? f : 'pwd';
};

/**
 * `/v1/auth/*` (architecture §3.3, ADR-0017): sign-up and email verification, password and magic-link sign-in,
 * sign-out, password reset, the TOTP second factor with recovery codes, and TOTP enrolment. Answers that could
 * tell whether an address has an account are the same either way; every outcome is audited on the platform chain.
 */
export function authRoutes(app: FastifyInstance, c: AuthCtx): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['auth'];

  const deniedLogin = async (request: FastifyRequest, o: { userId: string | null; reason: string; method: SignInMethod | 'totp' | 'recovery_code'; stepUp?: boolean }) => {
    const cl = client(c, request);
    await audit.appendDetached(c.auditDb, null, {
      actorKind: o.userId ? 'user' : 'none',
      actorId: o.userId,
      actorIpHash: hex(cl.ipHash),
      actorUa: cl.ua,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: o.userId,
      outcome: 'denied',
      reason: o.reason,
      requestId: request.id,
      metadata: { method: o.method, stepUp: o.stepUp === true },
    });
  };

  r.get(
    '/v1/auth/methods',
    {
      config: { auth: 'none' },
      schema: {
        tags,
        summary: 'Sign-in methods this deployment offers',
        response: { 200: z.object({ password: z.boolean(), emailLinks: z.boolean(), oauth: z.array(z.enum(['google', 'microsoft'])) }) },
      },
    },
    async () => ({
      password: true,
      emailLinks: c.config.mailer.driver === 'smtp',
      oauth: (['google', 'microsoft'] as const).filter((p) => c.config.auth.oidc[p] !== undefined),
    }),
  );

  r.post(
    '/v1/auth/signup',
    {
      config: { auth: 'none' },
      schema: {
        tags,
        summary: 'Create an account; a verification link is emailed',
        description:
          'The builder shows the platform privacy notice (`GET /v1/privacy/notice`) and sends the version it showed; a stale version is refused with `NOTICE_OUTDATED`, and the version is recorded with the new account (CMP-21).',
        body: z.object({
          email: emailSchema,
          password: passwordSchema,
          name: z.string().trim().min(1).max(200).optional(),
          noticeVersion: z.string().max(32),
        }),
        response: { 202: accepted },
      },
    },
    async (request, reply) => {
      const { email, password, name, noticeVersion } = request.body;
      const emailNorm = normaliseEmail(email);
      const cl = client(c, request);
      await c.throttle.hit(request, reply, [loginLimit(c, cl, emailNorm)], { ipHash: cl.ipHash });
      if (noticeVersion !== c.notice.version) {
        await audit.appendDetached(c.auditDb, null, {
          actorKind: 'none',
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'auth.signup',
          resourceType: 'user',
          outcome: 'denied',
          reason: 'notice_outdated',
          requestId: request.id,
          metadata: { noticeVersion: noticeVersion.slice(0, 32), current: c.notice.version },
        });
        throw new ProblemError('NOTICE_OUTDATED', 'The privacy notice changed while you were signing up. Read the new version, then create your account.');
      }
      const problem = await passwordProblem(password, { email: emailNorm, breached: c.breached });
      if (problem) {
        await audit.appendDetached(c.auditDb, null, {
          actorKind: 'none',
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'auth.signup',
          resourceType: 'user',
          outcome: 'denied',
          reason: `weak_password:${problem}`,
          requestId: request.id,
        });
        throw new ProblemError('WEAK_PASSWORD', PASSWORD_PROBLEMS[problem]);
      }
      await c.throttle.hit(request, reply, [mailLimit(c, emailNorm)], { ipHash: cl.ipHash }, MAIL_LIMIT_DETAIL);
      const id = randomUUID();
      const passwordHash = await hashPassword(password);
      // The account and the record of the notice it was shown are created together, or not at all.
      const created = await withUser(c.db, { userId: id, requestId: request.id }, async (tx) => {
        if (!(await authCreateUser(tx, { id, email: email.trim(), emailNorm, name: name ?? null, locale: null, passwordHash, emailVerified: false }))) return null;
        await recordNoticeAck(tx, { userId: id, notice: c.notice, context: 'signup', client: cl });
        const m = await verificationMail(c, tx, { id, email: email.trim(), name: name ?? null });
        await audit.append(tx, PLATFORM_ORG_KEY, {
          actorKind: 'user',
          actorId: id,
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'auth.signup',
          resourceType: 'user',
          resourceId: id,
          outcome: 'success',
          requestId: request.id,
          metadata: { noticeVersion: c.notice.version },
        });
        return m;
      });
      if (created) {
        setSignupCookie(reply, created.proof);
        c.mail.send(created.mail);
      } else {
        // The same cookie either way, so the answer does not tell whether the address was free.
        setSignupCookie(reply, randomToken());
        const existing = await authUserByEmail(c.db, emailNorm);
        await audit.appendDetached(c.auditDb, null, {
          actorKind: 'none',
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'auth.signup',
          resourceType: 'user',
          resourceId: existing?.id ?? null,
          outcome: 'denied',
          reason: 'email_taken',
          requestId: request.id,
        });
        if (existing?.status === 'active') {
          c.mail.send({ kind: 'account_exists', to: { address: existing.email }, link: `${c.config.auth.builderUrl}/auth/sign-in` });
        }
      }
      return reply.code(202).send({ status: 'verification_sent' });
    },
  );

  r.post(
    '/v1/auth/link',
    {
      config: { auth: 'none' },
      schema: {
        tags,
        summary: 'Who an emailed sign-in or verification link is for, without using it',
        description:
          'The builder shows the address and redeems the link only once the person confirms it, so a link someone else sent cannot silently sign them into another account.',
        body: z.object({ token: tokenSchema, purpose: z.enum(['verify_email', 'magic_link']) }),
        response: { 200: z.object({ email: z.string(), passwordRequired: z.boolean() }) },
      },
    },
    async (request) => {
      const { token, purpose } = request.body;
      const peeked = await authTokenPeek(c.db, tokenHash(token), purpose);
      if (!peeked) {
        const cl = client(c, request);
        await audit.appendDetached(c.auditDb, null, {
          actorKind: 'none',
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'auth.link_checked',
          resourceType: 'user',
          outcome: 'denied',
          reason: 'invalid_token',
          requestId: request.id,
          metadata: { purpose },
        });
        throw new ProblemError('INVALID_TOKEN', 'This link is invalid or has expired. Ask for a new one.', undefined, { audited: true });
      }
      return { email: peeked.email, passwordRequired: purpose === 'verify_email' && needsPassword(peeked) && !signedUpHere(c, request, token) };
    },
  );

  /** A never-verified account with a password: whoever opened it chose that password, maybe not the address's owner. */
  const needsPassword = (u: { emailVerified: boolean; hasPassword: boolean }) => u.hasPassword && !u.emailVerified;

  r.post(
    '/v1/auth/verify-email',
    {
      config: { auth: 'none' },
      schema: {
        tags,
        summary: 'Redeem an email verification link and sign in',
        description:
          'In a browser other than the one that signed up, a never-verified account also needs its password (`PASSWORD_REQUIRED`), so the owner of an address someone else registered does not verify it for them.',
        body: z.object({ token: tokenSchema, password: passwordSchema.optional() }),
        response: { 200: signInResult },
      },
    },
    async (request, reply) => {
      const cl = client(c, request);
      const { token, password } = request.body;
      const denied = (userId: string | null, reason: string) =>
        audit.appendDetached(c.auditDb, null, {
          actorKind: userId ? 'user' : 'none',
          actorId: userId,
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'auth.email_verified',
          resourceType: 'user',
          resourceId: userId,
          outcome: 'denied',
          reason,
          requestId: request.id,
        });
      if (!signedUpHere(c, request, token)) {
        // Checked before the link is used, so a missing or wrong password does not cost the owner their link.
        const peeked = await authTokenPeek(c.db, tokenHash(token), 'verify_email');
        if (peeked && needsPassword(peeked)) {
          if (password === undefined) {
            await denied(peeked.userId, 'password_required');
            throw new ProblemError('PASSWORD_REQUIRED', 'Enter the password you chose when you signed up.', undefined, { audited: true });
          }
          await c.throttle.hit(request, reply, [loginLimit(c, cl, normaliseEmail(peeked.email))], { ipHash: cl.ipHash, userId: peeked.userId });
          const creds = await authUserCredentials(c.db, peeked.userId);
          if (!(await verifyPassword(creds?.passwordHash ?? null, password))) {
            await denied(peeked.userId, 'bad_password');
            throw new ProblemError('INVALID_CREDENTIALS', 'That password is not right. If you did not sign up, or forgot it, reset the password instead.', undefined, {
              audited: true,
            });
          }
        }
      }
      const taken = await authTokenTake(c.db, tokenHash(token), 'verify_email');
      const user = taken ? await authUserCredentials(c.db, taken.userId) : null;
      if (!taken || !user || user.status !== 'active') {
        await denied(taken?.userId ?? null, taken ? 'user_inactive' : 'invalid_token');
        throw new ProblemError('INVALID_TOKEN', 'This link is invalid or has expired. Sign in to get a new one.', undefined, { audited: true });
      }
      const now = c.now();
      const result = await completeFirstFactor(c, request, reply, {
        user: { ...user, emailVerifiedAt: user.emailVerifiedAt ?? now },
        factor: 'link',
        method: 'verify_email',
        presented: await presentedAccount(c, request),
        inTx: async (tx) => {
          await tx.update(users).set({ emailVerifiedAt: now }).where(and(eq(users.id, user.id), isNull(users.emailVerifiedAt)));
          await audit.append(tx, PLATFORM_ORG_KEY, {
            actorKind: 'user',
            actorId: user.id,
            actorIpHash: hex(cl.ipHash),
            actorUa: cl.ua,
            action: 'auth.email_verified',
            resourceType: 'user',
            resourceId: user.id,
            outcome: 'success',
            requestId: request.id,
          });
        },
      });
      clearSignupCookie(reply);
      return result;
    },
  );

  /**
   * A password sign-in at an account whose `auth_account` budget is spent (many attempts from many places): the
   * same answer whether the password was right or not, and a sign-in link goes to the address only when it was. The
   * owner still gets in; a guesser learns nothing more.
   */
  async function stepUp(request: FastifyRequest, cl: ClientInfo, user: AuthUser, emailNorm: string) {
    await deniedLogin(request, { userId: user.id, reason: 'step_up_link', method: 'password', stepUp: true });
    if (await c.throttle.spent(request, mailLimit(c, emailNorm), { ipHash: cl.ipHash, userId: user.id })) return { status: 'link_sent' as const };
    const mail = await withUser(c.db, { userId: user.id, requestId: request.id }, async (tx) => {
      if (!user.emailVerifiedAt) return (await verificationMail(c, tx, user)).mail;
      const token = await issueToken(tx, { userId: user.id, purpose: 'magic_link', minutes: LINK_MINUTES.magic_link, now: c.now() });
      await audit.append(tx, PLATFORM_ORG_KEY, {
        actorKind: 'user',
        actorId: user.id,
        actorIpHash: hex(cl.ipHash),
        actorUa: cl.ua,
        action: 'auth.magic_link_sent',
        resourceType: 'user',
        resourceId: user.id,
        outcome: 'success',
        reason: 'step_up',
        requestId: request.id,
      });
      return { kind: 'magic_link' as const, to: { address: user.email }, link: linkFor(c, 'magic_link', token) };
    });
    c.mail.send(mail);
    return { status: 'link_sent' as const };
  }

  r.post(
    '/v1/auth/login',
    {
      config: { auth: 'none' },
      schema: {
        tags,
        summary: 'Sign in with email and password',
        description:
          'Answers `mfa_required` with a 5-minute ticket when the account has TOTP on. Errors are generic and take the same time. Once the account has seen many attempts from many places, answers `link_sent` whatever the password, and mails a sign-in link when it was right.',
        body: z.object({ email: emailSchema, password: passwordSchema }),
        response: { 200: signInResult },
      },
    },
    async (request, reply) => {
      const emailNorm = normaliseEmail(request.body.email);
      const cl = client(c, request);
      await c.throttle.hit(request, reply, [loginLimit(c, cl, emailNorm)], { ipHash: cl.ipHash });
      const spent = await c.throttle.spent(request, accountBudget(c, emailNorm), { ipHash: cl.ipHash });
      const user = await authUserByEmail(c.db, emailNorm);
      const ok = await verifyPassword(user?.passwordHash ?? null, request.body.password);
      if (!user || !ok || user.status !== 'active') {
        const reason = !user ? 'unknown_user' : !user.passwordHash ? 'no_password' : !ok ? 'bad_password' : `user_${user.status}`;
        await deniedLogin(request, { userId: user?.id ?? null, reason, method: 'password', stepUp: spent });
        if (spent) return { status: 'link_sent' as const };
        throw new ProblemError('INVALID_CREDENTIALS', 'The email address or password is not right.', undefined, { audited: true });
      }
      if (spent) return stepUp(request, cl, user, emailNorm);
      if (!user.emailVerifiedAt) {
        if (!(await c.throttle.spent(request, mailLimit(c, emailNorm), { ipHash: cl.ipHash, userId: user.id }))) {
          const { mail, proof } = await withUser(c.db, { userId: user.id, requestId: request.id }, (tx) => verificationMail(c, tx, user));
          setSignupCookie(reply, proof);
          c.mail.send(mail);
        }
        await deniedLogin(request, { userId: user.id, reason: 'email_not_verified', method: 'password' });
        throw new ProblemError('EMAIL_NOT_VERIFIED', 'Confirm your email address first: we sent you a new link.', undefined, { audited: true });
      }
      return completeFirstFactor(c, request, reply, { user, factor: 'pwd', method: 'password', presented: await presentedAccount(c, request) });
    },
  );

  r.post(
    '/v1/auth/logout',
    { config: { auth: 'account' }, schema: { tags, summary: 'Sign out: revoke this session', response: { 204: z.null() } } },
    async (request, reply) => {
      const account = accountOf(request);
      const cl = client(c, request);
      if (!account.session) {
        // The development header: no session to revoke, still a sign-out on record.
        await withUser(c.db, { userId: account.userId, requestId: request.id }, (tx) =>
          audit.append(tx, PLATFORM_ORG_KEY, {
            actorKind: 'user',
            actorId: account.userId,
            sessionId: null,
            actorIpHash: hex(cl.ipHash),
            actorUa: cl.ua,
            action: 'auth.logout',
            resourceType: 'session',
            resourceId: null,
            outcome: 'success',
            requestId: request.id,
            metadata: { devHeader: true },
          }),
        );
      } else {
        const sessionId = account.session.id;
        await withUser(c.db, { userId: account.userId, requestId: request.id }, async (tx) => {
          await revokeSession(tx, sessionId, 'logout', c.now());
          await audit.append(tx, PLATFORM_ORG_KEY, {
            actorKind: 'user',
            actorId: account.userId,
            sessionId,
            actorIpHash: hex(cl.ipHash),
            actorUa: cl.ua,
            action: 'auth.logout',
            resourceType: 'session',
            resourceId: sessionId,
            outcome: 'success',
            requestId: request.id,
          });
        });
      }
      clearSessionCookie(reply);
      return reply.code(204).send(null);
    },
  );

  r.post(
    '/v1/auth/magic-link',
    {
      config: { auth: 'none' },
      schema: { tags, summary: 'Email a 15-minute single-use sign-in link', body: z.object({ email: emailSchema }), response: { 202: accepted } },
    },
    async (request, reply) => {
      const emailNorm = normaliseEmail(request.body.email);
      const cl = client(c, request);
      await c.throttle.hit(request, reply, [loginLimit(c, cl, emailNorm)], { ipHash: cl.ipHash });
      await c.throttle.hit(request, reply, [mailLimit(c, emailNorm)], { ipHash: cl.ipHash }, MAIL_LIMIT_DETAIL);
      const user = await authUserByEmail(c.db, emailNorm);
      if (user?.status === 'active') {
        const token = await withUser(c.db, { userId: user.id, requestId: request.id }, async (tx) => {
          const t = await issueToken(tx, { userId: user.id, purpose: 'magic_link', minutes: LINK_MINUTES.magic_link, now: c.now() });
          await audit.append(tx, PLATFORM_ORG_KEY, {
            actorKind: 'user',
            actorId: user.id,
            actorIpHash: hex(cl.ipHash),
            actorUa: cl.ua,
            action: 'auth.magic_link_sent',
            resourceType: 'user',
            resourceId: user.id,
            outcome: 'success',
            requestId: request.id,
          });
          return t;
        });
        c.mail.send({ kind: 'magic_link', to: { address: user.email }, link: linkFor(c, 'magic_link', token) });
      } else {
        await audit.appendDetached(c.auditDb, null, {
          actorKind: 'none',
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'auth.magic_link_sent',
          resourceType: 'user',
          resourceId: user?.id ?? null,
          outcome: 'denied',
          reason: user ? `user_${user.status}` : 'unknown_user',
          requestId: request.id,
        });
      }
      return reply.code(202).send({ status: 'link_sent' });
    },
  );

  r.post(
    '/v1/auth/magic-link/verify',
    { config: { auth: 'none' }, schema: { tags, summary: 'Sign in with an emailed link', body: z.object({ token: tokenSchema }), response: { 200: signInResult } } },
    async (request, reply) => {
      const taken = await authTokenTake(c.db, tokenHash(request.body.token), 'magic_link');
      const user = taken ? await authUserCredentials(c.db, taken.userId) : null;
      if (!taken || !user || user.status !== 'active') {
        await deniedLogin(request, { userId: taken?.userId ?? null, reason: taken ? 'user_inactive' : 'invalid_token', method: 'magic_link' });
        throw new ProblemError('INVALID_TOKEN', 'This sign-in link is invalid or has expired. Ask for a new one.', undefined, { audited: true });
      }
      const now = c.now();
      return completeFirstFactor(c, request, reply, {
        user: { ...user, emailVerifiedAt: user.emailVerifiedAt ?? now },
        factor: 'link',
        method: 'magic_link',
        presented: await presentedAccount(c, request),
        // Following the link proves the address too. An account that was never verified may have been opened by
        // someone else with this address, so its password goes (the owner can set one with a reset).
        inTx: async (tx) => {
          await tx.update(users).set({ emailVerifiedAt: now, passwordHash: null }).where(and(eq(users.id, user.id), isNull(users.emailVerifiedAt)));
        },
      });
    },
  );

  r.post(
    '/v1/auth/password/forgot',
    { config: { auth: 'none' }, schema: { tags, summary: 'Email a 1-hour password reset link', body: z.object({ email: emailSchema }), response: { 202: accepted } } },
    async (request, reply) => {
      const emailNorm = normaliseEmail(request.body.email);
      const cl = client(c, request);
      await c.throttle.hit(request, reply, [loginLimit(c, cl, emailNorm)], { ipHash: cl.ipHash });
      await c.throttle.hit(request, reply, [mailLimit(c, emailNorm)], { ipHash: cl.ipHash }, MAIL_LIMIT_DETAIL);
      const user = await authUserByEmail(c.db, emailNorm);
      if (user?.status === 'active') {
        const token = await withUser(c.db, { userId: user.id, requestId: request.id }, async (tx) => {
          const t = await issueToken(tx, { userId: user.id, purpose: 'password_reset', minutes: LINK_MINUTES.password_reset, now: c.now() });
          await audit.append(tx, PLATFORM_ORG_KEY, {
            actorKind: 'user',
            actorId: user.id,
            actorIpHash: hex(cl.ipHash),
            actorUa: cl.ua,
            action: 'auth.password_reset_requested',
            resourceType: 'user',
            resourceId: user.id,
            outcome: 'success',
            requestId: request.id,
          });
          return t;
        });
        c.mail.send({ kind: 'password_reset', to: { address: user.email }, link: linkFor(c, 'password_reset', token) });
      } else {
        await audit.appendDetached(c.auditDb, null, {
          actorKind: 'none',
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'auth.password_reset_requested',
          resourceType: 'user',
          resourceId: user?.id ?? null,
          outcome: 'denied',
          reason: user ? `user_${user.status}` : 'unknown_user',
          requestId: request.id,
        });
      }
      return reply.code(202).send({ status: 'link_sent' });
    },
  );

  r.post(
    '/v1/auth/password/reset',
    {
      config: { auth: 'none' },
      schema: {
        tags,
        summary: 'Set a new password with a reset link; every session is revoked',
        body: z.object({ token: tokenSchema, password: passwordSchema }),
        response: { 200: z.object({ status: z.literal('password_reset') }) },
      },
    },
    async (request) => {
      const cl = client(c, request);
      const denied = async (userId: string | null, reason: string) =>
        audit.appendDetached(c.auditDb, null, {
          actorKind: userId ? 'user' : 'none',
          actorId: userId,
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'auth.password_reset',
          resourceType: 'user',
          resourceId: userId,
          outcome: 'denied',
          reason,
          requestId: request.id,
        });
      // Checked before the link is used up, so a refused password does not cost the user their link.
      const early = await passwordProblem(request.body.password, { email: '', breached: c.breached });
      if (early) {
        await denied(null, `weak_password:${early}`);
        throw new ProblemError('WEAK_PASSWORD', PASSWORD_PROBLEMS[early]);
      }
      const taken = await authTokenTake(c.db, tokenHash(request.body.token), 'password_reset');
      const user = taken ? await authUserCredentials(c.db, taken.userId) : null;
      if (!taken || !user || user.status !== 'active') {
        await denied(taken?.userId ?? null, taken ? 'user_inactive' : 'invalid_token');
        throw new ProblemError('INVALID_TOKEN', 'This reset link is invalid or has expired. Ask for a new one.');
      }
      const personal = await passwordProblem(request.body.password, { email: normaliseEmail(user.email) });
      if (personal) {
        await denied(user.id, `weak_password:${personal}`);
        throw new ProblemError('WEAK_PASSWORD', `${PASSWORD_PROBLEMS[personal]} Ask for a new reset link.`);
      }
      const passwordHash = await hashPassword(request.body.password);
      const now = c.now();
      await withUser(c.db, { userId: user.id, requestId: request.id }, async (tx) => {
        await tx.update(users).set({ passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? now }).where(eq(users.id, user.id));
        const revoked = await revokeOtherSessions(tx, null, 'password_reset', now);
        await audit.append(tx, PLATFORM_ORG_KEY, {
          actorKind: 'user',
          actorId: user.id,
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'auth.password_reset',
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'success',
          requestId: request.id,
          metadata: { sessionsRevoked: revoked.length },
        });
      });
      return { status: 'password_reset' as const };
    },
  );

  /** The ticket's user and first factor, counting the attempt; refused tickets and throttled users never reach a code check. */
  async function ticketUser(request: FastifyRequest, reply: FastifyReply, ticket: string, method: 'totp' | 'recovery_code') {
    const t = await authMfaTicket(c.db, tokenHash(ticket));
    if (!t) {
      await deniedLogin(request, { userId: null, reason: 'invalid_ticket', method });
      throw new ProblemError('INVALID_TOKEN', 'The sign-in attempt expired. Start again.', undefined, { audited: true });
    }
    await secondFactorAttempt(c, request, reply, t.userId);
    const user = await authUserCredentials(c.db, t.userId);
    if (!user || user.status !== 'active' || !user.totpEnabledAt) {
      await deniedLogin(request, { userId: t.userId, reason: !user || user.status !== 'active' ? 'user_inactive' : 'totp_off', method });
      throw new ProblemError('INVALID_TOKEN', 'The sign-in attempt expired. Start again.', undefined, { audited: true });
    }
    const factor = (FIRST_FACTORS as readonly string[]).includes(String(t.data.factor)) ? (t.data.factor as FirstFactor) : 'pwd';
    const firstMethod = typeof t.data.method === 'string' ? t.data.method : 'password';
    return { user, factor, firstMethod };
  }

  async function finishSecondFactor(
    request: FastifyRequest,
    reply: FastifyReply,
    o: {
      ticket: string;
      user: AuthCredentials;
      level: MfaLevel;
      method: 'totp' | 'recovery_code';
      firstMethod: string;
      recoveryCodesLeft?: number;
      ticketTaken?: boolean;
    },
  ) {
    const cl = client(c, request);
    const now = c.now();
    // The ticket is single-use: a second request with it, even with a good code, finds nothing.
    if (!o.ticketTaken && !(await authTokenTake(c.db, tokenHash(o.ticket), 'mfa'))) {
      await deniedLogin(request, { userId: o.user.id, reason: 'invalid_ticket', method: o.method });
      throw new ProblemError('INVALID_TOKEN', 'The sign-in attempt expired. Start again.', undefined, { audited: true });
    }
    const account = await presentedAccount(c, request);
    const session = await withUser(c.db, { userId: o.user.id, requestId: request.id }, async (tx) => {
      if (account?.session && account.userId === o.user.id) await revokeSession(tx, account.session.id, 'rotated', now);
      const s = await issueSession(tx, { userId: o.user.id, mfaLevel: o.level, client: cl, now });
      await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, o.user.id));
      await audit.append(tx, PLATFORM_ORG_KEY, {
        actorKind: 'user',
        actorId: o.user.id,
        sessionId: s.id,
        actorIpHash: hex(cl.ipHash),
        actorUa: cl.ua,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: o.user.id,
        outcome: 'success',
        requestId: request.id,
        metadata: { method: o.firstMethod, mfaLevel: o.level, recoveryCodesLeft: o.recoveryCodesLeft ?? null },
      });
      return s;
    });
    setSessionCookie(reply, session);
    return {
      status: 'signed_in' as const,
      user: toMe(o.user),
      ...(o.recoveryCodesLeft !== undefined ? { recoveryCodesLeft: o.recoveryCodesLeft } : {}),
    };
  }

  r.post(
    '/v1/auth/mfa/totp',
    { config: { auth: 'none' }, schema: { tags, summary: 'Second factor: a TOTP code for an MFA ticket', body: ticketSchema, response: { 200: signInResult } } },
    async (request, reply) => {
      const { ticket, code } = request.body;
      const { user, factor, firstMethod } = await ticketUser(request, reply, ticket, 'totp');
      const step = await checkTotp(user, code);
      if (step === null || !(await claimStep(request, user.id, step))) {
        await deniedLogin(request, { userId: user.id, reason: step === null ? 'bad_totp' : 'totp_replayed', method: 'totp' });
        throw new ProblemError('INVALID_CODE', 'That code is not right. Check your authenticator app and try again.', undefined, { audited: true });
      }
      return finishSecondFactor(request, reply, { ticket, user, level: `${factor}+totp`, method: 'totp', firstMethod });
    },
  );

  r.post(
    '/v1/auth/mfa/recovery',
    { config: { auth: 'none' }, schema: { tags, summary: 'Second factor: a single-use recovery code for an MFA ticket', body: ticketSchema, response: { 200: signInResult } } },
    async (request, reply) => {
      const { ticket, code } = request.body;
      const { user, factor, firstMethod } = await ticketUser(request, reply, ticket, 'recovery_code');
      const normalised = normaliseRecoveryCode(code);
      // The ticket and the code go together or not at all: a code is never used up without the sign-in it buys, and a
      // wrong code leaves the ticket for another try.
      const left = await c.db
        .transaction(async (tx) => {
          if (!(await authTokenTake(tx, tokenHash(ticket), 'mfa'))) return 'invalid_ticket' as const;
          const n = RECOVERY_CODE.test(normalised) ? await authRecoveryCodeUse(tx, user.id, hashRecoveryCode(normalised)) : null;
          if (n === null) tx.rollback();
          return n as number;
        })
        .catch((err: unknown) => {
          if (err instanceof TransactionRollbackError) return null;
          throw err;
        });
      if (left === 'invalid_ticket') {
        await deniedLogin(request, { userId: user.id, reason: 'invalid_ticket', method: 'recovery_code' });
        throw new ProblemError('INVALID_TOKEN', 'The sign-in attempt expired. Start again.', undefined, { audited: true });
      }
      if (left === null) {
        await deniedLogin(request, { userId: user.id, reason: 'bad_recovery_code', method: 'recovery_code' });
        throw new ProblemError('INVALID_CODE', 'That recovery code is not right, or it was used already.', undefined, { audited: true });
      }
      return finishSecondFactor(request, reply, { ticket, user, level: `${factor}+recovery`, method: 'recovery_code', firstMethod, recoveryCodesLeft: left, ticketTaken: true });
    },
  );

  const requireKeys = () => {
    if (!c.keys) throw new ProblemError('SERVICE_UNAVAILABLE', 'Two-factor sign-in needs a key provider (KMS_KEYFILE_PATH).');
    return c.keys;
  };

  async function checkTotp(user: AuthCredentials, code: string): Promise<number | null> {
    if (!user.totpSecretEnc) return null;
    const secret = await openTotpSecret(requireKeys(), user.id, user.totpSecretEnc);
    return verifyTotp(secret, code, c.now(), user.totpLastStep);
  }

  /** Records the accepted step in the user's row; false when another request took it (or a later one) first. */
  async function claimStep(request: FastifyRequest, userId: string, step: number): Promise<boolean> {
    const rows = await withUser(c.db, { userId, requestId: request.id }, (tx) =>
      tx
        .update(users)
        .set({ totpLastStep: step })
        .where(and(eq(users.id, userId), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
        .returning({ id: users.id }),
    );
    return rows.length === 1;
  }

  async function me(request: FastifyRequest): Promise<{ account: Account; user: AuthCredentials }> {
    const account = accountOf(request);
    const user = await authUserCredentials(c.db, account.userId);
    if (!user || user.status !== 'active') throw new ProblemError('UNAUTHENTICATED');
    return { account, user };
  }

  r.post(
    '/v1/auth/mfa/totp/setup',
    {
      config: { auth: 'account' },
      schema: {
        tags,
        summary: 'Start TOTP enrolment: a new secret for an authenticator app',
        response: { 200: z.object({ secret: z.string(), otpauthUri: z.string() }) },
      },
    },
    async (request) => {
      const { account, user } = await me(request);
      if (user.totpEnabledAt) return mfaDenied(request, account, 'enable', 'already_enabled', new ProblemError('MFA_ALREADY_ENABLED', undefined, undefined, { audited: true }));
      await requireRecentSignIn(request, account);
      const secret = newTotpSecret();
      const sealed = await sealTotpSecret(requireKeys(), user.id, secret);
      const cl = client(c, request);
      await withUser(c.db, { userId: user.id, requestId: request.id }, async (tx) => {
        await tx.update(users).set({ totpSecretEnc: sealed, totpLastStep: null }).where(eq(users.id, user.id));
        await audit.append(tx, PLATFORM_ORG_KEY, {
          actorKind: 'user',
          actorId: user.id,
          sessionId: account.session?.id ?? null,
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'auth.totp_setup',
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'success',
          requestId: request.id,
        });
      });
      return { secret: base32Encode(secret), otpauthUri: otpauthUri({ issuer: c.config.auth.totpIssuer, account: user.email, secret }) };
    },
  );

  /**
   * A refused enrolment, disabling or recovery-code refresh: audited, then a wrong code (401) unless said otherwise.
   * One call per event code: the audit lint wants a literal action at every call site (the catalogue test reads them).
   */
  const mfaDenied = async (request: FastifyRequest, account: Account, action: 'enable' | 'disable' | 'recovery_codes', reason: string, problem?: ProblemError): Promise<never> => {
    const cl = client(c, request);
    const actorIpHash = hex(cl.ipHash);
    const sessionId = account.session?.id ?? null;
    const { userId } = account;
    if (action === 'enable') {
      await audit.appendDetached(c.auditDb, null, { actorKind: 'user', actorId: userId, sessionId, actorIpHash, actorUa: cl.ua, action: 'auth.totp_enabled', resourceType: 'user', resourceId: userId, outcome: 'denied', reason, requestId: request.id });
    } else if (action === 'disable') {
      await audit.appendDetached(c.auditDb, null, { actorKind: 'user', actorId: userId, sessionId, actorIpHash, actorUa: cl.ua, action: 'auth.totp_disabled', resourceType: 'user', resourceId: userId, outcome: 'denied', reason, requestId: request.id });
    } else {
      await audit.appendDetached(c.auditDb, null, { actorKind: 'user', actorId: userId, sessionId, actorIpHash, actorUa: cl.ua, action: 'auth.recovery_codes_issued', resourceType: 'user', resourceId: userId, outcome: 'denied', reason, requestId: request.id });
    }
    throw problem ?? new ProblemError('INVALID_CODE', 'That code is not right. Check your authenticator app and try again.', undefined, { audited: true });
  };

  /** Setting up an authenticator needs a recent sign-in; the development header has no session to age. */
  const requireRecentSignIn = async (request: FastifyRequest, account: Account): Promise<void> => {
    const s = account.session;
    if (!s || c.now().getTime() - s.createdAt.getTime() <= RECENT_SIGN_IN_MINUTES * 60_000) return;
    const detail = `Sign in again to turn on two-factor sign-in: it needs a sign-in from the last ${RECENT_SIGN_IN_MINUTES} minutes.`;
    await mfaDenied(request, account, 'enable', 'reauth_required', new ProblemError('REAUTH_REQUIRED', detail, undefined, { audited: true }));
  };

  r.post(
    '/v1/auth/mfa/totp/verify',
    {
      config: { auth: 'account' },
      schema: {
        tags,
        summary: 'Finish TOTP enrolment with a code; returns 10 recovery codes, once',
        description: 'Rotates the session (a privilege change) and signs out every other session.',
        body: z.object({ code: codeSchema }),
        response: { 200: z.object({ recoveryCodes: z.array(z.string()) }) },
      },
    },
    async (request, reply) => {
      const { account, user } = await me(request);
      if (user.totpEnabledAt) return mfaDenied(request, account, 'enable', 'already_enabled', new ProblemError('MFA_ALREADY_ENABLED', undefined, undefined, { audited: true }));
      if (!user.totpSecretEnc) return mfaDenied(request, account, 'enable', 'not_set_up', new ProblemError('MFA_NOT_ENABLED', 'Start the set-up first.', undefined, { audited: true }));
      await requireRecentSignIn(request, account);
      await secondFactorAttempt(c, request, reply, user.id);
      const step = await checkTotp(user, request.body.code);
      if (step === null) return mfaDenied(request, account, 'enable', 'bad_totp');
      const { codes, hashes } = newRecoveryCodes();
      const cl = client(c, request);
      const now = c.now();
      const rotated = await withUser(c.db, { userId: user.id, requestId: request.id }, async (tx) => {
        await tx.update(users).set({ totpEnabledAt: now, totpLastStep: step, recoveryCodeHashes: hashes }).where(eq(users.id, user.id));
        const next = account.session
          ? await rotateSession(tx, {
              userId: user.id,
              oldSessionId: account.session.id,
              mfaLevel: `${firstFactorOf(account.session.mfaLevel)}+totp`,
              client: cl,
              activeOrgId: account.session.activeOrgId,
              now,
            })
          : null;
        const revoked = await revokeOtherSessions(tx, next?.id ?? null, 'mfa_enabled', now);
        if (revoked.length > 0) {
          await audit.append(tx, PLATFORM_ORG_KEY, {
            actorKind: 'user',
            actorId: user.id,
            sessionId: next?.id ?? null,
            actorIpHash: hex(cl.ipHash),
            actorUa: cl.ua,
            action: 'auth.session_revoked',
            resourceType: 'session',
            resourceId: null,
            outcome: 'success',
            reason: 'mfa_enabled',
            requestId: request.id,
            metadata: { sessionIds: revoked },
          });
        }
        await audit.append(tx, PLATFORM_ORG_KEY, {
          actorKind: 'user',
          actorId: user.id,
          sessionId: next?.id ?? null,
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'auth.totp_enabled',
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'success',
          requestId: request.id,
          metadata: { recoveryCodes: codes.length },
        });
        return next;
      });
      if (rotated) setSessionCookie(reply, rotated);
      return { recoveryCodes: codes };
    },
  );

  /** A TOTP code (claimed, so it cannot be replayed) or, when the authenticator is lost, a recovery code (used up). */
  async function checkSecondFactor(request: FastifyRequest, user: AuthCredentials, code: string): Promise<'totp' | 'recovery' | null> {
    const recovery = normaliseRecoveryCode(code);
    if (RECOVERY_CODE.test(recovery)) return (await authRecoveryCodeUse(c.db, user.id, hashRecoveryCode(recovery))) === null ? null : 'recovery';
    const step = await checkTotp(user, code);
    return step !== null && (await claimStep(request, user.id, step)) ? 'totp' : null;
  }

  r.post(
    '/v1/auth/mfa/totp/disable',
    {
      config: { auth: 'account' },
      schema: {
        tags,
        summary: 'Turn TOTP off with a current code or a recovery code',
        body: z.object({ code: codeSchema }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const { account, user } = await me(request);
      if (!user.totpEnabledAt) return mfaDenied(request, account, 'disable', 'not_enabled', new ProblemError('MFA_NOT_ENABLED', undefined, undefined, { audited: true }));
      await secondFactorAttempt(c, request, reply, user.id);
      const used = await checkSecondFactor(request, user, request.body.code);
      if (!used) return mfaDenied(request, account, 'disable', 'bad_code');
      const cl = client(c, request);
      const now = c.now();
      const rotated = await withUser(c.db, { userId: user.id, requestId: request.id }, async (tx) => {
        await tx.update(users).set({ totpEnabledAt: null, totpSecretEnc: null, totpLastStep: null, recoveryCodeHashes: null }).where(eq(users.id, user.id));
        const next = account.session
          ? await rotateSession(tx, {
              userId: user.id,
              oldSessionId: account.session.id,
              mfaLevel: firstFactorOf(account.session.mfaLevel),
              client: cl,
              activeOrgId: account.session.activeOrgId,
              now,
            })
          : null;
        await audit.append(tx, PLATFORM_ORG_KEY, {
          actorKind: 'user',
          actorId: user.id,
          sessionId: next?.id ?? null,
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'auth.totp_disabled',
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'success',
          requestId: request.id,
          metadata: { factorUsed: used },
        });
        return next;
      });
      if (rotated) setSessionCookie(reply, rotated);
      return reply.code(204).send(null);
    },
  );

  r.post(
    '/v1/auth/mfa/recovery-codes',
    {
      config: { auth: 'account' },
      schema: {
        tags,
        summary: 'Replace the recovery codes; needs a current TOTP code',
        body: z.object({ code: codeSchema }),
        response: { 200: z.object({ recoveryCodes: z.array(z.string()) }) },
      },
    },
    async (request, reply) => {
      const { account, user } = await me(request);
      if (!user.totpEnabledAt) return mfaDenied(request, account, 'recovery_codes', 'not_enabled', new ProblemError('MFA_NOT_ENABLED', undefined, undefined, { audited: true }));
      await secondFactorAttempt(c, request, reply, user.id);
      const step = await checkTotp(user, request.body.code);
      if (step === null || !(await claimStep(request, user.id, step))) return mfaDenied(request, account, 'recovery_codes', 'bad_totp');
      const { codes, hashes } = newRecoveryCodes();
      const cl = client(c, request);
      await withUser(c.db, { userId: user.id, requestId: request.id }, async (tx) => {
        await tx.update(users).set({ recoveryCodeHashes: hashes }).where(eq(users.id, user.id));
        await audit.append(tx, PLATFORM_ORG_KEY, {
          actorKind: 'user',
          actorId: user.id,
          sessionId: account.session?.id ?? null,
          actorIpHash: hex(cl.ipHash),
          actorUa: cl.ua,
          action: 'auth.recovery_codes_issued',
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'success',
          requestId: request.id,
          metadata: { recoveryCodes: codes.length },
        });
      });
      return { recoveryCodes: codes };
    },
  );
}
