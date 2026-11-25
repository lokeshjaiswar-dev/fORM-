import { sql } from 'drizzle-orm';
import { txExecutor, type SubmissionStatus, type Tx } from '@form/db';
import { formatUniqueId } from '@form/registry';
import { toIsoInstant, type Queue } from '@form/ports';
import type { Answers, BlockId, CompiledForm, FormDefinition, UniqueIdConfig } from '@form/schema';
import { searchDocFor } from '../submissions/search-doc.ts';
import { searchIndexOn, type SearchIndexFactory } from '../submissions/search.ts';

/**
 * What the submit transaction has decided when it runs the effects of a stored response. Everything the effects need is
 * here, so adding one is a change to this file and not to the pipeline. Nothing in it is the respondent's word: the
 * answers are the server's evaluation of them, the ids and the moment are the server's, and the org comes from the slug.
 */
export interface EffectsContext {
  orgId: string;
  formId: string;
  formVersionId: string;
  /** The version's number within its form. */
  versionNumber: number;
  submissionId: string;
  /** The moment the server took the answers (the one inside `submissionId`, and `submissions.received_at`). */
  receivedAt: Date;
  /** `complete`, or `pending_review` when the form's review holds the response; a held status (payment, scan, guardian consent, review) is searchable at once but enqueues no fan-out until it is released. */
  status: SubmissionStatus;
  locale: string;
  /** The validated answers as they are stored (plain, until WP-1.11 encrypts the sensitive ones), with file references rewritten from the upload rows and the unique IDs numbered. */
  answers: Answers;
  /** The version the answers were checked against. */
  definition: FormDefinition;
  compiled: CompiledForm;
}

/**
 * What the effects write to or send through. Both are made by the composition root (`main.ts`, the only place an adapter
 * may be imported) and handed to `buildApp`. An app built without one skips that effect, which only tests do: the
 * production config refuses to start without `JOB_SIGNING_KEYS`, and `main.ts` always passes the search index.
 */
export interface EffectsDeps {
  /** The full-text index the search document goes to (`submission_search`), bound to the submit transaction. */
  searchIndex?: SearchIndexFactory | undefined;
  /** A producer queue; its `send` runs on the submit transaction, so the fan-out job commits or rolls back with the response. */
  queue?: Queue | undefined;
}

/**
 * The statuses a response is released to its side effects in: held ones (payment, scan, guardian consent, review) wait for
 * their release. A response held for review is released by the decision that approves its last required unit, which
 * sends the job itself (`finaliseOnDecision`, event `released`); a rejected one is never released.
 */
const FANS_OUT: readonly SubmissionStatus[] = ['complete'];

/** The year or month of `at` as the form's own calendar names it (`YYYY`, `YYYY-MM`), which is when a numbering that restarts restarts. */
function periodOf(resetEvery: UniqueIdConfig['resetEvery'], at: Date, timeZone: string): string {
  if (resetEvery === 'never') return '';
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(at);
  } catch {
    // A time zone this runtime does not know (the definition passed publish, so this is a runtime gap, not the respondent's doing): UTC.
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit' }).formatToParts(at);
  }
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  return resetEvery === 'year' ? year : `${year}-${month}`;
}

/**
 * Gives each unique-ID block its number (FLD-32): one `form_id_counters` row per form, block and period, advanced by a
 * single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, so two submissions can never get the same number and a
 * submission that rolls back (a reached limit) gives its number back. The row lock is held to the commit, so the
 * numbers are gap-free in commit order.
 *
 * This runs right after the idempotency key is claimed, before the search document, the job, the limit's counter and
 * the INSERT, although architecture §2.5 step 6 lists the counters last: the number is part of the stored answer (and of
 * its search document), and a respondent context may INSERT a response but never UPDATE it (`submissions_data_update`),
 * so the answer has to carry its number when it is inserted. The cost is a longer hold of this one row, which only a
 * form with a unique ID pays.
 *
 * Only a block the respondent's path reached has an answer to number; a hidden one takes no number. Blocks are numbered
 * in id order, so two transactions that number two blocks lock the rows in the same order and cannot deadlock. The page
 * never chooses the number: the value the evaluation put in the answer (a preview of the first number) is replaced.
 */
export async function takeUniqueIds(tx: Tx, ctx: Pick<EffectsContext, 'orgId' | 'formId' | 'receivedAt' | 'answers' | 'definition'>): Promise<Answers> {
  const blocks = (Object.keys(ctx.definition.blocks) as BlockId[])
    .sort()
    .map((id) => ctx.definition.blocks[id])
    .filter((block): block is Extract<NonNullable<typeof block>, { type: 'unique_id' }> => block?.type === 'unique_id' && ctx.answers[block.id]?.type === 'unique_id');
  if (blocks.length === 0) return ctx.answers;
  const numbered: Answers = { ...ctx.answers };
  for (const block of blocks) {
    const { config } = block;
    const period = periodOf(config.resetEvery, ctx.receivedAt, ctx.definition.behavior.timeZone);
    // `next_seq` is the number the NEXT submission gets. The first submission of a period creates the row at startAt + 1
    // and takes startAt; every later one takes the stored number and advances it. `greatest` lets a later version raise
    // `startAt` and have it apply, and never lets one lower the numbering below what was already given out.
    const { rows } = await tx.execute<{ taken: string }>(sql`
      insert into form_id_counters as c (form_id, block_id, period, org_id, next_seq)
      values (${ctx.formId}, ${block.id}, ${period}, ${ctx.orgId}, ${config.startAt + 1})
      on conflict (form_id, block_id, period) do update set next_seq = greatest(c.next_seq, ${config.startAt}::bigint) + 1
      returning next_seq - 1 as taken`);
    const taken = rows[0]?.taken;
    if (taken === undefined) throw new Error('form_id_counters returned no number');
    numbered[block.id] = { type: 'unique_id', value: formatUniqueId(config, Number(taken)) };
  }
  return numbered;
}

/** Every block id a template or rich document reads as an answer (`{ kind: 'answer', blockId }` inside a pipe), wherever it sits in the value. */
function pipedBlockIds(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) pipedBlockIds(item, found);
  } else if (typeof value === 'object' && value !== null) {
    const node = value as Record<string, unknown>;
    const attrs = node['type'] === 'pipe' ? node['attrs'] : node['pipe'];
    const source = (attrs as { source?: { kind?: unknown; blockId?: unknown } } | undefined)?.source;
    if (source?.kind === 'answer' && typeof source.blockId === 'string') found.add(source.blockId);
    for (const child of Object.values(node)) pipedBlockIds(child, found);
  }
  return found;
}

/**
 * The reference numbers the respondent is given back (FLD-32): only numbers the form means to show. A `unique_id` field
 * is returned when it is marked `showOnEnding`, or when the ending the answers reached pipes it (its content, its
 * redirect address or message, its buttons). Nothing else of the answers is returned, and neither is a number of a
 * field the respondent's path did not reach (it holds no answer). `uniqueId` is the first marked one, in block id order.
 */
export function issuedForEnding(definition: FormDefinition, endingId: string, answers: Answers): { uniqueId?: string; uniqueIds?: Record<string, string> } {
  const ending = definition.endings.find((e) => e.id === endingId);
  const piped = ending ? pipedBlockIds(ending) : new Set<string>();
  const uniqueIds: Record<string, string> = {};
  let uniqueId: string | undefined;
  for (const id of (Object.keys(definition.blocks) as BlockId[]).sort()) {
    const block = definition.blocks[id];
    const answer = answers[id];
    if (block?.type !== 'unique_id' || answer?.type !== 'unique_id' || typeof answer.value !== 'string' || answer.value === '') continue;
    const marked = block.config.showOnEnding;
    if (!marked && !piped.has(id)) continue;
    uniqueIds[id] = answer.value;
    if (marked && uniqueId === undefined) uniqueId = answer.value;
  }
  if (Object.keys(uniqueIds).length === 0) return {};
  return { ...(uniqueId === undefined ? {} : { uniqueId }), uniqueIds };
}

/**
 * What a stored response sets in motion inside its own transaction, before the guarded counter update that can still roll
 * everything back and before the INSERT of the response, so whatever it writes is undone with the rest by a
 * `LIMIT_REACHED` and holds none of the form's hot rows while it runs:
 *
 * 1. the search document: the text of the answers that are safe to search (`searchDocFor`: no `encrypt` or `sensitive`
 *    field, nothing derived from one), written to `submission_search` as the respondent context may (insert only);
 * 2. the single `submission.fanout` job, sent through the same transaction (the transactional outbox, architecture §2.5
 *    step 5): a response that is not committed enqueues nothing, and one that is committed has its job. A held status
 *    enqueues nothing; its release sends the job.
 *
 * The job names the form as its resource (the worker resolves the org from it with `resolve_job_org`, which knows forms
 * and not submissions) and carries ids only, never an answer.
 */
export async function recordEffects(tx: Tx, ctx: EffectsContext, deps: EffectsDeps = {}): Promise<void> {
  if (deps.searchIndex) {
    await searchIndexOn(deps.searchIndex, tx).upsert(ctx.orgId, [
      {
        submissionId: ctx.submissionId,
        receivedAt: toIsoInstant(ctx.receivedAt),
        formId: ctx.formId,
        locale: ctx.locale,
        text: searchDocFor({ definition: ctx.definition, compiled: ctx.compiled }, ctx.answers),
      },
    ]);
  }
  if (deps.queue && FANS_OUT.includes(ctx.status)) {
    const jobId = await deps.queue.send(
      'submission.fanout',
      {
        orgId: ctx.orgId,
        resource: { type: 'form', id: ctx.formId },
        data: { submissionId: ctx.submissionId, receivedAt: toIsoInstant(ctx.receivedAt), event: 'created' },
      },
      { tx: txExecutor(tx) },
    );
    // A standard queue gives every send an id; none means the job was not stored, and a stored response without its
    // fan-out would never notify anyone: fail the whole transaction instead.
    if (jobId === null) throw new Error('submission.fanout was not enqueued');
  }
}
