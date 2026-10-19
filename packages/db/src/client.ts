import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { auditArchives, auditCheckpoints, auditHeads, auditLog, auditPending, formDrafts, forms, memberships, orgs, users } from './schema/index.ts';

export const tables = { orgs, users, memberships, forms, formDrafts, auditPending, auditLog, auditHeads, auditCheckpoints, auditArchives };

export type Tables = typeof tables;
export type Db = NodePgDatabase<Tables>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that can run a statement: the pool-backed `Db` or a transaction. */
export type Executor = Pick<Db, 'execute'>;

export interface DbOptions {
  max?: number;
  applicationName?: string;
  /** Per-statement limit on the server, in ms. */
  statementTimeoutMs?: number;
  /** How long a checkout waits for a free or new connection before failing (default 10 s; BL-036). */
  connectionTimeoutMs?: number;
  /** Errors on idle pooled connections (server restarts, network); unhandled they would crash the process. */
  onError?: (err: Error) => void;
}

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(url: string, options: DbOptions = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'form',
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
    ...(options.statementTimeoutMs ? { statement_timeout: options.statementTimeoutMs } : {}),
  });
  pool.on('error', (err) => options.onError?.(err));
  const db = drizzle({ client: pool, schema: tables });
  return { db, pool, close: () => pool.end() };
}
