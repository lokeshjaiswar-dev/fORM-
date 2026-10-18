import { trace } from '@opentelemetry/api';
import { pino, stdSerializers, stdTimeFunctions, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { scrubUrl } from './scrub.ts';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'authorization',
  'cookie',
  'email',
  'phone',
  'answers',
  'body',
];

/** Auth headers, cookies, passwords, tokens, emails, phones, answers and bodies (architecture §7.7). */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((k) => `*.${k}`),
];

export const REDACTED = '[redacted]';

interface RequestLike {
  id?: unknown;
  method?: unknown;
  url?: unknown;
  routeOptions?: { url?: unknown };
}

interface ResponseLike {
  statusCode?: unknown;
}

/** No headers, no client address, and the URL scrubbed of query values and secret path segments. */
export const serializers = {
  req: (req: RequestLike) => ({
    id: req.id,
    method: req.method,
    url: typeof req.url === 'string' ? scrubUrl(req.url) : undefined,
    route: req.routeOptions?.url,
  }),
  res: (res: ResponseLike) => ({ statusCode: res.statusCode }),
  err: stdSerializers.err,
};

export interface LoggerConfig {
  level: LogLevel;
  name: string;
  base?: Record<string, unknown>;
}

export function loggerOptions(config: LoggerConfig): LoggerOptions {
  return {
    level: config.level,
    name: config.name,
    base: { ...config.base },
    timestamp: stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    serializers,
    mixin() {
      const span = trace.getActiveSpan();
      return span ? { traceId: span.spanContext().traceId } : {};
    },
  };
}

export function createLogger(config: LoggerConfig, destination?: DestinationStream): Logger {
  return destination ? pino(loggerOptions(config), destination) : pino(loggerOptions(config));
}
