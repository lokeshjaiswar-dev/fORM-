import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { disclosures, isUuidV7, pgArray, submissions, uuidV7Time, type Tx } from '@form/db';
import { ExportFailure } from './table.ts';

/*
 * Reading the responses of an export and writing its ledger rows (WP-1.17). The job calls these inside `inTenant`, one batch
 * per transaction, so RLS limits every read to the org and no transaction is open while the file is uploaded.
 */

/** Responses per batch (and per transaction). */
export const EXPORT_BATCH_SIZE = 2000;

/** Most ids a `selected` export may name; the API limits a request well below it, this only bounds what the worker will put in a query. */
export const MAX_SELECTED_IDS = 10_000;

const iso = z.string().min(1).max(64);

const ScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({ kind: z.literal('selected'), ids: z.array(z.string().max(64)).max(MAX_SELECTED_IDS) }),
  z.strictObject({ kind: z.literal('filtered'), from: iso.optional(), to: iso.optional() }),
]);

/** What an export covers, parsed from `exports.scope`: ids that are not UUIDv7 name no response and are dropped; `from` and `to` are inclusive instants. */
export type ParsedScope = { kind: 'all' } | { kind: 'selected'; ids: string[] } | { kind: 'filtered'; from?: Date; to?: Date };

function instant(value: string): Date {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new ExportFailure('invalid_scope', 'The export asked for a date range that is not valid.');
  return at;
}

/** `exports.scope` is jsonb the API wrote, but the worker does not take it on trust: anything else than the three shapes fails the export. */
export function parseScope(raw: unknown): ParsedScope {
  const parsed = ScopeSchema.safeParse(raw);
  if (!parsed.success) throw new ExportFailure('invalid_scope', 'The export asked for responses in a way that is not valid.');
  const scope = parsed.data;
  if (scope.kind === 'all') return { kind: 'all' };
  if (scope.kind === 'selected') return { kind: 'selected', ids: [...new Set(scope.ids.filter(isUuidV7))] };
  return { kind: 'filtered', ...(scope.from !== undefined ? { from: instant(scope.from) } : {}), ...(scope.to !== undefined ? { to: instant(scope.to) } : {}) };
}

/** The keyset position: the last response of the previous batch. */
export interface Cursor {
  receivedAt: Date;
  id: string;
}

export interface BatchRow {
  id: string;
  receivedAt: Date;
  formVersionId: string;
  answers: Record<string, unknown>;
}

/**
 * The next batch of responses in `(received_at, id)` order after `after`, never more than `limit`. Trashed responses are left
 * out whatever the scope says (a selected id in the trash is not exported). A keyset, not an offset, so a batch costs the same
 * at the end of a 100,000-row export as at the start, and a response that arrives meanwhile is simply in a later batch or not in this file.
 */
export async function readBatch(tx: Tx, o: { orgId: string; formId: string; scope: ParsedScope; after: Cursor | null; limit: number }): Promise<BatchRow[]> {
  const where: SQL[] = [eq(submissions.orgId, o.orgId), eq(submissions.formId, o.formId), isNull(submissions.trashedAt), ne(submissions.status, 'trashed')];
  const { scope } = o;
  if (scope.kind === 'selected') {
    if (scope.ids.length === 0) return [];
    // The id and the moment inside it (the partition key), so the planner reads only the months those ids are in.
    const times = scope.ids.map((id) => uuidV7Time(id)!.toISOString());
    where.push(sql`${submissions.id} = any (${pgArray(scope.ids)}::uuid[])`);
    where.push(sql`${submissions.receivedAt} = any (${pgArray([...new Set(times)])}::timestamptz[])`);
  } else if (scope.kind === 'filtered') {
    if (scope.from) where.push(sql`${submissions.receivedAt} >= ${scope.from.toISOString()}::timestamptz`);
    if (scope.to) where.push(sql`${submissions.receivedAt} <= ${scope.to.toISOString()}::timestamptz`);
  }
  if (o.after) where.push(sql`(${submissions.receivedAt}, ${submissions.id}) > (${o.after.receivedAt.toISOString()}::timestamptz, ${o.after.id}::uuid)`);
  const rows = await tx
    .select({ id: submissions.id, receivedAt: submissions.receivedAt, formVersionId: submissions.formVersionId, answers: submissions.answers })
    .from(submissions)
    .where(and(...where))
    .orderBy(asc(submissions.receivedAt), asc(submissions.id))
    .limit(o.limit);
  return rows;
}

export interface ExportDisclosure {
  submissionId: string;
  receivedAt: Date;
  /** The keys of the fields whose values are in the file; never values. */
  fieldKeys: readonly string[];
}

/**
 * One `disclosures` row per exported response (DPDP s.11(1)(b): the recipient is the export file, naming the fields that
 * went into it), written in the transaction that reads the batch, so there is no exported response without a row. A response
 * that already has a row for this export (an earlier attempt of the job got that far) gets no second one, so a retry leaves
 * one row per response. Rows are written in one statement per batch.
 */
export async function recordExportDisclosures(tx: Tx, o: { orgId: string; exportId: string; displayName: string; items: readonly ExportDisclosure[] }): Promise<number> {
  if (o.items.length === 0) return 0;
  const already = await tx
    .select({ submissionId: disclosures.submissionId })
    .from(disclosures)
    .where(
      and(
        eq(disclosures.recipientKind, 'export'),
        eq(disclosures.recipientId, o.exportId),
        inArray(
          disclosures.submissionId,
          o.items.map((i) => i.submissionId),
        ),
      ),
    );
  const have = new Set(already.map((r) => r.submissionId));
  const fresh = o.items.filter((i) => !have.has(i.submissionId));
  if (fresh.length === 0) return 0;
  await tx.insert(disclosures).values(
    fresh.map((i) => ({
      id: randomUUID(),
      orgId: o.orgId,
      submissionId: i.submissionId,
      submissionReceivedAt: i.receivedAt,
      recipientKind: 'export' as const,
      recipientId: o.exportId,
      displayName: o.displayName,
      fieldKeys: [...new Set(i.fieldKeys)],
    })),
  );
  return fresh.length;
}
