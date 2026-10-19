import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as oidc from 'openid-client';
import {
  audit,
  authCreateUser,
  authIdentityUser,
  authUserByEmail,
  authUserCredentials,
  PLATFORM_ORG_KEY,
  userIdentities,
  users,
  withUser,
  type OAuthProvider,
} from '@form/db';
import { z } from 'zod';
import type { OidcProviderConfig } from '../../config.ts';
import { recordNoticeAck } from '../account/notice.ts';
import { client, completeFirstFactor, normaliseEmail, presentedAccount, type AuthCtx } from './context.ts';
import { equalBytes, hex, hmac } from './crypto.ts';

/**
 * The OAuth transaction between start and callback: state, nonce and PKCE verifier, signed, 10 minutes; `nv` is the
 * privacy notice version the builder showed next to the button, recorded if the callback creates the account.
 */
export const OAUTH_COOKIE = '__Host-fr_oauth';
const TRANSACTION_SECONDS = 600;

const transactionSchema = z.object({ p: z.enum(['google', 'microsoft']), s: z.string(), n: z.string(), v: z.string(), nv: z.string().optional(), exp: z.number() });
type Transaction = z.infer<typeof transactionSchema>;

function seal(secret: Uint8Array, t: Transaction): string {
  const body = Buffer.from(JSON.stringify(t)).toString('base64url');
  return `${body}.${Buffer.from(hmac(secret, `fr:oauth:v1:${body}`)).toString('base64url')}`;
}

function unseal(secret: Uint8Array, value: string | undefined, now: Date): Transaction | null {
  if (!value) return null;
  const [body, sig] = value.split('.');
  if (!body || !sig || !equalBytes(Buffer.from(sig, 'base64url'), hmac(secret, `fr:oauth:v1:${body}`))) return null;
  try {
    const t = transactionSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    return t.exp > now.getTime() ? t : null;
  } catch {
    return null;
  }
}

/** Google's `email_verified`; Microsoft Entra ID's `xms_edov` (email domain owner verified) or `email_verified`. */
function verifiedEmail(claims: oidc.IDToken): string | null {
  const email = typeof claims.email === 'string' ? claims.email : null;
  const verified = claims.email_verified === true || claims.xms_edov === true;
  return email && verified ? email : null;
}

/**
 * `GET /v1/auth/oauth/:provider/start` and `…/callback` (architecture §3.3): Google and Microsoft through
 * openid-client with PKCE, state and nonce, SaaS only. Registered only for configured providers, so an
 * on-prem or air-gapped deployment has no OAuth routes at all. An account is found by its linked identity, else
 * linked to the user with the same verified address, else created (verified, no password) when the start request
 * carried the current privacy notice version (`?notice=`), which is then recorded with the account. A user with TOTP on
 * still needs the second factor: the callback hands the builder an MFA ticket in the URL fragment.
 */
export function oidcRoutes(app: FastifyInstance, c: AuthCtx): void {
  const providers = Object.entries(c.config.auth.oidc) as Array<[OAuthProvider, OidcProviderConfig]>;
  if (providers.length === 0) return;
  const r = app.withTypeProvider<ZodTypeProvider>();
  const configs = new Map<OAuthProvider, Promise<oidc.Configuration>>();

  const configFor = (provider: OAuthProvider, p: OidcProviderConfig): Promise<oidc.Configuration> => {
    let cached = configs.get(provider);
    if (!cached) {
      const insecure = c.config.auth.oidcAllowInsecure && new URL(p.issuer).protocol === 'http:';
      cached = oidc.discovery(new URL(p.issuer), p.clientId, p.clientSecret, undefined, insecure ? { execute: [oidc.allowInsecureRequests] } : undefined);
      // A failed discovery is retried on the next sign-in rather than cached.
      cached.catch(() => configs.delete(provider));
      configs.set(provider, cached);
    }
    return cached;
  };
  const redirectUri = (provider: OAuthProvider) => `${c.config.auth.apiUrl}/v1/auth/oauth/${provider}/callback`;
  const toBuilder = (reply: FastifyReply, path: string) => reply.redirect(`${c.config.auth.builderUrl}${path}`, 303);
  const cookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'lax' as const };

  const denied = async (request: FastifyRequest, provider: OAuthProvider, reason: string, userId: string | null = null) => {
    const cl = client(c, request);
    await audit.appendDetached(c.auditDb, null, {
      actorKind: userId ? 'user' : 'none',
      actorId: userId,
      actorIpHash: hex(cl.ipHash),
      actorUa: cl.ua,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: userId,
      outcome: 'denied',
      reason,
      requestId: request.id,
      metadata: { method: `oauth_${provider}` },
    });
  };

  for (const [provider, p] of providers) {
    r.get(
      `/v1/auth/oauth/${provider}/start`,
      {
        config: { auth: 'none' },
        schema: {
          tags: ['auth'],
          summary: `Sign in with ${provider === 'google' ? 'Google' : 'Microsoft'}: redirect to the provider`,
          querystring: z.object({ notice: z.string().max(32).optional() }),
        },
      },
      async (request, reply) => {
        let config: oidc.Configuration;
        try {
          config = await configFor(provider, p);
        } catch (err) {
          request.log.error({ err, provider }, 'OIDC discovery failed');
          await denied(request, provider, 'oauth_unavailable');
          return toBuilder(reply, '/auth/sign-in#error=oauth_unavailable');
        }
        const t: Transaction = {
          p: provider,
          s: oidc.randomState(),
          n: oidc.randomNonce(),
          v: oidc.randomPKCECodeVerifier(),
          ...(request.query.notice ? { nv: request.query.notice } : {}),
          exp: c.now().getTime() + TRANSACTION_SECONDS * 1000,
        };
        const url = oidc.buildAuthorizationUrl(config, {
          redirect_uri: redirectUri(provider),
          scope: 'openid email profile',
          state: t.s,
          nonce: t.n,
          code_challenge: await oidc.calculatePKCECodeChallenge(t.v),
          code_challenge_method: 'S256',
          ...(provider === 'google' ? { prompt: 'select_account' } : {}),
        });
        reply.setCookie(OAUTH_COOKIE, seal(c.config.auth.secret, t), { ...cookieOptions, maxAge: TRANSACTION_SECONDS });
        return reply.redirect(url.href, 302);
      },
    );

    r.get(
      `/v1/auth/oauth/${provider}/callback`,
      { config: { auth: 'none' }, schema: { tags: ['auth'], summary: `Provider redirect back after ${provider === 'google' ? 'Google' : 'Microsoft'} sign-in` } },
      async (request, reply) => {
        const t = unseal(c.config.auth.secret, request.cookies[OAUTH_COOKIE], c.now());
        reply.clearCookie(OAUTH_COOKIE, cookieOptions);
        if (!t || t.p !== provider) {
          await denied(request, provider, 'oauth_no_transaction');
          return toBuilder(reply, '/auth/sign-in#error=oauth_failed');
        }
        let claims: oidc.IDToken | undefined;
        try {
          const config = await configFor(provider, p);
          const query = request.url.indexOf('?');
          const current = new URL(`${redirectUri(provider)}${query === -1 ? '' : request.url.slice(query)}`);
          const tokens = await oidc.authorizationCodeGrant(config, current, { pkceCodeVerifier: t.v, expectedState: t.s, expectedNonce: t.n, idTokenExpected: true });
          claims = tokens.claims();
        } catch (err) {
          request.log.warn({ err, provider }, 'OAuth callback refused');
          await denied(request, provider, 'oauth_refused');
          return toBuilder(reply, '/auth/sign-in#error=oauth_failed');
        }
        if (!claims?.sub) {
          await denied(request, provider, 'oauth_refused');
          return toBuilder(reply, '/auth/sign-in#error=oauth_failed');
        }
        const subject = claims.sub.slice(0, 255);
        const cl = client(c, request);
        const now = c.now();
        let userId = await authIdentityUser(c.db, provider, subject);
        let link = false;
        if (!userId) {
          const email = verifiedEmail(claims);
          if (!email) {
            await denied(request, provider, 'oauth_email_unverified');
            return toBuilder(reply, '/auth/sign-in#error=oauth_email_unverified');
          }
          const emailNorm = normaliseEmail(email);
          const existing = await authUserByEmail(c.db, emailNorm);
          if (existing) {
            userId = existing.id;
          } else {
            // A new account needs the notice the builder showed next to the button (CMP-21).
            if (t.nv !== c.notice.version) {
              await denied(request, provider, 'notice_required');
              return toBuilder(reply, '/auth/sign-in#error=oauth_notice');
            }
            const id = randomUUID();
            const name = typeof claims.name === 'string' ? claims.name.slice(0, 200) : null;
            await withUser(c.db, { userId: id, requestId: request.id }, async (tx) => {
              if (await authCreateUser(tx, { id, email, emailNorm, name, locale: null, passwordHash: null, emailVerified: true })) {
                await recordNoticeAck(tx, { userId: id, notice: c.notice, context: 'oauth_signup', client: cl });
              }
            });
            userId = (await authUserByEmail(c.db, emailNorm))?.id ?? id;
          }
          link = true;
        }
        const user = await authUserCredentials(c.db, userId);
        if (!user || user.status !== 'active') {
          await denied(request, provider, 'user_inactive', userId);
          return toBuilder(reply, '/auth/sign-in#error=oauth_failed');
        }
        const result = await completeFirstFactor(c, request, reply, {
          user: { ...user, emailVerifiedAt: user.emailVerifiedAt ?? now },
          factor: 'oauth',
          method: `oauth_${provider}`,
          presented: await presentedAccount(c, request),
          inTx: async (tx) => {
            // An unverified account may have been opened by someone else with this address: its password goes.
            await tx.update(users).set({ emailVerifiedAt: now, passwordHash: null }).where(and(eq(users.id, user.id), isNull(users.emailVerifiedAt)));
            if (!link) {
              await tx.update(userIdentities).set({ lastUsedAt: now }).where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, subject)));
              return;
            }
            await tx.insert(userIdentities).values({ id: randomUUID(), userId: user.id, provider, subject, lastUsedAt: now }).onConflictDoNothing();
            await audit.append(tx, PLATFORM_ORG_KEY, {
              actorKind: 'user',
              actorId: user.id,
              actorIpHash: hex(cl.ipHash),
              actorUa: cl.ua,
              action: 'auth.oauth_linked',
              resourceType: 'user',
              resourceId: user.id,
              outcome: 'success',
              requestId: request.id,
              metadata: { provider },
            });
          },
        });
        return result.status === 'mfa_required' ? toBuilder(reply, `/auth/mfa#ticket=${result.ticket}`) : toBuilder(reply, '/forms');
      },
    );
  }
}
