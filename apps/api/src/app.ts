import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import underPressure from '@fastify/under-pressure';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { DestinationStream } from 'pino';
import { createDb, type AuthThrottleBucket, type DbHandle } from '@form/db';
import { cachedClockCheck, createLogger, type ClockStatus } from '@form/observability';
import type { KeyProvider, Mailer } from '@form/ports';
import { clientInfo, DEV_USER_HEADER, ORG_HEADER, registerAuth } from './auth.ts';
import type { ApiConfig } from './config.ts';
import { registerErrorHandling, sendProblem } from './errors.ts';
import { cspReportRoutes, type CspReportDeps } from './routes/csp-reports.ts';
import { formRoutes } from './routes/forms.ts';
import { healthRoutes } from './routes/health.ts';
import { metaRoutes } from './routes/meta.ts';
import { createLogMailer, createThrottle, DEFAULT_AUTH_LIMITS, hibpBreachCheck, registerAuthModule, registerCsrfGuard } from './modules/auth/index.ts';
import { registerOrgModule } from './modules/orgs/index.ts';
import type { BreachCheck } from './modules/auth/passwords.ts';
import type { Limit } from './modules/auth/throttle.ts';

export interface AppDeps {
  /** Defaults to a pool on `config.database.url`, closed with the app. */
  db?: DbHandle;
  /** The small separate pool for denied and failed audit records (ADR-0006, BL-036); defaults like `db`. */
  auditDb?: DbHandle;
  clock?: () => Promise<ClockStatus>;
  /** Log destination (tests); stdout by default. */
  logStream?: DestinationStream;
  cspReports?: CspReportDeps;
  /** Sign-in emails (the composition root passes the SMTP adapter); default: the log mailer. */
  mailer?: Mailer;
  /** Wraps TOTP secrets (the composition root passes the KMS); without it, two-factor enrolment answers 503. */
  keys?: KeyProvider;
  /** Overrides the HIBP lookup that `PASSWORD_BREACH_CHECK=hibp` turns on; null turns it off. */
  breached?: BreachCheck | null;
  /** Overrides of the auth rate limits (tests). */
  authLimits?: Partial<Record<AuthThrottleBucket, Limit>>;
  /**
   * Event-loop back-pressure (503 past 1 s of loop delay); `false` turns it off for integration suites, whose
   * argon2id hashing and parallel test files would trip it on a loaded machine.
   */
  underPressure?: false;
  now?: () => Date;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
export const BODY_LIMIT = 1024 * 1024;

/** The HTTP application without listening, so tests and the OpenAPI emitter can build it. */
export async function buildApp(config: ApiConfig, deps: AppDeps = {}): Promise<FastifyInstance> {
  const logger = createLogger({ level: config.logLevel, name: 'fr-api', base: { service: config.telemetry.serviceName } }, deps.logStream);
  const { trustProxy } = config;
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    // A hop count trusts that many proxies nearest the API (Fastify's number form, which its types leave out).
    trustProxy: typeof trustProxy === 'number' ? (_addr: string, hop: number) => hop < trustProxy : trustProxy,
    bodyLimit: BODY_LIMIT,
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });

  const handle =
    deps.db ??
    createDb(config.database.url, {
      max: config.database.poolMax,
      applicationName: 'fr-api',
      onError: (err) => app.log.error({ err }, 'idle database connection failed'),
    });
  if (!deps.db) app.addHook('onClose', () => handle.close());
  const auditHandle =
    deps.auditDb ??
    createDb(config.database.url, {
      max: config.database.auditPoolMax,
      applicationName: 'fr-api-audit',
      connectionTimeoutMs: 5000,
      onError: (err) => app.log.error({ err }, 'idle audit database connection failed'),
    });
  if (!deps.auditDb) app.addHook('onClose', () => auditHandle.close());

  const now = deps.now ?? (() => new Date());
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app, { auditWriter: auditHandle.db });
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(helmet, {
    // A JSON API renders nothing: deny everything rather than helmet's page defaults.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'if-match', 'idempotency-key', 'x-fr-client', ORG_HEADER, 'x-request-id', ...(config.authDevHeaders ? [DEV_USER_HEADER] : [])],
    exposedHeaders: ['x-request-id', 'etag'],
    maxAge: 600,
  });
  await app.register(cookie);
  if (deps.underPressure !== false) {
    await app.register(underPressure, {
      maxEventLoopDelay: 1000,
      maxEventLoopUtilization: 0.98,
      retryAfter: 5,
      pressureHandler: (_request, reply) => {
        reply.header('retry-after', '5');
        sendProblem(reply, 'SERVICE_UNAVAILABLE', 'The server is overloaded; retry shortly.');
      },
    });
  }
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'fORM- API', version: '0.0.0', description: 'Builder and app API (/v1). Internal until the public API ships (P2).' },
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: '__Host-fr_sess', description: 'Session cookie; unsafe methods also need `X-FR-Client: builder` (ADR-0008).' },
          devUser: { type: 'apiKey', in: 'header', name: 'X-FR-Dev-User', description: 'Tests and local development only (AUTH_DEV_HEADERS); refused in production.' },
          org: { type: 'apiKey', in: 'header', name: 'X-FR-Org', description: 'Active org, validated with membership_for().' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  const throttle = createThrottle({ db: handle.db, auditDb: auditHandle.db, limits: { ...DEFAULT_AUTH_LIMITS, ...deps.authLimits }, now });
  // A refused request never reaches the auth module's own count of `/v1/auth/*` requests, so it is counted here.
  registerCsrfGuard(app, {
    builderOrigins: config.corsOrigins,
    devHeader: config.authDevHeaders ? DEV_USER_HEADER : null,
    refused: async (request, reply) => {
      const { ipHash } = clientInfo(request, config.auth.secret, now());
      await throttle.hit(request, reply, [{ bucket: 'auth_any', key: ipHash }], { ipHash });
    },
  });
  registerAuth(app, {
    db: handle.db,
    auditDb: auditHandle.db,
    secret: config.auth.secret,
    devHeaders: config.authDevHeaders,
    // `/v1/auth/*` and `/v1/invites/*` requests were counted on arrival already.
    throttleRejected: async (request, reply, ipHash) => {
      if (!/^\/v1\/(auth|invites)\//.test(request.routeOptions.url ?? '')) await throttle.hit(request, reply, [{ bucket: 'auth_any', key: ipHash }], { ipHash });
    },
    now,
  });
  const mail = registerAuthModule(app, {
    db: handle.db,
    auditDb: auditHandle.db,
    config,
    mailer: deps.mailer ?? createLogMailer(app.log),
    keys: deps.keys,
    breached:
      deps.breached === null
        ? undefined
        : (deps.breached ?? (config.auth.breachCheck === 'hibp' ? hibpBreachCheck({ onError: (err) => app.log.warn({ err }, 'HIBP lookup failed') }) : undefined)),
    throttle,
    now,
  });
  registerOrgModule(app, { db: handle.db, auditDb: auditHandle.db, config, mail, now });
  healthRoutes(app, {
    ping: async () => {
      await handle.pool.query('select 1');
    },
    clock: deps.clock ?? cachedClockCheck({ servers: config.ntp.servers, maxOffsetMs: config.ntp.maxOffsetMs, ttlMs: 60_000 }),
  });
  formRoutes(app, { db: handle.db });
  metaRoutes(app, { edition: config.edition });
  await cspReportRoutes(app, deps.cspReports);
  app.get('/v1/openapi.json', { config: { auth: 'none' }, schema: { hide: true } }, async () => app.swagger());

  return app;
}
