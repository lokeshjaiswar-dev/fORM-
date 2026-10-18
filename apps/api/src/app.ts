import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import underPressure from '@fastify/under-pressure';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { DestinationStream } from 'pino';
import { createDb, type DbHandle } from '@form/db';
import { cachedClockCheck, createLogger, type ClockStatus } from '@form/observability';
import { DEV_USER_HEADER, ORG_HEADER, registerAuth } from './auth.ts';
import type { ApiConfig } from './config.ts';
import { registerErrorHandling, sendProblem } from './errors.ts';
import { formRoutes } from './routes/forms.ts';
import { healthRoutes } from './routes/health.ts';

export interface AppDeps {
  /** Defaults to a pool on `config.database.url`, closed with the app. */
  db?: DbHandle;
  clock?: () => Promise<ClockStatus>;
  /** Log destination (tests); stdout by default. */
  logStream?: DestinationStream;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
export const BODY_LIMIT = 1024 * 1024;

/** The HTTP application without listening, so tests and the OpenAPI emitter can build it. */
export async function buildApp(config: ApiConfig, deps: AppDeps = {}): Promise<FastifyInstance> {
  const logger = createLogger({ level: config.logLevel, name: 'fr-api', base: { service: config.telemetry.serviceName } }, deps.logStream);
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    trustProxy: config.trustProxy,
    bodyLimit: BODY_LIMIT,
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
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
  await app.register(underPressure, {
    maxEventLoopDelay: 1000,
    maxEventLoopUtilization: 0.98,
    retryAfter: 5,
    pressureHandler: (_request, reply) => {
      reply.header('retry-after', '5');
      sendProblem(reply, 'SERVICE_UNAVAILABLE', 'The server is overloaded; retry shortly.');
    },
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'fORM- API', version: '0.0.0', description: 'Builder and app API (/v1). Internal until the public API ships (P2).' },
      components: {
        securitySchemes: {
          devUser: { type: 'apiKey', in: 'header', name: 'X-FR-Dev-User', description: 'Development stub until sign-in (WP-1.01).' },
          org: { type: 'apiKey', in: 'header', name: 'X-FR-Org', description: 'Active org, validated with membership_for().' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  const handle =
    deps.db ??
    createDb(config.database.url, {
      max: config.database.poolMax,
      applicationName: 'fr-api',
      onError: (err) => app.log.error({ err }, 'idle database connection failed'),
    });
  if (!deps.db) app.addHook('onClose', () => handle.close());

  registerAuth(app, { db: handle.db, devHeaders: config.authDevHeaders });
  healthRoutes(app, {
    ping: async () => {
      await handle.pool.query('select 1');
    },
    clock: deps.clock ?? cachedClockCheck({ servers: config.ntp.servers, maxOffsetMs: config.ntp.maxOffsetMs, ttlMs: 60_000 }),
  });
  formRoutes(app, { db: handle.db });
  app.get('/v1/openapi.json', { config: { auth: 'none' }, schema: { hide: true } }, async () => app.swagger());

  return app;
}
