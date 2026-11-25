import { randomUUID } from 'node:crypto';
import path from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import underPressure from '@fastify/under-pressure';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type RouteOptions } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { DestinationStream } from 'pino';
import { createDb, type AuthThrottleBucket, type DbHandle } from '@form/db';
import { cachedClockCheck, type ClockStatus } from '@form/observability';
import type { EgressGuard, KeyProvider, Mailer, OrgSecrets, Queue, Storage } from '@form/ports';
import { clientInfo, DEV_USER_HEADER, ORG_HEADER, registerAuth } from './auth.ts';
import type { ApiConfig } from './config.ts';
import { createServiceLogger } from './log.ts';
import { registerErrorHandling, sendProblem } from './errors.ts';
import { cspReportRoutes, type CspReportDeps } from './routes/csp-reports.ts';
import { createFileStore, type FileStore } from './files.ts';
import type { SearchIndexFactory } from './submissions/search.ts';
import { formFileRoutes } from './routes/form-files.ts';
import { accessRoutes } from './routes/access.ts';
import { emailSenderRoutes } from './routes/email-senders.ts';
import { exportRoutes } from './routes/exports.ts';
import { formRoutes } from './routes/forms.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { publicFormRoutes } from './routes/public.ts';
import { publicUnlockRoutes } from './routes/public-unlock.ts';
import { publicRemoteRoutes } from './routes/public-remote.ts';
import { apiCredentialRoutes } from './routes/api-credentials.ts';
import { remoteTestRoutes } from './routes/remote-test.ts';
import type { TenantHttp } from './remote/upstream.ts';
import { createVersionLoader } from './submit/live.ts';
import { editionSummary, runtimeEdition } from '@form/config';
import { publishRoutes } from './routes/publish.ts';
import { submissionRoutes } from './routes/submissions.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { healthRoutes } from './routes/health.ts';
import { metaRoutes } from './routes/meta.ts';
import { createLogMailer, createThrottle, DEFAULT_AUTH_LIMITS, hibpBreachCheck, registerAuthModule, registerCsrfGuard } from './modules/auth/index.ts';
import { registerOrgModule } from './modules/orgs/index.ts';
import { registerReviewModule } from './modules/reviews/index.ts';
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
  /**
   * Seals and opens the secrets of an org (the SMTP URL of an email sender, the signing key of a webhook) under the org's
   * key context. The composition root builds it with `createOrgSecrets(keys)` from `@form/adapters/kms`, the one place an
   * adapter may be imported; routes get it as this `@form/ports` interface. Without it the routes that store a secret answer 503.
   */
  orgSecrets?: OrgSecrets;
  /**
   * The egress guard for destinations a tenant supplies (a webhook URL, an org's own SMTP relay): EGRESS_POLICY and
   * EGRESS_ALLOWLIST only, with no trusted infrastructure hosts (the composition root builds it with `createTenantEgressGuard`).
   * Without it the webhook routes cannot check a URL and answer 503.
   */
  tenantEgress?: EgressGuard;
  /**
   * One HTTP request to an address a form's owner chose (a lookup, an option list or a check), through `tenantEgress`:
   * `(url, r) => egressHttp(tenantEgress, url, r)` in `main.ts`, so the routes import no adapter. Without it the lookup proxy and
   * the author's test route answer 503 `REMOTE_UNAVAILABLE`.
   */
  tenantHttp?: TenantHttp;
  /**
   * The mailer of one org: its own email senders (`email_senders.smtp_secret_id`, opened under that org's key) and the
   * platform relay when a message names no sender. Built in `org-mailer.ts` and passed by the composition root, which is
   * the only place the SMTP adapter may be imported. Without it the test send of an email sender answers 503.
   */
  orgMailer?: (orgId: string) => Mailer;
  /**
   * The object store the export worker writes finished files to and the export routes stream them from, after the auth check
   * and the audit record (the composition root opens it from `config.storage`). Without it the export routes answer 503.
   */
  storage?: Storage;
  /** Overrides the HIBP lookup that `PASSWORD_BREACH_CHECK=hibp` turns on; null turns it off. */
  breached?: BreachCheck | null;
  /** Overrides of the auth rate limits (tests). */
  authLimits?: Partial<Record<AuthThrottleBucket, Limit>>;
  /**
   * Event-loop back-pressure (503 past 1 s of loop delay); `false` turns it off for integration suites, whose
   * argon2id hashing and parallel test files would trip it on a loaded machine.
   */
  underPressure?: false;
  /**
   * Where respondent files are kept (tests); default `.data/files` under the working directory. The filesystem store is
   * temporary: the StoragePort/S3 adapter with presigned uploads and scanning replaces it in WP-1.14.
   */
  files?: FileStore;
  /**
   * Makes the full-text search index (the composition root passes `createPostgresSearchIndex`, the only place an adapter
   * may be imported); without it, searching responses and deleting them forever answer 503.
   */
  searchIndex?: SearchIndexFactory;
  /**
   * A producer queue (pg-boss through `createPgBossQueue({ mode: 'producer' })`; the composition root makes it, starts it
   * and stops it after the app closes). Every stored response sends one `submission.fanout` job through it, inside the
   * submit transaction, so it must run on the app's own database. Without it no job is sent, which only tests do.
   */
  queue?: Queue;
  now?: () => Date;
  /**
   * Called with every route as it is registered, including routes a test adds after `buildApp` returns (tests only). The
   * cross-org isolation suite lists them to find an `auth: 'user'` or `'account'` route that has no isolation case.
   */
  onRoute?: (route: RouteOptions) => void;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
export const BODY_LIMIT = 1024 * 1024;

/** The HTTP application without listening, so tests and the OpenAPI emitter can build it. */
export async function buildApp(config: ApiConfig, deps: AppDeps = {}): Promise<FastifyInstance> {
  const logger = createServiceLogger({ level: config.logLevel, name: 'fr-api', base: { service: config.telemetry.serviceName } }, deps.logStream);
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
  // Before any plugin or route, so the hook sees them all.
  if (deps.onRoute) app.addHook('onRoute', deps.onRoute);

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
    // content-disposition: the Responses page names a downloaded file by the server's header, not by the answer.
    exposedHeaders: ['x-request-id', 'etag', 'content-disposition'],
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
  formRoutes(app, { db: handle.db, secret: config.auth.secret, now });
  publishRoutes(app, { db: handle.db, secret: config.auth.secret, now });
  accessRoutes(app, { db: handle.db, auditDb: auditHandle.db, config, throttle, now });
  const files = deps.files ?? createFileStore(path.resolve(config.filesDir ?? path.resolve(process.cwd(), '.data/files')));
  // One loader for every public route: a published version never changes, so one cache serves all of them.
  const loader = createVersionLoader({ db: handle.db, edition: runtimeEdition(editionSummary(config.edition)) });
  publicFormRoutes(app, { db: handle.db, config, files, throttle, now, loader, effects: { searchIndex: deps.searchIndex, queue: deps.queue } });
  publicRemoteRoutes(app, { db: handle.db, config, throttle, loader, tenantHttp: deps.tenantHttp, orgSecrets: deps.orgSecrets, now });
  publicUnlockRoutes(app, { db: handle.db, auditDb: auditHandle.db, config, throttle, now });
  formFileRoutes(app, { db: handle.db, files, secret: config.auth.secret, now });
  submissionRoutes(app, { db: handle.db, files, secret: config.auth.secret, searchIndex: deps.searchIndex, now });
  // Approvals, notifications, webhooks and exports (WP-2.33, WP-1.16, WP-1.18, WP-1.17). Each module is registered here
  // once, empty, and its task fills its own files, so no feature task edits this list.
  registerReviewModule(app, { db: handle.db, auditDb: auditHandle.db, queue: deps.queue, keys: deps.keys, secret: config.auth.secret, now });
  apiCredentialRoutes(app, { db: handle.db, auditDb: auditHandle.db, orgSecrets: deps.orgSecrets, secret: config.auth.secret, now });
  remoteTestRoutes(app, { db: handle.db, throttle, tenantHttp: deps.tenantHttp, orgSecrets: deps.orgSecrets, secret: config.auth.secret, now });
  emailSenderRoutes(app, { db: handle.db, auditDb: auditHandle.db, orgSecrets: deps.orgSecrets, orgMailer: deps.orgMailer, secret: config.auth.secret, now });
  notificationRoutes(app, { db: handle.db, auditDb: auditHandle.db, secret: config.auth.secret, now });
  webhookRoutes(app, {
    db: handle.db,
    auditDb: auditHandle.db,
    orgSecrets: deps.orgSecrets,
    queue: deps.queue,
    tenantEgress: deps.tenantEgress,
    edition: config.edition,
    secret: config.auth.secret,
    now,
  });
  exportRoutes(app, { db: handle.db, auditDb: auditHandle.db, queue: deps.queue, storage: deps.storage, secret: config.auth.secret, now });
  metaRoutes(app, { edition: config.edition });
  await cspReportRoutes(app, deps.cspReports);
  app.get('/v1/openapi.json', { config: { auth: 'none' }, schema: { hide: true } }, async () => app.swagger());

  return app;
}
