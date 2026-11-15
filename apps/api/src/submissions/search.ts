import { txExecutor, type Tx } from '@form/db';
import type { SearchIndex, SqlExecutor } from '@form/ports';
import { ProblemError } from '../errors.ts';

/** Runs `fn` in the transaction the caller already holds, whatever org is named: the adapter's `TenantRunner`, bound by the route. */
export type SearchTenantRunner = <T>(orgId: string, fn: (sql: SqlExecutor) => Promise<T>) => Promise<T>;

/**
 * Makes the `SearchIndex` of the deployment over a transaction. Only the composition root (`main.ts`) may import an
 * adapter (the `adapters-only-from-composition-roots` rule), so it hands the app the Postgres adapter's constructor
 * (`createPostgresSearchIndex`) and the routes bind it to their own transaction, here.
 */
export type SearchIndexFactory = (o: { inTenant: SearchTenantRunner }) => SearchIndex;

/**
 * The search index working on `tx`: its reads and writes are part of the request's transaction, under its tenant
 * context, so a search sees the same snapshot as the page that uses it and a delete removes the documents with the rows
 * or not at all. An app built without a factory answers 503 for what needs one, before it changes or records anything.
 */
export function searchIndexOn(factory: SearchIndexFactory | undefined, tx: Tx): SearchIndex {
  if (!factory) throw new ProblemError('SERVICE_UNAVAILABLE', 'Searching and deleting responses are not available on this server.');
  return factory({ inTenant: (_orgId, fn) => fn(txExecutor(tx)) });
}
