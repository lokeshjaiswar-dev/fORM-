import { auditPendingKeys, PLATFORM_ORG_KEY, type Db } from '@form/db';
import type { JobRequest, Queue } from '@form/ports';
import type { Logger } from 'pino';

export interface AuditDispatcherOptions {
  db: Db;
  queue: Pick<Queue, 'send'>;
  log: Logger;
  /** How often pending chains are listed (default 250 ms). */
  intervalMs?: number;
  /** Called after every tick with the oldest pending event's age, for metrics. */
  onTick?: (t: { chains: number; pending: number; oldestAgeMs: number }) => void;
  now?: () => number;
}

export interface AuditDispatcher {
  /** One pass now (tests); the timer keeps running. */
  tick(): Promise<void>;
  stop(): Promise<void>;
}

/** The `audit.chain` job of a chain: the resource is the chain itself, which resolve_job_org maps to its key. */
export const auditChainRequest = (orgKey: string): JobRequest<'audit.chain'> => ({ orgId: orgKey, resource: { type: 'audit_chain', id: orgKey }, data: {} });

/**
 * Keeps `audit.chain` moving (architecture §2.7: pending rows reach audit_log within seconds). Every tick lists
 * the chains with pending rows (`audit_pending_keys()`) and sends one job per key with the key as singleton:
 * the queue coalesces sends while one waits, and the head lock keeps one chainer per key working. Polling
 * instead of NOTIFY keeps commits of audited transactions free of the global notify lock.
 */
export function startAuditChainDispatcher(o: AuditDispatcherOptions): AuditDispatcher {
  const intervalMs = o.intervalMs ?? 250;
  const now = o.now ?? Date.now;
  let running: Promise<void> | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  async function pass(): Promise<void> {
    const chains = await auditPendingKeys(o.db);
    let pending = 0;
    let oldest = Number.POSITIVE_INFINITY;
    for (const c of chains) {
      pending += c.pending;
      oldest = Math.min(oldest, c.oldest.getTime());
    }
    // In parallel: a tick lasts one round trip, not one per pending chain.
    await Promise.all(chains.map((c) => o.queue.send('audit.chain', auditChainRequest(c.orgKey), { singletonKey: `audit.chain:${c.orgKey}` })));
    const oldestAgeMs = chains.length > 0 ? Math.max(0, now() - oldest) : 0;
    o.onTick?.({ chains: chains.length, pending, oldestAgeMs });
    if (oldestAgeMs > 60_000) o.log.warn({ chains: chains.length, pending, oldestAgeMs, platform: chains.some((c) => c.orgKey === PLATFORM_ORG_KEY) }, 'audit chain lag');
  }

  const tick = (): Promise<void> => {
    running ??= pass()
      .catch((err: unknown) => o.log.error({ err }, 'audit chain dispatch failed'))
      .finally(() => {
        running = null;
      });
    return running;
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void tick().finally(schedule), intervalMs);
  };
  schedule();

  return {
    tick,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
