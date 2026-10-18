import type {
  BlockId, ComparableKind, Condition, ConditionGroup, Expr, FieldRegistry, FormDefinition, Literal, LogicOperator, MetaKey, Operand,
  PublishIssue, StoredBlock, ValueRef,
} from '@form/schema';
import { OPERAND_OPERATORS, UNARY, baseOperator } from './operators.ts';

/*
 * Static typing of the P0 subset (delivery plan WP-0.07): condition groups with every comparison
 * operator, operands that are answers, request metadata, literals, typed option sets and expressions
 * made of `lit`, `ref` and comparisons. Everything else is reported as `missing_capability`, which
 * compile() treats as fatal (ADR-0002 §2), until WP-2.01–2.03 bring it.
 */

export type ValueKind = ComparableKind | 'option_set' | 'null';
export interface Typed {
  kind: ValueKind;
  source: 'answer' | 'meta' | 'literal' | 'options' | 'expr';
  /** Answers and option sets: the choice block they belong to. */
  blockId?: BlockId;
  /** Answers: the registry type, for its operator sets. */
  blockType?: StoredBlock['type'];
  /** Literals: a non-negative integer number (count operators). */
  count?: boolean;
}

export interface TypeContext {
  def: FormDefinition;
  registry: FieldRegistry;
  /** Cells read by `value(b)`: the value, the visibility of b and its ancestors, and onPath of its page. */
  valueReads(blockId: BlockId): readonly string[];
  issue(code: PublishIssue['code'], path: string, message: string): void;
}

export const CONDITION_LIMITS = { depth: 5, leaves: 100 } as const;
export const EXPR_LIMITS = { nodes: 500, depth: 32 } as const;

const TEXT_META: ReadonlySet<MetaKey> = new Set<MetaKey>([
  'locale', 'time_zone', 'device', 'url_param', 'page_url', 'referrer', 'embed_origin',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
]);
const COMPARISONS: ReadonlySet<string> = new Set(['==', '!=', '<', '<=', '>', '>=']);
const ORDERED: ReadonlySet<ValueKind> = new Set<ValueKind>(['number', 'money', 'date', 'time', 'datetime']);
const COUNT = /^(0|[1-9]\d*)$/;

const LITERAL_KINDS: Record<Exclude<Literal['type'], 'relative_date'>, ValueKind> = {
  text: 'text', number: 'number', money: 'money', boolean: 'boolean', date: 'date', datetime: 'datetime', time: 'time', null: 'null',
};

export function typeLiteral(ctx: TypeContext, literal: Literal, path: string): Typed | null {
  if (literal.type === 'relative_date') {
    ctx.issue('missing_capability', path, 'relative dates need the form clock (meta.today), which arrives with the date functions (WP-2.03)');
    return null;
  }
  const typed: Typed = { kind: LITERAL_KINDS[literal.type], source: 'literal' };
  if (literal.type === 'number' && COUNT.test(literal.value)) typed.count = true;
  return typed;
}

export function typeRef(ctx: TypeContext, ref: ValueRef, path: string, reads: Set<string>): Typed | null {
  if (ref.kind === 'variable') {
    ctx.issue('missing_capability', path, 'logic variables (LOG-20) are not available yet');
    return null;
  }
  if (ref.kind === 'meta') {
    if (ref.key === 'is_preview') return { kind: 'boolean', source: 'meta' };
    if (!TEXT_META.has(ref.key)) {
      ctx.issue('missing_capability', path, `meta '${ref.key}' needs the form clock or row scopes, which are not available yet`);
      return null;
    }
    if (ref.key === 'url_param' && !ref.name) {
      ctx.issue('expr_type_error', path, "meta 'url_param' needs the parameter name");
      return null;
    }
    return { kind: 'text', source: 'meta' };
  }
  if (ref.row !== undefined) {
    ctx.issue('missing_capability', `${path}/row`, 'row-scoped references need repeating groups, which are not available yet');
    return null;
  }
  const block = ctx.def.blocks[ref.blockId];
  if (!block || block.type === 'unsupported') return null; /* dangling_ref / unknown_block_type, reported by validateStructure */
  const definition = ctx.registry[block.type];
  const kind = (definition.paths as Readonly<Record<string, ComparableKind>>)[ref.path ?? ''];
  if (kind === undefined || kind === 'none') {
    if (definition.capability !== undefined && Object.keys(definition.paths).length === 0) {
      ctx.issue('missing_capability', path, `answers of '${block.type}' blocks need '${definition.capability}', which this version does not provide yet`);
    } else {
      const message = ref.path ? `'${block.type}' answers have no path '${ref.path}'` : `'${block.type}' blocks have no answer to compare`;
      ctx.issue('operator_type_mismatch', path, message);
    }
    return null;
  }
  for (const c of ctx.valueReads(ref.blockId)) reads.add(c);
  return { kind, source: 'answer', blockId: ref.blockId, blockType: block.type };
}

/** Expressions in the P0 subset: `lit`, `ref` and comparisons of those. */
export function typeExpr(ctx: TypeContext, expr: Expr, path: string, reads: Set<string>): Typed | null {
  let nodes = 0;
  let tooLarge = false;
  const visit = (e: Expr, at: string, depth: number): Typed | null => {
    nodes += 1;
    if (nodes > EXPR_LIMITS.nodes || depth > EXPR_LIMITS.depth) {
      if (!tooLarge) ctx.issue('expr_too_large', path, `expressions are limited to ${EXPR_LIMITS.nodes} nodes and depth ${EXPR_LIMITS.depth}`);
      tooLarge = true;
      return null;
    }
    switch (e.k) {
      case 'lit': {
        const typed = typeLiteral(ctx, e.value, `${at}/value`);
        return typed && { ...typed, source: 'expr' };
      }
      case 'ref': {
        const typed = typeRef(ctx, e.ref, `${at}/ref`, reads);
        return typed && { ...typed, source: 'expr' };
      }
      case 'binary': {
        if (!COMPARISONS.has(e.op)) break;
        const left = visit(e.left, `${at}/left`, depth + 1);
        const right = visit(e.right, `${at}/right`, depth + 1);
        if (!left || !right) return null;
        const equality = e.op === '==' || e.op === '!=';
        const nullable = equality && (left.kind === 'null' || right.kind === 'null');
        const sameKind = left.kind === right.kind && left.kind !== 'option_set';
        if (!nullable && (!sameKind || (!equality && !ORDERED.has(left.kind)))) {
          ctx.issue('expr_type_error', at, `'${e.op}' cannot compare ${left.kind} with ${right.kind}`);
          return null;
        }
        return { kind: 'boolean', source: 'expr' };
      }
      default:
        break;
    }
    ctx.issue('missing_capability', at, `'${e.k === 'binary' ? e.op : e.k}' expressions arrive with WP-2.01; P0 logic compares answers, metadata and literals`);
    return null;
  };
  return visit(expr, path, 1);
}

export function typeOperand(ctx: TypeContext, operand: Operand, path: string, reads: Set<string>): Typed | null {
  switch (operand.kind) {
    case 'ref':
      return typeRef(ctx, operand.ref, `${path}/ref`, reads);
    case 'literal':
      return typeLiteral(ctx, operand.value, `${path}/value`);
    case 'options':
      return { kind: 'option_set', source: 'options', blockId: operand.blockId };
    case 'expr':
      return typeExpr(ctx, operand.expr, `${path}/expr`, reads);
  }
}

function operatorsOf(ctx: TypeContext, left: Typed): readonly LogicOperator[] {
  if (left.source === 'answer' && left.blockType && left.blockType !== 'unsupported') {
    return ctx.registry[left.blockType].operators[left.kind as ComparableKind] ?? [];
  }
  return OPERAND_OPERATORS[left.kind as ComparableKind] ?? [];
}

/** Does `right` fit `op` applied to `left`? */
function fits(op: LogicOperator, left: Typed, right: Typed): boolean {
  const base = baseOperator(op);
  if (right.kind === 'null') return base === 'eq' || base === 'neq';
  switch (base) {
    case 'eq':
    case 'neq':
      if (left.kind === 'choice' || left.kind === 'choices') return right.kind === 'option_set' && right.blockId === left.blockId;
      return right.kind === left.kind;
    case 'contains':
    case 'not_contains':
    case 'starts_with':
    case 'not_starts_with':
    case 'ends_with':
    case 'not_ends_with':
      return right.kind === 'text';
    case 'includes_any':
    case 'includes_all':
    case 'includes_none':
      return right.kind === 'option_set' && right.blockId === left.blockId;
    case 'count_eq':
    case 'count_gte':
    case 'count_lte':
      return right.kind === 'number' && (right.source !== 'literal' || right.count === true);
    default:
      return right.kind === left.kind && ORDERED.has(left.kind);
  }
}

function checkCondition(ctx: TypeContext, c: Condition, path: string, reads: Set<string>): void {
  const left = typeOperand(ctx, c.left, `${path}/left`, reads);
  const right = c.right ? typeOperand(ctx, c.right, `${path}/right`, reads) : null;
  const right2 = c.right2 ? typeOperand(ctx, c.right2, `${path}/right2`, reads) : null;
  if (c.op === 'matches_preset') {
    ctx.issue('missing_capability', `${path}/op`, "'matches_preset' needs the re2js presets of @form/validation (WP-0.09)");
    return;
  }
  if (!left) return;
  if (left.kind === 'option_set') {
    ctx.issue('operator_type_mismatch', `${path}/left`, 'an option set can only be the right operand');
    return;
  }
  if (!operatorsOf(ctx, left).includes(c.op)) {
    ctx.issue('operator_type_mismatch', `${path}/op`, `'${c.op}' does not apply to ${left.kind} values`);
    return;
  }
  if (UNARY.has(c.op)) {
    if (c.right || c.right2) ctx.issue('operator_type_mismatch', `${path}/right`, `'${c.op}' takes no value`);
    return;
  }
  if (!c.right) {
    ctx.issue('operator_type_mismatch', path, `'${c.op}' needs a value to compare with`);
    return;
  }
  if (right && !fits(c.op, left, right)) {
    const taken = right.kind === 'option_set' ? 'these options' : `a ${right.kind} value`;
    ctx.issue('operator_type_mismatch', `${path}/right`, `'${c.op}' on ${left.kind} values cannot take ${taken}`);
  }
  if (baseOperator(c.op) === 'between') {
    if (!c.right2) ctx.issue('operator_type_mismatch', path, "'between' needs a second value");
    else if (right2 && !fits(c.op, left, right2)) {
      ctx.issue('operator_type_mismatch', `${path}/right2`, `'between' on ${left.kind} values cannot take a ${right2.kind} value`);
    }
  } else if (c.right2) {
    ctx.issue('operator_type_mismatch', `${path}/right2`, `'${c.op}' takes one value`);
  }
}

/** Types every leaf of a rule's `when` and collects the cells it reads. */
export function checkGroup(ctx: TypeContext, group: ConditionGroup, path: string, reads: Set<string>): void {
  let leaves = 0;
  let reported = false;
  const visit = (g: ConditionGroup, at: string, depth: number) => {
    if (depth > CONDITION_LIMITS.depth && !reported) {
      reported = true;
      ctx.issue('expr_too_large', at, `condition groups nest at most ${CONDITION_LIMITS.depth} deep`);
    }
    g.children.forEach((child, i) => {
      const childAt = `${at}/children/${i}`;
      if (child.kind === 'group') {
        visit(child, childAt, depth + 1);
        return;
      }
      leaves += 1;
      checkCondition(ctx, child, childAt, reads);
    });
  };
  visit(group, path, 1);
  if (leaves > CONDITION_LIMITS.leaves) ctx.issue('expr_too_large', path, `a rule may test at most ${CONDITION_LIMITS.leaves} conditions`);
}
