import { PortError, type IsoInstant, type SearchDocument, type SearchHit, type SearchIndex, type SubmissionKey } from '@form/ports';
import { isUuid, type TenantRunner } from '../sql.ts';

export interface PostgresSearchOptions {
  /** One transaction under the org's tenant context, so RLS scopes every statement (see `TenantRunner`). */
  inTenant: TenantRunner;
  /** Text beyond this many characters per document is not indexed (tsvector's 1 MB ceiling). Default 200 000. */
  maxTextChars?: number;
}

const MAX_LIMIT = 100;
const MAX_QUERY_CHARS = 256;
const MAX_BATCH = 1000;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

const invalid = (message: string) => new PortError('invalid_argument', message);

function checkOrg(orgId: string): void {
  if (!isUuid(orgId)) throw invalid('orgId must be a uuid');
}

function checkKey(k: SubmissionKey): void {
  if (!isUuid(k.submissionId)) throw invalid('submissionId must be a uuid');
  if (Number.isNaN(Date.parse(k.receivedAt))) throw invalid('receivedAt must be an instant');
}

/** `received_at` back in the caller's form: microseconds only when they are not zero. */
const instant = (text: string) => text.replace(/(\.\d{3})000Z$/, '$1Z') as IsoInstant;

interface Cursor {
  rank: string;
  receivedAt: string;
  submissionId: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.rank, c.receivedAt, c.submissionId])).toString('base64url');
}

function decodeCursor(after: string): Cursor {
  try {
    const v = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 3) {
      const [rank, receivedAt, submissionId] = v as unknown[];
      if (typeof rank === 'string' && Number.isFinite(Number(rank)) && typeof receivedAt === 'string' && !Number.isNaN(Date.parse(receivedAt)) && isUuid(submissionId)) {
        return { rank, receivedAt, submissionId };
      }
    }
  } catch {
    // fall through
  }
  throw invalid('invalid search cursor');
}

/**
 * The SearchIndex of every edition (architecture §2.4, §6): `submission_search`, `simple` configuration with unaccent,
 * ranked with `ts_rank`. Ranking ties break on recency, and the cursor carries the last hit's (rank, receivedAt, id).
 */
export function createPostgresSearchIndex(o: PostgresSearchOptions): SearchIndex {
  const maxText = o.maxTextChars ?? 200_000;

  return {
    async upsert(orgId, docs: readonly SearchDocument[]) {
      checkOrg(orgId);
      if (docs.length === 0) return;
      if (docs.length > MAX_BATCH) throw invalid(`at most ${MAX_BATCH} documents per call`);
      for (const d of docs) {
        checkKey(d);
        if (!isUuid(d.formId)) throw invalid('formId must be a uuid');
        if (!LOCALE.test(d.locale) || d.locale.length > 35) throw invalid(`invalid locale ${JSON.stringify(d.locale)}`);
        if (!Array.isArray(d.text) || d.text.some((t) => typeof t !== 'string')) throw invalid('text must be strings');
      }
      const cols = {
        ids: docs.map((d) => d.submissionId),
        at: docs.map((d) => d.receivedAt),
        forms: docs.map((d) => d.formId),
        locales: docs.map((d) => d.locale),
        texts: docs.map((d) => d.text.join('\n').slice(0, maxText)),
      };
      await o.inTenant(orgId, (sql) =>
        sql.executeSql(
          // No ON CONFLICT DO UPDATE, nor even a conflict target: both need read access to the table, which the
          // respondent's submit transaction lacks (submission_search_data_access). The update changes only the
          // documents this context may read; the insert adds the new ones and skips the rest.
          `with d as (
             select id, at, form, locale, to_tsvector('simple', unaccent(body)) as doc
             from unnest($1::uuid[], $2::timestamptz[], $3::uuid[], $4::text[], $5::text[]) as u(id, at, form, locale, body)
           ), changed as (
             update submission_search s set form_id = d.form, locale = d.locale, doc = d.doc, updated_at = now()
             from d where s.submission_id = d.id and s.received_at = d.at
           )
           insert into submission_search (submission_id, received_at, org_id, form_id, locale, doc)
           select d.id, d.at, $6, d.form, d.locale, d.doc from d
           on conflict do nothing`,
          [cols.ids, cols.at, cols.forms, cols.locales, cols.texts, orgId],
        ),
      );
    },

    async remove(orgId, keys) {
      checkOrg(orgId);
      if (keys.length === 0) return;
      for (const k of keys) checkKey(k);
      await o.inTenant(orgId, (sql) =>
        sql.executeSql(
          `delete from submission_search s using unnest($1::uuid[], $2::timestamptz[]) as k(id, at)
           where s.submission_id = k.id and s.received_at = k.at`,
          [keys.map((k) => k.submissionId), keys.map((k) => k.receivedAt)],
        ),
      );
    },

    async query(orgId, q) {
      checkOrg(orgId);
      if (!isUuid(q.formId)) throw invalid('formId must be a uuid');
      if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > MAX_LIMIT) throw invalid(`limit must be 1..${MAX_LIMIT}`);
      const text = q.text.trim();
      if (text.length === 0 || text.length > MAX_QUERY_CHARS) throw invalid(`the query must be 1..${MAX_QUERY_CHARS} characters`);
      const after = q.after === undefined ? undefined : decodeCursor(q.after);
      const { rows } = await o.inTenant(orgId, (sql) =>
        sql.executeSql(
          `with hits as (
             select s.submission_id, s.received_at, ts_rank(s.doc, query)::real as rank
             from submission_search s, websearch_to_tsquery('simple', unaccent($2)) as query
             where s.form_id = $1 and s.doc @@ query
           )
           select submission_id::text as id, rank::text as rank,
             to_char(received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
           from hits
           where $4::real is null or (rank, received_at, submission_id) < ($4::real, $5::timestamptz, $6::uuid)
           order by rank desc, received_at desc, submission_id desc
           limit $3`,
          [q.formId, text, q.limit + 1, after?.rank ?? null, after?.receivedAt ?? null, after?.submissionId ?? null],
        ),
      );
      const page = (rows as { id: string; rank: string; at: string }[]).slice(0, q.limit);
      const hits: SearchHit[] = page.map((r) => ({ submissionId: r.id, receivedAt: instant(r.at), rank: Number(r.rank) }));
      const last = page.at(-1);
      return rows.length > q.limit && last ? { hits, next: encodeCursor({ rank: last.rank, receivedAt: last.at, submissionId: last.id }) } : { hits };
    },
  };
}
