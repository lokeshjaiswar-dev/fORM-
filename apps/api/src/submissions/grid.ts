import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { auditReads, forms, isUuid, submissions, withTenant, type Db, type ReadClient, type SubmissionStatus, type TenantCtx, type Tx } from '@form/db';
import { ProblemError } from '../errors.ts';
import { readCursor, signCursor } from '../cursor.ts';
import { cellsOf, gridColumns, type GridColumn, type PlanLoader } from './plans.ts';
import { mayShow, reviewerViewOf, reviewOf, reviewSummaries, SEES_ALL, type RedactionLoader, type ReviewUnitSummary } from './review-view.ts';
import { searchIndexOn, type SearchIndexFactory } from './search.ts';
import type { View } from './schemas.ts';

/** What narrows the rows of a grid. `view` is always set; the rest only when the request named it. */
export interface GridFilters {
  view: View;
  status?: SubmissionStatus | undefined;
  read?: boolean | undefined;
  starred?: boolean | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  q?: string | undefined;
}

/** More than the view alone narrows the rows: what the audit record calls a filtered page. */
export const isFiltered = (f: GridFilters): boolean =>
  f.status !== undefined || f.read !== undefined || f.starred !== undefined || f.from !== undefined || f.to !== undefined || f.q !== undefined;

/**
 * Everything that changes which rows come in which order, and for whom: the cursor's signature covers it, so a cursor
 * cannot be carried to another form, another org, another filter or another member. (The page size is not in it: a client
 * may change `limit` between pages.)
 */
export function gridScope(orgId: string, userId: string | null | undefined, formId: string, f: GridFilters): string {
  return JSON.stringify([
    'submissions',
    orgId,
    userId ?? null,
    formId,
    f.view,
    f.status ?? null,
    f.read ?? null,
    f.starred ?? null,
    f.from?.toISOString() ?? null,
    f.to?.toISOString() ?? null,
    f.q ?? null,
  ]);
}

/** Where the next page starts: after a row, in time order, or after a hit, in a search; and the number of the page it makes. */
export type GridPosition = { kind: 'row'; receivedAt: string; id: string; page: number } | { kind: 'hit'; after: string; page: number };

const MAX_PAGE_NUMBER = 1_000_000;

/** The position a cursor holds, or `INVALID_CURSOR` for one this API did not sign for this exact query (never the first page instead). */
export function positionOf(secret: Uint8Array, scope: string, token: string, searching: boolean): GridPosition {
  const bad = () => new ProblemError('INVALID_CURSOR');
  const values = readCursor(secret, scope, token);
  if (!values) throw bad();
  const page = values.at(-1);
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 2 || page > MAX_PAGE_NUMBER) throw bad();
  if (searching) {
    const [after] = values;
    if (values.length !== 2 || typeof after !== 'string' || after.length === 0) throw bad();
    return { kind: 'hit', after, page };
  }
  const [receivedAt, id] = values;
  // The time must be exactly what `toISOString()` writes, so a cursor cannot name a moment two ways.
  if (values.length !== 3 || typeof receivedAt !== 'string' || Number.isNaN(Date.parse(receivedAt)) || new Date(receivedAt).toISOString() !== receivedAt || !isUuid(id)) throw bad();
  return { kind: 'row', receivedAt, id, page };
}

const columnsOfRow = {
  id: submissions.id,
  receivedAt: submissions.receivedAt,
  formVersionId: submissions.formVersionId,
  status: submissions.status,
  answers: submissions.answers,
  read: submissions.read,
  starred: submissions.starred,
  archivedAt: submissions.archivedAt,
  trashedAt: submissions.trashedAt,
};

type Row = {
  id: string;
  receivedAt: Date;
  formVersionId: string;
  status: SubmissionStatus;
  answers: Record<string, unknown>;
  read: boolean;
  starred: boolean;
  archivedAt: Date | null;
  trashedAt: Date | null;
};

/**
 * The conditions every grid read shares, search or not: the form, the view (the inbox leaves out the archive and the
 * trash, the archive leaves out the trash, the trash is the trashed), and the filters. `org_id` is named although row
 * level security already limits it, so the planner can use the grid index, whose first column it is.
 */
function conditions(orgId: string, formId: string, f: GridFilters): SQL[] {
  const out: SQL[] = [eq(submissions.orgId, orgId), eq(submissions.formId, formId)];
  if (f.view === 'trash') out.push(isNotNull(submissions.trashedAt));
  else {
    // The grid index is partial on `trashed_at is null`; saying so lets the planner use it.
    out.push(isNull(submissions.trashedAt));
    out.push(f.view === 'archived' ? isNotNull(submissions.archivedAt) : isNull(submissions.archivedAt));
  }
  if (f.status !== undefined) out.push(eq(submissions.status, f.status));
  if (f.read !== undefined) out.push(eq(submissions.read, f.read));
  if (f.starred !== undefined) out.push(eq(submissions.starred, f.starred));
  if (f.from) out.push(gte(submissions.receivedAt, f.from));
  if (f.to) out.push(lte(submissions.receivedAt, f.to));
  return out;
}

/** A search takes this many rounds at most to fill a page: filters can drop every hit of a round. */
const MAX_SEARCH_ROUNDS = 5;
/** The SearchIndex adapter's page limit. */
const MAX_HITS = 100;

/**
 * The rows that match the words, in order of relevance, and the position after the last hit used. The words go to the
 * Postgres SearchIndex adapter, scoped to this org and form; its hits are then intersected with the filters in SQL, so
 * a trashed or filtered-out response is never listed. A round asks the index for no more hits than the page still needs,
 * so the page never holds more than `limit` rows and the adapter's cursor after the last hit is where the next page
 * begins; a round whose hits were all filtered out is followed by another, up to `MAX_SEARCH_ROUNDS`, so a page is
 * short only when the budget ran out (the cursor still says there is more).
 *
 * The adapter runs on the same transaction as the read and the audit record: one connection, one snapshot.
 */
async function searchRows(
  tx: Tx,
  searchIndex: SearchIndexFactory | undefined,
  orgId: string,
  formId: string,
  f: GridFilters,
  limit: number,
  after: string | undefined,
): Promise<{ rows: Row[]; next: string | null }> {
  const index = searchIndexOn(searchIndex, tx);
  const rows: Row[] = [];
  let next: string | undefined;
  let cursor = after;
  for (let round = 0; round < MAX_SEARCH_ROUNDS; round += 1) {
    const result = await index.query(orgId, { formId, text: f.q!, limit: Math.min(limit - rows.length, MAX_HITS), ...(cursor === undefined ? {} : { after: cursor }) });
    next = result.next;
    if (result.hits.length > 0) {
      const times = result.hits.map((h) => Date.parse(h.receivedAt));
      const found = await tx
        .select(columnsOfRow)
        .from(submissions)
        .where(
          and(
            ...conditions(orgId, formId, f),
            inArray(submissions.id, result.hits.map((h) => h.submissionId)),
            // The id names its moment, so these bounds only let the planner skip the months with no hit.
            gte(submissions.receivedAt, new Date(Math.min(...times))),
            lte(submissions.receivedAt, new Date(Math.max(...times))),
          ),
        );
      const byId = new Map(found.map((row) => [row.id, row]));
      for (const hit of result.hits) {
        const row = byId.get(hit.submissionId);
        if (row) rows.push(row);
      }
    }
    if (next === undefined || rows.length >= limit) break;
    cursor = next;
  }
  return { rows, next: next ?? null };
}

export interface GridDeps {
  db: Db;
  secret: Uint8Array;
  plans: PlanLoader;
  /** Makes the search index of the deployment; without it a search answers 503. */
  searchIndex?: SearchIndexFactory | undefined;
  /** What a reviewer who sees only their own units may read of each version (required, so no route can forget to redact). */
  redaction: RedactionLoader;
}

export interface GridPage {
  columns: GridColumn[];
  items: Array<{
    id: string;
    receivedAt: string;
    status: SubmissionStatus;
    read: boolean;
    starred: boolean;
    archivedAt: string | null;
    trashedAt: string | null;
    versionNumber: number | null;
    cells: Record<string, string>;
    masked: string[];
    /** Each review unit of a response that was held for review: its name and state, nothing else. Absent for any other response. */
    review?: ReviewUnitSummary[];
  }>;
  nextCursor: string | null;
}

/**
 * One page of the responses of a form (SUB-02): newest first by the moment received with the id as the tie-break, so each
 * response is on exactly one page while rows arrive; or, with `q`, in order of relevance. The page and its audit record
 * are one read-write transaction (`auditReads.gridPage`, C-M9): a page that was shown has its record, one per page, with
 * every id shown. No total is counted: a count over a form of a million responses is the slowest thing a grid could ask.
 *
 * A caller who is acting as a reviewer of the form with `own_unit` visibility (WP-2.33) gets the cells of the blocks of their
 * own units and of no other, in a column list cut the same way; their `q` is refused, because the search document of a
 * response holds the text of every unit. A row that was held for review carries the name and state of its review units.
 */
export async function listGrid(
  deps: GridDeps,
  tenant: TenantCtx,
  client: ReadClient,
  formId: string,
  f: GridFilters,
  limit: number,
  token: string | undefined,
): Promise<GridPage> {
  const searching = f.q !== undefined && f.q !== '';
  const scope = gridScope(tenant.orgId, tenant.userId, formId, f);
  const position = token === undefined ? undefined : positionOf(deps.secret, scope, token, searching);
  const page = position?.page ?? 1;

  return withTenant(deps.db, tenant, async (tx) => {
    // Row level security hides another org's form, so a foreign or made-up id is a 404 rather than an empty inbox.
    const found = await tx.select({ id: forms.id }).from(forms).where(eq(forms.id, formId)).limit(1);
    if (!found[0]) throw new ProblemError('NOT_FOUND', 'That form is not in this organisation.');
    const plans = await deps.plans.ofForm(tx, formId);
    const reviewer = await reviewerViewOf(tx, tenant, formId);
    if (searching && reviewer.redacted) {
      throw new ProblemError('SEARCH_NOT_ALLOWED_FOR_REVIEWER', 'You see only the units you review, and a search would match the text of the others. Leave the search box empty.');
    }

    let rows: Row[];
    let next: string | null = null;
    let more = false;
    if (searching) {
      const result = await searchRows(tx, deps.searchIndex, tenant.orgId, formId, f, limit, position?.kind === 'hit' ? position.after : undefined);
      rows = result.rows;
      next = result.next;
      more = next !== null;
    } else {
      const after = position?.kind === 'row' ? position : undefined;
      const fetched = await tx
        .select(columnsOfRow)
        .from(submissions)
        .where(
          and(
            ...conditions(tenant.orgId, formId, f),
            // The row after the cursor in the grid's own order; a row comparison reads (moment, id) as one position.
            after ? sql`(${submissions.receivedAt}, ${submissions.id}) < (${after.receivedAt}::timestamptz, ${after.id}::uuid)` : undefined,
          ),
        )
        .orderBy(desc(submissions.receivedAt), desc(submissions.id))
        // One row more than the page, to know whether there is a next page without a count.
        .limit(limit + 1);
      more = fetched.length > limit;
      rows = fetched.slice(0, limit);
    }

    await auditReads.gridPage(tx, tenant, { formId, submissionIds: rows.map((r) => r.id), page, filtered: isFiltered(f), client });

    const planOf = new Map(plans.map((p) => [p.id, p]));
    // The blocks of each version a redacted reviewer may see; every version of the form, so the columns can be cut too.
    const visibility = reviewer.redacted ? await deps.redaction.visibility(tx, reviewer, plans.map((p) => p.id)) : SEES_ALL;
    const summaries = await reviewSummaries(tx, reviewer, tenant.orgId, formId, rows);
    const last = rows.at(-1);
    let nextCursor: string | null = null;
    if (searching) nextCursor = more && next !== null ? signCursor(deps.secret, scope, [next, page + 1]) : null;
    else if (more && last) nextCursor = signCursor(deps.secret, scope, [last.receivedAt.toISOString(), last.id, page + 1]);

    // For a redacted caller a column stays only when some version that has the field lets them see it.
    const all = gridColumns(plans);
    const columns = reviewer.redacted ? all.filter((c) => plans.some((p) => p.byId.has(c.id) && mayShow(visibility.of(p.id), c.id))) : all;
    return {
      columns,
      items: rows.map((row) => {
        const plan = planOf.get(row.formVersionId);
        const shown = cellsOf(plan, row.answers);
        const visible = visibility.of(row.formVersionId);
        const cells = visible === null ? shown.cells : Object.fromEntries(Object.entries(shown.cells).filter(([id]) => mayShow(visible, id)));
        const masked = visible === null ? shown.masked : shown.masked.filter((id) => mayShow(visible, id));
        return {
          id: row.id,
          receivedAt: row.receivedAt.toISOString(),
          status: row.status,
          read: row.read,
          starred: row.starred,
          archivedAt: row.archivedAt?.toISOString() ?? null,
          trashedAt: row.trashedAt?.toISOString() ?? null,
          versionNumber: plan?.number ?? null,
          cells,
          masked,
          ...reviewOf(summaries, row.id),
        };
      }),
      nextCursor,
    };
  });
}
