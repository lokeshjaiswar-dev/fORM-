import type { FastifyInstance } from 'fastify';
import { client, type AuthCtx, type AuthModuleDeps } from './context.ts';
import { createAuthMailer } from './mail.ts';
import { meRoutes } from './me.ts';
import { oidcRoutes } from './oidc.ts';
import { authRoutes } from './routes.ts';

export type { AuthModuleDeps } from './context.ts';
export { createLogMailer } from './mail.ts';
export { hibpBreachCheck } from './passwords.ts';
export { createThrottle, DEFAULT_AUTH_LIMITS } from './throttle.ts';
export { CLIENT_BUILDER, CLIENT_HEADER, registerCsrfGuard } from './csrf.ts';
export { SESSION_COOKIE } from './sessions.ts';

/**
 * The auth module (WP-1.01, ADR-0017): `/v1/auth/*`, `/v1/me*`. Every auth request counts against the per-IP
 * `auth_any` bucket first; the routes add the per-account buckets. Emails in flight are awaited on close.
 */
export function registerAuthModule(app: FastifyInstance, deps: AuthModuleDeps): void {
  const mail = createAuthMailer({ mailer: deps.mailer, from: { address: deps.config.mailer.from.address, name: deps.config.mailer.from.name }, log: app.log });
  const { throttle } = deps;
  const c: AuthCtx = { ...deps, mail };

  // onRequest, so malformed requests count too. The CSRF guard runs first and counts the requests it refuses.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.routeOptions.url?.startsWith('/v1/auth/')) return;
    const cl = client(c, request);
    await throttle.hit(request, reply, [{ bucket: 'auth_any', key: cl.ipHash }], { ipHash: cl.ipHash });
  });
  app.addHook('onClose', () => mail.idle());

  authRoutes(app, c);
  oidcRoutes(app, c);
  meRoutes(app, c);
}
