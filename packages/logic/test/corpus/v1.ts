import type * as S from '@form/schema';
import { all, choices, cond, field, form, hide, page, rule, show } from '../build.ts';

/*
 * The v1 show/hide semantics, kept as a test oracle: a copy of `isBlockVisible` from
 * apps/builder/src/lib/logic.ts (commit e1be409), which logic@2 must reproduce on migrated forms,
 * except for the documented fixes below. The v1 → v2 mapping follows schema §4.2 for logic.
 */

export type V1Operator =
  | 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'starts_with' | 'ends_with'
  | 'greater_than' | 'less_than' | 'answered' | 'not_answered' | 'is_empty';
export interface V1Logic { enabled?: boolean; action?: 'show' | 'hide'; sourceBlockId?: string; operator?: V1Operator; value?: string }
export type V1Type = 'text' | 'long_text' | 'email' | 'number' | 'multiple_choice' | 'dropdown' | 'checkbox' | 'multi_select' | 'rating' | 'nps' | 'date';
export interface V1Option { id: string; label: string; value: string }
export interface V1Block { id: string; type: V1Type; options?: V1Option[]; logic?: V1Logic; page: number }
export interface V1Form { name: string; blocks: V1Block[] }
/** What the oracle reads of a block: any v1 type (content blocks have no value, as in v1). */
export interface OracleBlock { id: string; type: string; options?: V1Option[]; logic?: V1Logic }
export type V1Values = Record<string, unknown>;

/** Behaviour changes logic@2 makes on purpose; each one is a separate switch of the oracle. */
export const FIXES = {
  /** LOG-09: a hidden source reads as unanswered, transitively (v1 read the value of hidden blocks). */
  transitive_hidden: true,
  /** B21: a rule whose source block was deleted is disabled (v1 kept evaluating it against ''). */
  dangling_source: true,
  /** Numbers are never compared when unanswered: v1 read '' as 0 (`Number('') === 0`). */
  unanswered_not_zero: true,
  /** A choice value that matches no option disables the rule (migration note `logic_value_unmatched`). */
  unmatched_choice_value: true,
  /**
   * A number source compares `equals`/`not_equals` as numbers (schema §4.2.1): v1 compared the trimmed answer and the
   * value as strings, so '0.0' never equalled '0'. Only the migrated corpus exercises it (its number pool has such answers).
   */
  numeric_equality: true,
} as const;
export type Fix = keyof typeof FIXES;
export const FIX_NAMES = Object.keys(FIXES) as Fix[];

const CHOICE_TYPES: ReadonlySet<string> = new Set<V1Type>(['multiple_choice', 'dropdown', 'checkbox', 'multi_select']);
const NUMERIC_OPS: ReadonlySet<V1Operator> = new Set(['greater_than', 'less_than']);

/** v1 `isBlockVisible`, verbatim in behaviour. */
export function v1IsBlockVisible(block: OracleBlock, values: V1Values): boolean {
  const logic = block.logic;
  if (!logic?.enabled || !logic.sourceBlockId) return true;
  const raw = values[logic.sourceBlockId];
  const source = Array.isArray(raw) ? raw.join(' ') : String(raw ?? '');
  const target = logic.value ?? '';
  const op = logic.operator ?? 'equals';
  const src = source.trim();
  const srcL = src.toLowerCase();
  const tgtL = target.toLowerCase();
  const nSrc = Number(src);
  const nTgt = Number(target);
  let matched = false;
  switch (op) {
    case 'equals': matched = src === target; break;
    case 'not_equals': matched = src !== target; break;
    case 'contains': matched = srcL.includes(tgtL); break;
    case 'not_contains': matched = !srcL.includes(tgtL); break;
    case 'starts_with': matched = srcL.startsWith(tgtL); break;
    case 'ends_with': matched = srcL.endsWith(tgtL); break;
    case 'greater_than': matched = Number.isFinite(nSrc) && Number.isFinite(nTgt) ? nSrc > nTgt : src > target; break;
    case 'less_than': matched = Number.isFinite(nSrc) && Number.isFinite(nTgt) ? nSrc < nTgt : src < target; break;
    case 'answered': matched = src.length > 0; break;
    case 'not_answered':
    case 'is_empty': matched = src.length === 0; break;
    default: matched = src === target;
  }
  const showAction = logic.action !== 'hide';
  return showAction ? matched : !matched;
}

const unmatched = (source: OracleBlock | undefined, logic: V1Logic): boolean =>
  source !== undefined && CHOICE_TYPES.has(source.type) && logic.value !== undefined && !(source.options ?? []).some((o) => o.value === logic.value)
  && ['equals', 'not_equals'].includes(logic.operator ?? 'equals');

/** v1 visibility of every block, with the chosen fixes applied. */
export function v1Visibility(f: { blocks: readonly OracleBlock[] }, values: V1Values, fixes: ReadonlySet<Fix>): Map<string, boolean> {
  const byId = new Map(f.blocks.map((b) => [b.id, b]));
  const out = new Map<string, boolean>();
  const blank = (raw: unknown) => (Array.isArray(raw) ? raw.length === 0 : String(raw ?? '').trim() === '');
  for (const block of f.blocks) {
    const logic = block.logic;
    if (!logic?.enabled || logic.sourceBlockId === undefined) {
      out.set(block.id, v1IsBlockVisible(block, values));
      continue;
    }
    const source = byId.get(logic.sourceBlockId);
    if ((!source && fixes.has('dangling_source')) || (fixes.has('unmatched_choice_value') && unmatched(source, logic))) {
      out.set(block.id, true);
      continue;
    }
    const hidden = source !== undefined && fixes.has('transitive_hidden') && out.get(source.id) === false;
    const effective = hidden ? { ...values, [logic.sourceBlockId]: undefined } : values;
    if (fixes.has('unanswered_not_zero') && NUMERIC_OPS.has(logic.operator ?? 'equals') && blank(effective[logic.sourceBlockId])) {
      out.set(block.id, logic.action === 'hide');
      continue;
    }
    const answer = String(effective[logic.sourceBlockId] ?? '').trim();
    const numericEqual = fixes.has('numeric_equality') && source?.type === 'number' && ['equals', 'not_equals'].includes(logic.operator ?? 'equals')
      && answer !== '' && (logic.value ?? '').trim() !== '' && Number(answer) === Number(logic.value);
    out.set(block.id, v1IsBlockVisible(block, numericEqual ? { ...effective, [logic.sourceBlockId]: logic.value } : effective));
  }
  return out;
}

/* ── v1 → v2 (schema §4.2, logic subset) ─────────────────────────────── */

const V2_TYPE: Record<V1Type, S.ValueFieldType> = {
  text: 'short_text', long_text: 'long_text', email: 'email', number: 'number', multiple_choice: 'single_choice', dropdown: 'single_choice',
  checkbox: 'multi_choice', multi_select: 'multi_choice', rating: 'rating', nps: 'nps', date: 'date',
};

const OPERATOR: Record<V1Operator, S.LogicOperator> = {
  equals: 'eq', not_equals: 'neq', contains: 'contains', not_contains: 'not_contains', starts_with: 'starts_with', ends_with: 'ends_with',
  greater_than: 'gt', less_than: 'lt', answered: 'is_answered', not_answered: 'is_not_answered', is_empty: 'is_not_answered',
};

function v2Block(b: V1Block): S.FieldBlock {
  const type = V2_TYPE[b.type];
  const options = (b.options ?? []).map((o) => ({ ...choices(o.id)[0] as S.ChoiceOption, label: o.label, code: o.value }));
  switch (type) {
    case 'single_choice':
      return field('single_choice', b.id, { config: { display: b.type === 'dropdown' ? 'dropdown' : 'radio', options } });
    case 'multi_choice':
      return field('multi_choice', b.id, { config: { display: b.type === 'multi_select' ? 'dropdown' : 'checkbox', options } });
    case 'rating':
      return field('rating', b.id, { config: { max: 5, icon: 'star' } });
    default:
      return field(type, b.id) as S.FieldBlock;
  }
}

function v2Operand(source: V1Block, value: string): S.Operand | null {
  switch (V2_TYPE[source.type]) {
    case 'single_choice':
    case 'multi_choice': {
      const option = (source.options ?? []).find((o) => o.value === value) ?? (source.options ?? []).find((o) => o.label === value);
      return option ? { kind: 'options', blockId: source.id as S.BlockId, optionIds: [option.id as S.OptionId] } : null;
    }
    case 'number':
    case 'rating':
    case 'nps':
      return { kind: 'literal', value: { type: 'number', value: value as S.DecimalString } };
    case 'date':
      return { kind: 'literal', value: { type: 'date', value: value as S.IsoDate } };
    default:
      return { kind: 'literal', value: { type: 'text', value } };
  }
}

/** The migrated v2 definition: one rule per enabled v1 logic, `initiallyHidden` for show targets. */
export function toV2(f: V1Form): S.FormDefinition {
  const byId = new Map(f.blocks.map((b) => [b.id, b]));
  const blocks: S.StoredBlock[] = [];
  const rules: S.Rule[] = [];
  for (const b of f.blocks) {
    const block = v2Block(b);
    const logic = b.logic;
    const source = logic?.sourceBlockId === undefined ? undefined : byId.get(logic.sourceBlockId);
    if (logic?.enabled && logic.sourceBlockId !== undefined) {
      const op = OPERATOR[logic.operator ?? 'equals'];
      const needsValue = !['is_answered', 'is_not_answered'].includes(op);
      const right = needsValue ? (source ? v2Operand(source, logic.value ?? '') : { kind: 'literal' as const, value: { type: 'text' as const, value: logic.value ?? '' } }) : null;
      const action = logic.action === 'hide' ? hide(b.id) : show(b.id);
      const left: S.Operand = { kind: 'ref', ref: { kind: 'answer', blockId: (source?.id ?? logic.sourceBlockId) as S.BlockId } };
      const condition = cond(left, op, right ?? undefined, op === 'eq' || op === 'neq' ? { caseSensitive: true } : {});
      /* B21: the rule keeps its deleted source, and compile() leaves it out; nothing here starts hidden for it. */
      if (!source) rules.push(rule(`rule_${b.id}`, all(condition), [action]));
      else if (!needsValue || right !== null) {
        rules.push(rule(`rule_${b.id}`, all(condition), [action]));
        if (logic.action !== 'hide') block.initiallyHidden = true;
      }
    }
    blocks.push(block);
  }
  const pageCount = Math.max(...f.blocks.map((b) => b.page)) + 1;
  const pages = Array.from({ length: pageCount }, (_, i) => page(`page_${i + 1}`, f.blocks.filter((b) => b.page === i).map((b) => b.id)));
  return form(blocks, pages, rules, { title: f.name });
}

/** The v2 answers for v1 values: strings trimmed (normalisation, I9), choice values as option ids, empties absent. */
export function toV2Answers(f: V1Form, values: V1Values): S.Answers {
  const out: Record<string, S.AnswerValue> = {};
  for (const b of f.blocks) {
    const raw = values[b.id];
    if (raw === undefined) continue;
    const idOf = (v: string) => (b.options ?? []).find((o) => o.value === v)?.id as S.OptionId;
    const type = V2_TYPE[b.type];
    if (type === 'multi_choice') {
      const ids = (raw as string[]).map(idOf);
      if (ids.length) out[b.id] = { type, value: { optionIds: ids } };
      continue;
    }
    if (type === 'single_choice') {
      out[b.id] = { type, value: { optionId: idOf(raw as string) } };
      continue;
    }
    if (type === 'rating' || type === 'nps') {
      out[b.id] = { type, value: raw as number };
      continue;
    }
    const s = String(raw).trim();
    if (!s) continue;
    if (type === 'email') out[b.id] = { type, value: { address: s as S.EmailAddress } };
    else out[b.id] = { type, value: s } as S.AnswerValue;
  }
  return out as S.Answers;
}
