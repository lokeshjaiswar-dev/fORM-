import { chainPending } from '@form/db';
import { defineJob } from './define.ts';

/** `audit.chain` lag above this is logged as a warning (architecture §5.3 alerts at one minute). */
export const AUDIT_CHAIN_LAG_WARN_MS = 60_000;

/**
 * `audit.chain`, one job per org key (the zero key is the platform chain), enqueued by the dispatcher while the
 * key has pending rows. Runs in the tenant of the key as actor `system`; a concurrent job for the same key finds
 * the head taken and returns at once.
 */
export const auditChain = defineJob({
  name: 'audit.chain',
  perms: [],
  pollIntervalMs: 500,
  async run({ tx, orgId, log, job }) {
    const r = await chainPending(tx, orgId);
    job.signal.throwIfAborted();
    if (!r.acquired) {
      log.debug('audit chain held by another job');
      return;
    }
    if (r.chained > 0) {
      const fields = { chained: r.chained, headSeq: r.head?.seq, lagMs: Math.round(r.maxLagMs) };
      if (r.maxLagMs > AUDIT_CHAIN_LAG_WARN_MS) log.warn(fields, 'audit chain lagging');
      else log.debug(fields, 'audit chained');
    }
  },
});
