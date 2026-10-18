import { sql } from 'drizzle-orm';
import type { Db, Tx } from './client.ts';

export const ACTOR_KINDS = ['user', 'api_key', 'respondent', 'system', 'platform'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];
export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface TenantCtx {
  orgId: string;
  actor: ActorKind;
  requestId: string;
  userId?: string | null | undefined;
  teamIds?: readonly string[] | undefined;
  perms?: readonly string[] | undefined;
  /** Respondent actors only: the submissions a verified signed token grants (architecture §2.2). */
  subjectIds?: readonly string[] | undefined;
  /** GETs run read-only unless they write an audit row. */
  readOnly?: boolean | undefined;
  isolation?: IsolationLevel | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERM = /^[a-z][a-z0-9_]*(\.[a-z0-9_*]+)*$/;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

/** A Postgres array literal: `{"a","b"}`. */
export function pgArray(items: readonly string[]): string {
  return `{${items.map((i) => `"${i.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

/** Rejects contexts that would make a policy raise or widen access, before any SQL runs. */
export function assertTenantCtx(ctx: TenantCtx): void {
  const bad = (msg: string) => {
    throw new TypeError(`withTenant: ${msg}`);
  };
  if (!isUuid(ctx.orgId)) bad('orgId must be a uuid');
  if (!(ACTOR_KINDS as readonly string[]).includes(ctx.actor)) bad(`unknown actor ${String(ctx.actor)}`);
  if (ctx.userId != null && !isUuid(ctx.userId)) bad('userId must be a uuid or null');
  if (ctx.actor === 'user' && ctx.userId == null) bad('a user actor needs a userId');
  if (ctx.teamIds?.some((t) => !isUuid(t))) bad('teamIds must be uuids');
  if (ctx.perms?.some((p) => !PERM.test(p))) bad('perms must be permission names');
  if (ctx.subjectIds?.length) {
    if (ctx.actor !== 'respondent') bad('subjectIds are for respondent actors only');
    if (ctx.subjectIds.some((s) => !isUuid(s))) bad('subjectIds must be uuids');
  }
  if (typeof ctx.requestId !== 'string' || ctx.requestId.length === 0 || ctx.requestId.length > 128) bad('requestId is required');
}

/**
 * Runs `fn` in one transaction with the tenant settings set transaction-locally (safe behind PgBouncer in
 * transaction mode). Every policy reads them through the null-safe `app_*()` helpers; outside this function
 * a query against a tenant table sees zero rows.
 */
export async function withTenant<T>(db: Db, ctx: TenantCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  assertTenantCtx(ctx);
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`select
        set_config('app.org_id', ${ctx.orgId}, true),
        set_config('app.user_id', ${ctx.userId ?? ''}, true),
        set_config('app.team_ids', ${pgArray(ctx.teamIds ?? [])}, true),
        set_config('app.perms', ${pgArray(ctx.perms ?? [])}, true),
        set_config('app.actor_kind', ${ctx.actor}, true),
        set_config('app.subject_ids', ${pgArray(ctx.subjectIds ?? [])}, true),
        set_config('app.request_id', ${ctx.requestId}, true)`);
      return fn(tx);
    },
    { isolationLevel: ctx.isolation ?? 'read committed', accessMode: ctx.readOnly ? 'read only' : 'read write' },
  );
}
