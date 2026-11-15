import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import type { Db } from '@form/db';
import { scrubUrl } from '@form/observability';
import { auditProblem, type DenialAudit } from './audit.ts';
import { ACCESS_PROBLEMS } from './problems/access.ts';
import { FORMS_PROBLEMS } from './problems/forms.ts';
import { PUBLISH_PROBLEMS } from './problems/publish.ts';
import type { ProblemSpec } from './problems/spec.ts';
import { SUBMISSIONS_PROBLEMS } from './problems/submissions.ts';
import { SUBMIT_PROBLEMS } from './problems/submit.ts';

/**
 * The problem codes of auth, accounts, orgs, members and the generic HTTP failures, plus the drafts and form-lifecycle
 * codes that predate the per-domain files. Domains still being built (forms, publish, access, submit, submissions) list
 * their codes in `problems/*.ts`, so parallel work packages do not edit the same lines of this file.
 */
export const CORE_PROBLEMS = {
  BAD_REQUEST: { status: 400, title: 'Bad request' },
  VALIDATION_FAILED: { status: 400, title: 'Validation failed' },
  INVALID_TOKEN: { status: 400, title: 'The link or ticket is invalid or has expired' },
  UNAUTHENTICATED: { status: 401, title: 'Authentication required' },
  INVALID_CREDENTIALS: { status: 401, title: 'The email address or password is not right' },
  INVALID_CODE: { status: 401, title: 'The code is not right' },
  PASSWORD_REQUIRED: { status: 401, title: 'Enter your password to continue' },
  FORBIDDEN: { status: 403, title: 'Forbidden' },
  CSRF_REJECTED: { status: 403, title: 'Cross-site request refused' },
  EMAIL_NOT_VERIFIED: { status: 403, title: 'The email address is not verified yet' },
  REAUTH_REQUIRED: { status: 403, title: 'Sign in again to continue' },
  DATA_ROUTE_FORBIDDEN: { status: 403, title: 'Routing data needs the data.route permission' },
  INVITE_EMAIL_MISMATCH: { status: 403, title: 'The invitation is for another email address' },
  NOT_FOUND: { status: 404, title: 'Not found' },
  METHOD_NOT_ALLOWED: { status: 405, title: 'Method not allowed' },
  DRAFT_REV_CONFLICT: { status: 409, title: 'The draft changed since it was read' },
  FORM_OUTDATED: { status: 409, title: 'The form changed since the page was loaded' },
  SLUG_TAKEN: { status: 409, title: 'The org address is taken' },
  ALREADY_MEMBER: { status: 409, title: 'Already a member of the org' },
  LAST_OWNER: { status: 409, title: 'An org needs at least one owner' },
  LOCK_VIOLATION: { status: 409, title: 'The change touches locked template content' },
  MFA_ALREADY_ENABLED: { status: 409, title: 'Two-factor sign-in is already on' },
  MFA_NOT_ENABLED: { status: 409, title: 'Two-factor sign-in is not on' },
  NOTICE_OUTDATED: { status: 409, title: 'The privacy notice has changed' },
  ACCOUNT_DELETION_BLOCKED: { status: 409, title: 'The account cannot be deleted yet' },
  INVITE_UNAVAILABLE: { status: 410, title: 'The invitation is no longer valid' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Payload too large' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'Unsupported media type' },
  FEATURE_UNAVAILABLE: { status: 422, title: 'Feature unavailable in this edition or plan' },
  NOTICE_NOT_APPROVED: { status: 422, title: 'The privacy notice is not approved' },
  PLAN_LIMIT_REACHED: { status: 422, title: 'Plan limit reached' },
  WEAK_PASSWORD: { status: 422, title: 'Choose a stronger password' },
  CONFIRMATION_MISMATCH: { status: 422, title: 'The confirmation does not match' },
  RATE_LIMITED: { status: 429, title: 'Too many requests' },
  INTERNAL: { status: 500, title: 'Internal error' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Service unavailable' },
} as const satisfies Record<string, ProblemSpec>;

/**
 * The closed code enum of problem+json errors (architecture §3.2). Later work packages add their codes to their domain's
 * file under `problems/`; `problems.test.ts` checks that no code is listed twice, because a spread would let the later
 * file silently win.
 */
export const PROBLEMS = {
  ...CORE_PROBLEMS,
  ...FORMS_PROBLEMS,
  ...PUBLISH_PROBLEMS,
  ...ACCESS_PROBLEMS,
  ...SUBMIT_PROBLEMS,
  ...SUBMISSIONS_PROBLEMS,
} as const satisfies Record<string, ProblemSpec>;

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
  /** For a 403 raised before the tenant context exists: who to file the denied record under. */
  readonly denial: DenialAudit | undefined;
  /** The route wrote its own, more specific audit record (auth events); the error handler adds none. */
  readonly audited: boolean;

  constructor(code: ProblemCode, detail?: string, denial?: DenialAudit, o: { audited?: boolean } = {}) {
    super(detail ?? PROBLEMS[code].title);
    this.name = 'ProblemError';
    this.code = code;
    this.detail = detail;
    this.denial = denial;
    this.audited = o.audited ?? false;
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

/** SQLSTATEs for text that cannot be stored: 22021 (invalid byte sequence for UTF-8, a NUL), 22P05 (untranslatable character, `\u0000` in jsonb). */
const UNSTORABLE_TEXT = new Set(['22021', '22P05']);

interface Outcome {
  code: ProblemCode;
  detail?: string | undefined;
  errors?: FieldIssue[];
  denial?: DenialAudit | undefined;
  audited?: boolean;
}

function classify(err: FastifyError, request: FastifyRequest): Outcome {
  if (err instanceof ProblemError) return { code: err.code, detail: err.detail, denial: err.denial, audited: err.audited };
  if (hasZodFastifySchemaValidationErrors(err)) {
    const errors = err.validation.map((v) => ({ path: `${err.validationContext ?? ''}${v.instancePath}`, message: v.message ?? 'invalid' }));
    return { code: 'VALIDATION_FAILED', errors };
  }
  if (isResponseSerializationError(err)) {
    request.log.error({ err }, 'response did not match its schema');
    return { code: 'INTERNAL' };
  }
  // Text Postgres cannot store (a NUL, a byte sequence that is not UTF-8, a lone surrogate in jsonb) is the request's
  // fault, not the server's. The routes check for it first; this is the net under any route that does not. The log
  // line carries the SQLSTATE and the place, never the text (see `loggableError`).
  const sqlState = (err as { cause?: { code?: unknown } }).cause?.code ?? (err as { code?: unknown }).code;
  if (typeof sqlState === 'string' && UNSTORABLE_TEXT.has(sqlState)) {
    request.log.warn({ err }, 'the database refused text it cannot store');
    return { code: 'VALIDATION_FAILED', detail: 'Some of the text contains a character that cannot be stored.' };
  }
  const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
  if (status >= 500) {
    request.log.error({ err }, 'request failed');
    return { code: BY_STATUS[status] ?? 'INTERNAL' };
  }
  return { code: BY_STATUS[status] ?? 'BAD_REQUEST', detail: err.message };
}

/**
 * Every error leaves as problem+json; 5xx details are logged, never returned. A 403 is audited as denied and a
 * 5xx as an error through `auditWriter`, the separate audit pool (ADR-0006, C-M7).
 */
export function registerErrorHandling(app: FastifyInstance, o: { auditWriter: Db }): void {
  app.setErrorHandler(async (err: FastifyError, request, reply) => {
    const out = classify(err, request);
    const { status } = PROBLEMS[out.code];
    if ((status === 403 || status >= 500) && !out.audited) {
      try {
        await auditProblem(o.auditWriter, request, status, out.code, out.denial);
      } catch (auditErr) {
        request.log.error({ err: auditErr, status, code: out.code }, 'audit record of a refused or failed request was not written');
      }
    }
    return sendProblem(reply, out.code, out.detail, out.errors);
  });

  app.setNotFoundHandler((request, reply) => sendProblem(reply, 'NOT_FOUND', `No route for ${request.method} ${scrubUrl(request.url).split('?')[0]}`));
}
