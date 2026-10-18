import { sql } from 'drizzle-orm';
import { appendAudit } from '@form/db';
import { defineJob } from './define.ts';

/**
 * Liveness through the whole path: queue, signature, org re-derivation, tenant context. With an org it reads the
 * orgs table under RLS (exactly its own row must be visible) and leaves an audit record; without one it pings
 * the database.
 */
export const heartbeat = defineJob({
  name: 'system.heartbeat',
  perms: [],
  cron: '*/5 * * * *',
  async run(ctx) {
    if (ctx.kind === 'system') {
      await ctx.db.execute(sql`select 1`);
      return;
    }
    const { rows } = await ctx.tx.execute<{ id: string }>(sql`select id from orgs`);
    if (rows.length !== 1 || rows[0]!.id !== ctx.orgId) throw new Error(`system.heartbeat: the tenant context shows ${rows.length} orgs`);
    await appendAudit(ctx.tx, ctx.orgId, {
      actorKind: 'system',
      action: 'system.heartbeat',
      resourceType: 'org',
      resourceId: ctx.orgId,
      outcome: 'success',
      requestId: `job:${ctx.job.id}`,
      metadata: { attempt: ctx.job.attempt },
    });
  },
});
