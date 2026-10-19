import type { FastifyInstance } from 'fastify';
import { scrubUrl } from '@form/observability';
import { z } from 'zod';
import { ProblemError } from '../errors.ts';

export const CSP_REPORT_PATH = '/v1/csp-reports';
export const CSP_REPORT_BODY_LIMIT = 64 * 1024;
/** `report-uri` sends `application/csp-report`; the Reporting API (`report-to`) sends `application/reports+json`. */
const REPORT_TYPES = ['application/csp-report', 'application/reports+json'];
const MAX_PER_REQUEST = 20;

export interface CspViolation {
  directive: string;
  disposition: 'enforce' | 'report';
  /** An origin, a scheme (`data`, `blob`) or a keyword (`inline`, `eval`, `trusted-types-sink`); never a full URL. */
  blocked: string;
  /** Scrubbed like request URLs (§3.2): no query values, no tokens in paths. */
  document: string;
  source?: string;
  line?: number;
}

export interface CspReportDeps {
  now?: () => number;
  /** Violations logged per minute and process; the rest are counted and dropped, so a page cannot flood the logs. */
  maxPerMinute?: number;
}

const KEYWORD = /^[a-z][a-z0-9-]{0,39}$/;

function blockedOf(v: unknown): string {
  if (typeof v !== 'string' || v === '') return 'none';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v)?.[1]?.toLowerCase();
  if (!scheme) return KEYWORD.test(v) ? v : 'other';
  if (scheme === 'http' || scheme === 'https' || scheme === 'ws' || scheme === 'wss') {
    try {
      return new URL(v).origin;
    } catch {
      return scheme;
    }
  }
  return scheme;
}

const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const urlOf = (v: unknown) => {
  const s = text(v);
  return s && /^https?:\/\//i.test(s) ? scrubUrl(s) : undefined;
};

function violationOf(body: Record<string, unknown>): CspViolation | null {
  const directive = text(body.effectiveDirective) ?? text(body['effective-directive']) ?? text(body['violated-directive'])?.split(' ')[0];
  const document = urlOf(body.documentURL) ?? urlOf(body['document-uri']);
  if (!directive || !KEYWORD.test(directive) || !document) return null;
  const source = urlOf(body.sourceFile) ?? urlOf(body['source-file']);
  const line = body.lineNumber ?? body['line-number'];
  return {
    directive,
    disposition: body.disposition === 'report' ? 'report' : 'enforce',
    blocked: blockedOf(body.blockedURL ?? body['blocked-uri']),
    document,
    ...(source ? { source } : {}),
    ...(typeof line === 'number' && Number.isInteger(line) && line >= 0 ? { line } : {}),
  };
}

/** Both report formats, reduced to what is safe to log. `sample` (script or markup text) is never kept. */
export function cspViolations(payload: unknown): CspViolation[] | null {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  let bodies: Record<string, unknown>[];
  if (Array.isArray(payload)) {
    bodies = payload.filter((r) => isObject(r) && r.type === 'csp-violation' && isObject(r.body)).map((r) => (r as { body: Record<string, unknown> }).body);
  } else if (isObject(payload) && isObject(payload['csp-report'])) {
    bodies = [payload['csp-report']];
  } else {
    return null;
  }
  return bodies
    .slice(0, MAX_PER_REQUEST)
    .map(violationOf)
    .filter((v): v is CspViolation => v !== null);
}

/**
 * `POST /v1/csp-reports`: Content-Security-Policy violation reports from the builder (FND-20; SOC 2 control 14 in
 * architecture §8). No session: browsers send reports without cookies. Each violation is one `warn` log line.
 */
export async function cspReportRoutes(app: FastifyInstance, deps: CspReportDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now;
  const maxPerMinute = deps.maxPerMinute ?? 600;
  let window = { start: now(), logged: 0, dropped: 0 };

  await app.register(async (scope) => {
    scope.addContentTypeParser(REPORT_TYPES, { parseAs: 'string', bodyLimit: CSP_REPORT_BODY_LIMIT }, scope.getDefaultJsonParser('error', 'error'));

    scope.post(
      CSP_REPORT_PATH,
      {
        bodyLimit: CSP_REPORT_BODY_LIMIT,
        config: { auth: 'none', csrf: false },
        schema: { tags: ['security'], summary: 'Receive Content-Security-Policy violation reports', response: { 204: z.null().describe('Accepted') } },
      },
      async (request, reply) => {
        const violations = cspViolations(request.body);
        if (violations === null) throw new ProblemError('BAD_REQUEST', 'Expected a CSP violation report.');
        const t = now();
        if (t - window.start >= 60_000) {
          if (window.dropped > 0) request.log.warn({ dropped: window.dropped }, 'csp violation reports dropped');
          window = { start: t, logged: 0, dropped: 0 };
        }
        for (const csp of violations) {
          if (window.logged >= maxPerMinute) {
            window.dropped += 1;
            continue;
          }
          window.logged += 1;
          request.log.warn({ csp }, 'csp violation');
        }
        return reply.code(204).send();
      },
    );
  });
}
