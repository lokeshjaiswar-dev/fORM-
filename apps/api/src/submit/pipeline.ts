import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ANSWER_CODEC_PLAIN, formCounters, formAccess, formFilesCheck, formVersionState, newSubmissionKey, recordSubmission, resolveFormSlug, withTenant, type Db, type Tx } from '@form/db';
import type { Answers, FieldError } from '@form/schema';
import { ProblemError, type FieldIssue } from '../errors.ts';
import { runtimeStatus } from '../runtime/status.ts';
import { bindFileRefs, fileUses } from '../submission-files.ts';
import { checkAnswers, type ClientMeta } from '../validate-submission.ts';
import { isUnlocked, readAccess, type AccessView } from './access.ts';
import { recordEffects, takeUniqueIds, type EffectsContext, type EffectsDeps } from './effects.ts';
import { claimIdempotency, findIdempotent, hashRequest, type StoredResult } from './idempotency.ts';
import type { LoadedVersion, VersionLoader } from './live.ts';
import { buildMeta, evaluationInstant, withoutServerOwned, type ClientDetails } from './meta.ts';

/*
 * The submit pipeline: `POST /v1/p/:slug/submissions` (architecture §2.5, WP-1.12). Everything that can be decided
 * without writing is decided first, outside the write transaction, so the transaction that holds locks is short:
 *
 *   resolve the slug (the org comes from it, never from the caller)
 *   one read-only pass: a replay of the Idempotency-Key, the form's access rules, its counter, the named version's state
 *   which version the answers may be for, and what the form may do now (closed, full, password) at `receivedAt`
 *   evaluate and validate the answers (server scope, with the page-view details), drop what the server owns
 *   check the files the answers name against the upload rows
 *
 *   then one transaction: claim the key, number the unique-ID blocks, INSERT the submission, run the effects (the search
 *   document and the one fan-out job), and last of all the guarded counter update that can still say LIMIT_REACHED, which
 *   rolls the rest back.
 *
 * Still to come, in the order the architecture lists them: encryption and blind indexes (WP-1.11), consent records
 * (WP-1.21), the held statuses (WP-1.14, WP-1.30), captcha and honeypot (WP-1.13), edit and receipt tokens (WP-1.11).
 */

/** The most files one submission may name (the narrow lookup of 0019 takes at most this many ids). */
const MAX_FILES_PER_SUBMISSION = 100;
/** The longest user agent kept for a context field; browsers send a few hundred bytes. */
const MAX_USER_AGENT = 512;
const MS_PER_HOUR = 60 * 60 * 1000;

export interface SubmitDeps {
  db: Db;
  /** Keys the access token (`config.auth.secret`). */
  secret: Uint8Array;
  loader: VersionLoader;
  now: () => Date;
  /** What the effects write to or send through (the search index and the producer queue); without it they are skipped, which only tests do. */
  effects?: EffectsDeps | undefined;
}

/** What the route hands over: the parts of the request that are the respondent's word, already shaped by the route's schemas. */
export interface SubmitInput {
  slug: string;
  requestId: string;
  /** The `Idempotency-Key` header, a uuid (lower case). */
  idempotencyKey: string;
  /** The `X-FR-Access` header, if any. */
  accessToken: string | undefined;
  userAgent: string | undefined;
  body: {
    formVersionId: string;
    answers: Record<string, unknown>;
    locale: string;
    client: ClientDetails | undefined;
  };
}

/** `SubmitResult` of a taken submission (`@form/schema`); what the respondent is given, and what a replay is given again. */
export interface SubmitOk extends StoredResult {
  ok: true;
}

export type SubmitOutcome =
  | { kind: 'taken'; result: SubmitOk; replayed: boolean }
  /** The answers were refused (HTTP 422): `errors` names each field, `detail` says it in a sentence. */
  | { kind: 'invalid'; detail: string; errors: FieldIssue[] };

const SOME_NOT_VALID = 'Some answers are not valid.';

const invalid = (detail: string, errors: FieldIssue[] = []): SubmitOutcome => ({ kind: 'invalid', detail, errors });

/** Field errors as problem+json lists them: a dotted path from the block, at most 50. */
function fieldIssues(errors: readonly FieldError[]): FieldIssue[] {
  return errors.slice(0, 50).map((e) => ({ path: [e.blockId, e.path].filter(Boolean).join('.'), message: e.message }));
}

/** The answers' own problems (a file named where none is taken, an unknown file) are refusals of the answers: 422, with the helper's sentence. */
function asInvalid<T>(fn: () => T): { ok: true; value: T } | { ok: false; outcome: SubmitOutcome } {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (err instanceof ProblemError && err.code === 'VALIDATION_FAILED') return { ok: false, outcome: invalid(err.detail ?? SOME_NOT_VALID) };
    throw err;
  }
}

/**
 * The last statement of the transaction: one more response counted, unless the form's limit is reached. False means it
 * is. Exported so the limit test can race it without the status check that normally stops most requests first.
 */
export async function countSubmission(tx: Tx, formId: string): Promise<boolean> {
  // The limit is read by the statement itself, so a limit changed while the transaction ran is the one that applies,
  // and a form with no `form_access` row or no limit has none. The row lock this takes is held to the commit only.
  const counted = await tx
    .update(formCounters)
    .set({ submittedTotal: sql`${formCounters.submittedTotal} + 1` })
    .where(
      and(
        eq(formCounters.formId, formId),
        sql`${formCounters.submittedTotal} < coalesce((select ${formAccess.submissionLimit} from ${formAccess} where ${formAccess.formId} = ${formCounters.formId}), 9223372036854775807)`,
      ),
    )
    .returning({ submittedTotal: formCounters.submittedTotal });
  return counted.length > 0;
}

interface Preflight extends AccessView {
  /** The named version's dates, when it is not the live one; null when it has no row for this form. */
  named: { supersededAt: Date | null; retiredAt: Date | null } | null;
}

/** Everything the decision about a request reads, in one read-only transaction. */
async function preflight(tx: Tx, formId: string, namedVersionId: string, isLive: boolean): Promise<Preflight> {
  const view = await readAccess(tx, formId);
  let named: Preflight['named'] = null;
  if (!isLive) {
    const [state] = await tx
      .select({ supersededAt: formVersionState.supersededAt, retiredAt: formVersionState.retiredAt })
      .from(formVersionState)
      .where(and(eq(formVersionState.versionId, namedVersionId), eq(formVersionState.formId, formId)))
      .limit(1);
    named = state ?? null;
  }
  return { ...view, named };
}

const uuidList = z.array(z.uuid());

/**
 * Takes one submission. Returns what the respondent is given, or `invalid` for answers that were refused; every other
 * refusal is thrown as a `ProblemError` (`FORM_CLOSED`, `LIMIT_REACHED`, `PASSWORD_REQUIRED`, `VERSION_SUPERSEDED`,
 * `IDEMPOTENCY_KEY_REUSED`, `NOT_FOUND`) and nothing is stored.
 */
export async function submit(deps: SubmitDeps, input: SubmitInput): Promise<SubmitOutcome> {
  // The slug is resolved now, so a form that is no longer live takes no more answers.
  const found = await resolveFormSlug(deps.db, input.slug);
  if (!found) throw new ProblemError('NOT_FOUND', 'This form is not published.');
  const { body } = input;
  const named = body.formVersionId;
  const isLive = named === found.liveVersionId;
  // The server makes the id (a UUIDv7) and the moment it was received; the table's CHECK ties the two together, and the
  // form's status and the version's age are judged at this same moment.
  const { id: submissionId, receivedAt } = newSubmissionKey(deps.now());
  const tenant = { orgId: found.orgId, actor: 'respondent' as const, requestId: input.requestId };
  const requestHash = hashRequest({ formVersionId: named, locale: body.locale, answers: body.answers, client: body.client });

  const seen = await withTenant(deps.db, { ...tenant, readOnly: true }, async (tx) => {
    // A retry of a request that was taken gets its answer even when the form has meanwhile closed or filled up (the
    // retry of the last response a limit allows would otherwise be told LIMIT_REACHED); nothing below is run for it.
    const replay = await findIdempotent(tx, found.formId, input.idempotencyKey);
    if (replay) return { replay } as const;
    return { replay: null, ...(await preflight(tx, found.formId, named, isLive)) } as const;
  });
  if (seen.replay) {
    if (!seen.replay.requestHash.equals(requestHash)) throw new ProblemError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for different answers.');
    return { kind: 'taken', replayed: true, result: { ok: true, ...seen.replay.result } };
  }

  // Which version the answers may be for: the live one, or the one it replaced for `accept_previous_versions_hours` after
  // the newer one went live (F-34), unless it was retired. The page names it; the server decides.
  if (!isLive) {
    const state = seen.named;
    const window = seen.access.acceptPreviousVersionsHours * MS_PER_HOUR;
    const accepted = state !== null && state.retiredAt === null && state.supersededAt !== null && receivedAt.getTime() - state.supersededAt.getTime() < window;
    if (!accepted) throw new ProblemError('VERSION_SUPERSEDED', 'This form was updated while you were filling it. Reload and try again.');
  }
  const version = await deps.loader.get(found, named, input.requestId);
  if (!version) throw new ProblemError('VERSION_SUPERSEDED', 'This form was updated while you were filling it. Reload and try again.');

  // What the form may do at the moment the answers arrived. The token proves the password was given for the version the
  // respondent's page was built from (the one the answers name).
  const unlocked = isUnlocked(deps.secret, seen.access, input.accessToken, { formId: found.formId, versionScope: named }, receivedAt);
  const status = runtimeStatus(seen.access, { submittedTotal: seen.submittedTotal }, receivedAt, { unlocked });
  switch (status.state) {
    case 'open':
      break;
    case 'password':
      throw new ProblemError('PASSWORD_REQUIRED', 'This form needs its password.');
    case 'limit_reached':
      throw new ProblemError('LIMIT_REACHED', 'This form has reached its limit of responses.');
    case 'not_yet_open':
      throw new ProblemError('FORM_CLOSED', 'This form is not open yet.');
    case 'outside_hours':
      throw new ProblemError('FORM_CLOSED', 'This form is outside its opening hours.');
    default:
      throw new ProblemError('FORM_CLOSED', 'This form is closed.');
  }

  // The language is one the form offers: it is stored, and handed to Intl when the answers are checked.
  if (!version.definition.i18n.locales.some((l) => l.locale === body.locale)) {
    return invalid('This form is not offered in that language.', [{ path: 'locale', message: 'not a language of this form' }]);
  }

  // The answers are evaluated as the browser did (its session start, clamped; its URL parameters, address and device)
  // and validated against the stored version, whatever the page claims to have validated. What the server owns (hidden
  // fields, calculations) is dropped from the respondent's word first and recomputed.
  const evaluatedAt = evaluationInstant(receivedAt, body.client?.startedAt);
  const client: ClientMeta = {
    ...(body.client?.urlParams !== undefined ? { urlParams: body.client.urlParams } : {}),
    ...(body.client?.pageUrl !== undefined ? { pageUrl: body.client.pageUrl } : {}),
    ...(body.client?.referrer !== undefined ? { referrer: body.client.referrer } : {}),
    ...(body.client?.device !== undefined ? { device: body.client.device } : {}),
    ...(body.client?.embedOrigin !== undefined ? { embedOrigin: body.client.embedOrigin } : {}),
    ...(input.userAgent !== undefined ? { userAgent: input.userAgent.slice(0, MAX_USER_AGENT) } : {}),
  };
  const check = (raw: Record<string, unknown>) => checkAnswers(version, named, withoutServerOwned(version.definition, raw), body.locale, evaluatedAt, client);
  let checked = check(body.answers);
  if (checked.errors.length > 0) return invalid(SOME_NOT_VALID, fieldIssues(checked.errors));

  // Files: every file the answers name was uploaded to this form, for the very field that holds it, and is the file they
  // say it is. The references are rewritten from what the upload route recorded (name, type, size, hash), and the
  // answers checked once more against the true type and size. Read through the narrow definer function: a respondent
  // context cannot read form_files (SR-5).
  const uses = asInvalid(() => fileUses(checked.values));
  if (!uses.ok) return uses.outcome;
  if (uses.value.length > 0) {
    const ids = [...new Set(uses.value.map((use) => String(use.ref['fileId'])))];
    if (ids.length > MAX_FILES_PER_SUBMISSION) return invalid('Too many files in one submission.');
    const known = uuidList.safeParse(ids).success
      ? await withTenant(deps.db, { ...tenant, readOnly: true }, (tx) => formFilesCheck(tx, found.formId, ids))
      : [];
    const values = checked.values;
    const bound = asInvalid(() => bindFileRefs(values, new Map(known.map((row) => [row.id, row]))));
    if (!bound.ok) return bound.outcome;
    checked = check(bound.value as Record<string, unknown>);
    if (checked.errors.length > 0) return invalid(SOME_NOT_VALID, fieldIssues(checked.errors));
  }

  const answers: Answers = checked.values;
  const endingId = String(checked.state.endingId || version.definition.defaultEndingId);
  const meta = buildMeta({
    locale: body.locale,
    client: body.client,
    startedAt: body.client?.startedAt !== undefined ? evaluatedAt : undefined,
    receivedAt,
    versionNumber: version.number,
  });
  return store(deps, tenant, { found, version, submissionId, receivedAt, idempotencyKey: input.idempotencyKey, requestHash, answers, endingId, meta, locale: body.locale, pathTaken: checked.state.path });
}

interface Stage {
  found: { orgId: string; formId: string };
  version: LoadedVersion;
  submissionId: string;
  receivedAt: Date;
  idempotencyKey: string;
  requestHash: Buffer;
  answers: Answers;
  endingId: string;
  meta: Record<string, unknown>;
  locale: string;
  pathTaken: readonly string[];
}

/**
 * The write transaction, ordered for throughput and correctness (architecture §2.5, steps 3 to 6): the key is claimed
 * first, so a replay is returned before anything is stored or counted; the unique IDs are numbered (the number is part
 * of the answer, which a respondent context can INSERT but never UPDATE, see `takeUniqueIds`); the response is inserted;
 * its effects run; and the limit's counter is updated last, so its row lock is held for the commit only. A limit that is
 * reached at that last statement throws, and everything above it rolls back with it (the key, the numbers and the job
 * too, so the next try is a new request).
 */
async function store(deps: SubmitDeps, tenant: { orgId: string; actor: 'respondent'; requestId: string }, s: Stage): Promise<SubmitOutcome> {
  const result: StoredResult = { submissionId: s.submissionId, endingId: s.endingId };
  return withTenant(deps.db, tenant, async (tx): Promise<SubmitOutcome> => {
    const claim = await claimIdempotency(tx, {
      orgId: s.found.orgId,
      formId: s.found.formId,
      key: s.idempotencyKey,
      receivedAt: s.receivedAt,
      requestHash: s.requestHash,
      result,
    });
    if (!claim.owned) {
      // Another request got the key between the read and here (a double tap): the same answers are its replay.
      if (!claim.stored.requestHash.equals(s.requestHash)) throw new ProblemError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for different answers.');
      return { kind: 'taken', replayed: true, result: { ok: true, ...claim.stored.result } };
    }
    const answers = await takeUniqueIds(tx, { orgId: s.found.orgId, formId: s.found.formId, receivedAt: s.receivedAt, answers: s.answers, definition: s.version.definition });
    await recordSubmission(tx, {
      id: s.submissionId,
      receivedAt: s.receivedAt,
      orgId: s.found.orgId,
      formId: s.found.formId,
      formVersionId: s.version.versionId,
      definitionHash: s.version.definitionHash,
      answerCodecVersion: ANSWER_CODEC_PLAIN,
      status: 'complete',
      answers,
      // The page path and the ending the answers reached; the variables (which can be tainted or sensitive) wait for WP-1.11.
      computed: { path: [...s.pathTaken], endingId: s.endingId },
      meta: s.meta,
    });
    // The form's counters (`forms.submission_count`) and the hold on the files the answers name are kept by a trigger on
    // this INSERT (0019, moved by 0021): a respondent context may not write `forms` or `form_files`.
    const effects: EffectsContext = {
      orgId: s.found.orgId,
      formId: s.found.formId,
      formVersionId: s.version.versionId,
      versionNumber: s.version.number,
      submissionId: s.submissionId,
      receivedAt: s.receivedAt,
      status: 'complete',
      locale: s.locale,
      answers,
      definition: s.version.definition,
      compiled: s.version.compiled,
    };
    await recordEffects(tx, effects, deps.effects);
    if (!(await countSubmission(tx, s.found.formId))) throw new ProblemError('LIMIT_REACHED', 'This form has reached its limit of responses.');
    return { kind: 'taken', replayed: false, result: { ok: true, ...result } };
  });
}
