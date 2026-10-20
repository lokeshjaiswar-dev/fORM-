import type { SqlExecutor } from '@form/ports';

/**
 * Runs `fn` in one transaction scoped to `orgId`, so RLS applies to every statement. The composition root binds it
 * to `@form/db`: `(orgId, fn) => withTenant(db, { orgId, actor: 'system', requestId }, (tx) => fn(txExecutor(tx)))`.
 */
export type TenantRunner = <T>(orgId: string, fn: (sql: SqlExecutor) => Promise<T>) => Promise<T>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
