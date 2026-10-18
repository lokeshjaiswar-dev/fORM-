import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { scrubUrl } from '@form/observability';

/** The closed code enum of problem+json errors (architecture §3.2). Later work packages add their codes here. */
export const PROBLEMS = {
  BAD_REQUEST: { status: 400, title: 'Bad request' },
  VALIDATION_FAILED: { status: 400, title: 'Validation failed' },
  UNAUTHENTICATED: { status: 401, title: 'Authentication required' },
  FORBIDDEN: { status: 403, title: 'Forbidden' },
  DATA_ROUTE_FORBIDDEN: { status: 403, title: 'Routing data needs the data.route permission' },
  NOT_FOUND: { status: 404, title: 'Not found' },
  METHOD_NOT_ALLOWED: { status: 405, title: 'Method not allowed' },
  DRAFT_REV_CONFLICT: { status: 409, title: 'The draft changed since it was read' },
  LOCK_VIOLATION: { status: 409, title: 'The change touches locked template content' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Payload too large' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'Unsupported media type' },
  FEATURE_UNAVAILABLE: { status: 422, title: 'Feature unavailable in this edition or plan' },
  NOTICE_NOT_APPROVED: { status: 422, title: 'The privacy notice is not approved' },
  PLAN_LIMIT_REACHED: { status: 422, title: 'Plan limit reached' },
  RATE_LIMITED: { status: 429, title: 'Too many requests' },
  INTERNAL: { status: 500, title: 'Internal error' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Service unavailable' },
} as const satisfies Record<string, { status: number; title: string }>;

export type ProblemCode = keyof typeof PROBLEMS;

export interface FieldIssue {
  path: string;
  message: string;
}

/** RFC 9457 problem details. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  detail?: string;
  instance: string;
  requestId: string;
  errors?: FieldIssue[];
}

export class ProblemError extends Error {
  readonly code: ProblemCode;
  readonly detail: string | undefined;

  constructor(code: ProblemCode, detail?: string) {
    super(detail ?? PROBLEMS[code].title);
    this.name = 'ProblemError';
    this.code = code;
    this.detail = detail;
  }
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

export function problemOf(request: FastifyRequest, code: ProblemCode, detail?: string, errors?: FieldIssue[]): Problem {
  const { status, title } = PROBLEMS[code];
  return {
    type: `urn:form:problem:${code.toLowerCase().replace(/_/g, '-')}`,
    title,
    status,
    code,
    ...(detail ? { detail } : {}),
    instance: scrubUrl(request.url),
    requestId: request.id,
    ...(errors?.length ? { errors } : {}),
  };
}

export function sendProblem(reply: FastifyReply, code: ProblemCode, detail?: string, errors?: FieldIssue[]): FastifyReply {
  const body = problemOf(reply.request, code, detail, errors);
  return reply.code(body.status).type(PROBLEM_CONTENT_TYPE).send(body);
}

const BY_STATUS: Record<number, ProblemCode> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

/** Every error leaves as problem+json; 5xx details are logged, never returned. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof ProblemError) return sendProblem(reply, err.code, err.detail);
    if (hasZodFastifySchemaValidationErrors(err)) {
      const issues = err.validation.map((v) => ({ path: `${err.validationContext ?? ''}${v.instancePath}`, message: v.message ?? 'invalid' }));
      return sendProblem(reply, 'VALIDATION_FAILED', undefined, issues);
    }
    if (isResponseSerializationError(err)) {
      request.log.error({ err }, 'response did not match its schema');
      return sendProblem(reply, 'INTERNAL');
    }
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err }, 'request failed');
      return sendProblem(reply, BY_STATUS[status] ?? 'INTERNAL');
    }
    return sendProblem(reply, BY_STATUS[status] ?? 'BAD_REQUEST', err.message);
  });

  app.setNotFoundHandler((request, reply) => sendProblem(reply, 'NOT_FOUND', `No route for ${request.method} ${scrubUrl(request.url).split('?')[0]}`));
}
