import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ClockStatus } from '@form/observability';
import { z } from 'zod';

export interface HealthDeps {
  /** Resolves when the database answers. */
  ping: () => Promise<void>;
  clock: () => Promise<ClockStatus>;
  timeoutMs?: number;
}

const check = z.object({ status: z.enum(['ok', 'failed', 'skipped']), detail: z.string().optional() });
const readiness = z.object({
  status: z.enum(['ok', 'unavailable']),
  checks: z.object({ db: check, clock: check.extend({ offsetMs: z.number().optional(), server: z.string().optional() }) }),
});

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)))]).finally(() =>
    clearTimeout(timer),
  );
}

/** `/livez`: the process runs. `/readyz`: the database answers and the clock is within the NTP limit (architecture §7.7). */
export function healthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const timeoutMs = deps.timeoutMs ?? 2000;

  r.get(
    '/livez',
    { config: { auth: 'none' }, schema: { tags: ['health'], summary: 'Liveness', response: { 200: z.object({ status: z.literal('ok') }) } } },
    async () => ({ status: 'ok' as const }),
  );

  r.get(
    '/readyz',
    { config: { auth: 'none' }, schema: { tags: ['health'], summary: 'Readiness', response: { 200: readiness, 503: readiness } } },
    async (request, reply) => {
      const [db, clock] = await Promise.all([
        within(deps.ping(), timeoutMs).then(
          () => ({ status: 'ok' as const }),
          (err: unknown) => {
            request.log.warn({ err }, 'readiness: database check failed');
            return { status: 'failed' as const, detail: 'database unreachable' };
          },
        ),
        deps.clock().then(
          (c) =>
            c.status === 'skipped'
              ? { status: 'skipped' as const }
              : c.status === 'ok'
                ? { status: 'ok' as const, offsetMs: c.offsetMs, server: c.server }
                : { status: 'failed' as const, detail: c.reason, ...(c.offsetMs === undefined ? {} : { offsetMs: c.offsetMs }) },
          (err: unknown) => ({ status: 'failed' as const, detail: err instanceof Error ? err.message : 'clock check failed' }),
        ),
      ]);
      const ok = db.status === 'ok' && clock.status !== 'failed';
      return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'unavailable', checks: { db, clock } });
    },
  );
}
