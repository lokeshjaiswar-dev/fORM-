import type { I18n } from '@form/i18n';
import type { EvaluableVersion } from '@form/logic';
import { valueDefinition } from '@form/registry';
import { COMPUTED_FIELD_TYPES, VALUE_FIELD_TYPES } from '@form/schema';
import type {
  AnswerValue, Answers, BlockId, EvalMeta, EvalState, FieldBlock, FieldError, IsoDate, Locale, PageId, StoredBlock, ValueFieldType,
} from '@form/schema';
import { extraIssues, type CheckContext } from './checks.ts';
import { issuesOf, valuesFor, wellShaped, type Issue } from './errors.ts';
import { messageFormatter, submitBlockMessage } from './messages.ts';
import { normalizeAnswer, type RawAnswers } from './normalize.ts';

/*
 * validateAnswers (FND-05, VAL-01/05/07/10, RSP-02; schema §3.3.8–9): validates only the blocks in scope that
 * are effectively visible (visible_eff) and enabled, requires only the effective required set (required_eff),
 * and adds the logic `submitBlock` entries in scope. Next on a page validates that page alone (B1); a hidden
 * required field never blocks (B2). The same function runs in the renderer and in the submission pipeline.
 */

/** A page of the definition (Next), or the whole path (Submit). */
export type ValidationScope = { page: PageId } | 'submit';

export interface ValidateOptions {
  scope: ValidationScope;
  locale: Locale;
  /** The date of `meta.now` in the form's time zone: relative date bounds and age limits are measured from it. */
  today: IsoDate;
  /** The caller's catalogues for `locale` (system messages); the en-IN source catalogue is the last fallback. */
  messages?: I18n;
  holidayCalendars?: EvalMeta['holidayCalendars'];
}

const VALUE_TYPES: ReadonlySet<string> = new Set(VALUE_FIELD_TYPES);
const COMPUTED: ReadonlySet<string> = new Set(COMPUTED_FIELD_TYPES);

/** Input fields carry a respondent answer; computed fields are produced by the server and not validated here. */
const isInputField = (block: StoredBlock | undefined): block is FieldBlock =>
  block !== undefined && VALUE_TYPES.has(block.type) && !COMPUTED.has(block.type);

/** The answer validated for `block`: hidden fields take the evaluated capture, every other field the respondent's normalised answer. */
function answerFor(block: FieldBlock, answers: RawAnswers | Answers, state: EvalState): AnswerValue | undefined {
  if (block.type === 'hidden') return state.values[block.id];
  return normalizeAnswer(Object.hasOwn(answers, block.id) ? (answers as RawAnswers)[block.id] : undefined);
}

function blockIssues(block: FieldBlock, answer: AnswerValue | undefined, required: boolean, ctx: CheckContext): Issue[] {
  if (answer === undefined) return required ? [{ code: 'required', path: [] }] : [];
  if (answer.type !== block.type) return [{ code: 'invalid_format', path: [] }];
  const schema = (valueDefinition(block.type as ValueFieldType).answerSchema as (b: FieldBlock, s: { required: boolean }) => {
    safeParse(input: unknown): { success: boolean; error?: unknown };
  })(block, { required });
  const parsed = schema.safeParse(answer.value);
  if (parsed.success) return extraIssues(block, answer, ctx);
  const issues = issuesOf(block.type as ValueFieldType, parsed.error);
  /* A value over the length limit is not matched against presets, patterns or masks (VAL-04 cost): `too_long` alone. */
  const tooLong = issues.some((issue) => issue.code === 'too_long' && issue.path.length === 0);
  return wellShaped(parsed.error) && !tooLong ? [...issues, ...extraIssues(block, answer, ctx)] : issues;
}

/** One error per (path, code), `required` first, otherwise in report order. */
function tidy(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const unique = issues.filter((issue) => {
    const key = JSON.stringify([issue.code, issue.path]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...unique.filter((i) => i.code === 'required'), ...unique.filter((i) => i.code !== 'required')];
}

export function validateAnswers(version: EvaluableVersion, state: EvalState, answers: RawAnswers | Answers, opts: ValidateOptions): FieldError[] {
  const def = version.definition;
  const { documentOrder, pageOf } = version.compiled;
  const { scope } = opts;
  const fmt = messageFormatter(def, opts.locale, opts.messages);
  const ctx: CheckContext = { state, today: opts.today, holidayCalendars: opts.holidayCalendars };
  const inScope = (id: BlockId) =>
    state.visible.has(id) && !state.disabled.has(id) && (scope === 'submit' || pageOf[id] === scope.page);

  const errors: FieldError[] = [];
  for (const id of documentOrder) {
    const block = def.blocks[id];
    if (!isInputField(block) || !inScope(id)) continue;
    const answer = answerFor(block, answers, state);
    for (const issue of tidy(blockIssues(block, answer, state.required.has(id), ctx))) {
      const params = valuesFor(block, issue, fmt, answer?.value);
      const error: FieldError = { blockId: id, code: issue.code, message: fmt.format(issue.code, params, block) };
      if (issue.path.length) error.path = issue.path.join('.');
      if (Object.keys(params).length) error.params = params;
      errors.push(error);
    }
  }

  for (const entry of state.submitBlocks) {
    const applies = scope === 'submit' ? entry.atPage === undefined || state.path.includes(entry.atPage) : entry.atPage === scope.page;
    if (!applies) continue;
    const message = submitBlockMessage(def, opts.locale, entry).trim() || fmt.format('blocked_by_rule', {});
    const error: FieldError = { code: 'blocked_by_rule', message };
    if (entry.anchorBlockId !== undefined) error.blockId = entry.anchorBlockId;
    errors.push(error);
  }
  return errors;
}
