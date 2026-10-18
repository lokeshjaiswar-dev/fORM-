import { answerScalar, valueDefinition } from '@form/registry';
import { ANSWER_VALUE_SCHEMAS, VALUE_FIELD_TYPES } from '@form/schema';
import type {
  Action, AnswerValue, Answers, BlockId, CompiledForm, Condition, ConditionGroup, EndingId, EvalMeta, EvalState, Evaluate, Expr, FieldBlock,
  FormDefinition, FormVersion, Literal, Operand, PageId, PlanStep, PublicFormDefinition, Rule, RuleId, RuntimeFormVersion, ScalarValue,
  ServerAction, StoredBlock, ValueFieldType, ValueRef,
} from '@form/schema';
import { actionWrites, isClientAction } from './analyze.ts';
import { cell, stepKey } from './cells.ts';
import { ENGINE } from './compile.ts';
import { NULL, compare, equal, isNull, order } from './operators.ts';
import { ancestorsOf } from './structure.ts';
import { traceEntry, type TraceEntry } from './trace.ts';

/*
 * evaluate() (schema §3.3.7–9, §3.3.14): one pass over the compiled plan. Total: wrong-shaped answers
 * read as unanswered, unsupported nodes read as null, and both leave a diagnostic in the trace.
 * Deterministic: no clocks, no randomness, no floats, no host locale or Unicode tables.
 */

type Scope = 'client' | 'server';
type Definition = Readonly<FormDefinition> | PublicFormDefinition;
type Compiled = Pick<CompiledForm, 'engine' | 'documentOrder' | 'parentOf' | 'pageOf' | 'reads'> & { plan: readonly PlanStep[] };
export type EvaluableVersion = Pick<FormVersion, 'definition' | 'compiled'> | Pick<RuntimeFormVersion, 'definition' | 'compiled'>;

type Jump = { page: PageId } | { end: EndingId };

interface RuleStep { kind: 'rule'; step: PlanStep; key: string; server: boolean; rule: Rule; then: Map<string, boolean>; else: Map<string, boolean> | null }
interface PathStep { kind: 'on_path'; step: PlanStep; key: string; page: number }
/** `authoritative`: a static or expr source always decides the value; URL and UTM sources keep a resumed answer when absent. */
interface CaptureStep { kind: 'capture'; step: PlanStep; key: string; blockId: BlockId; authoritative: boolean }
interface OtherStep { kind: 'other'; step: PlanStep; key: string }
type Step = RuleStep | PathStep | CaptureStep | OtherStep;

interface Prepared {
  def: Definition;
  steps: Step[];
  writers: Map<string, number[]>;
  readers: Map<string, number[]>;
  blocks: ReadonlyMap<string, StoredBlock>;
  /** Value blocks in document order. */
  fields: FieldBlock[];
  documentOrder: readonly BlockId[];
  pageIds: readonly PageId[];
  pageIndex: ReadonlyMap<string, number>;
  /** Cell keys of each placed block, built once (evaluation is a hot path). */
  keys: ReadonlyMap<string, BlockKeys>;
  pageKeys: ReadonlyArray<{ visible: string; onPath: string; jump: string }>;
  /** Initial state of every cell that does not come from answers: visibility, enablement, requiredness. */
  staticCells: ReadonlyMap<string, unknown>;
  /** [blockId, value cell] of every value block. */
  valueCells: ReadonlyArray<readonly [BlockId, string]>;
  /** Cells each step writes. */
  stepWrites: ReadonlyArray<readonly string[]>;
}

interface BlockKeys { visible: string; value: string; enabled: string; required: string; ancestors: readonly string[]; onPath: string | null }

const VALUE_TYPES: ReadonlySet<string> = new Set(VALUE_FIELD_TYPES);
const isField = (block: StoredBlock | undefined): block is FieldBlock => block !== undefined && VALUE_TYPES.has(block.type);

/** Last write wins inside one action list. */
function writesOf(def: Definition, actions: readonly Action[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const action of actions) for (const [c, v] of actionWrites(def, action)) out.set(c, v);
  return out;
}

const prepared = new WeakMap<object, Prepared>();

function prepare(version: EvaluableVersion): Prepared {
  const cached = prepared.get(version.compiled);
  if (cached) return cached;
  const def = version.definition as Definition;
  const compiled = version.compiled as Compiled;
  if (compiled.engine !== ENGINE) throw new Error(`this version was compiled by '${String(compiled.engine)}'; @form/logic evaluates '${ENGINE}' only`);
  const rules = new Map<string, Rule>((def.logic.rules as readonly Rule[]).map((r) => [r.id, r]));
  const pageIndex = new Map(def.pages.map((p, i) => [p.id as string, i]));
  const steps: Step[] = compiled.plan.map((step) => {
    const key = stepKey(step);
    if (step.kind === 'rule') {
      const rule = rules.get(step.ruleId);
      if (!rule) return { kind: 'other', step, key };
      const otherwise = rule.else ? writesOf(def, rule.else) : null;
      return { kind: 'rule', step, key, server: step.scope === 'server', rule, then: writesOf(def, rule.then), else: otherwise };
    }
    if (step.kind === 'on_path') return { kind: 'on_path', step, key, page: pageIndex.get(step.pageId) ?? -1 };
    if (step.kind === 'capture') {
      const block = def.blocks[step.blockId];
      const authoritative = block?.type === 'hidden' && (block.config.source.kind === 'static' || block.config.source.kind === 'expr');
      return { kind: 'capture', step, key, blockId: step.blockId, authoritative };
    }
    return { kind: 'other', step, key };
  });
  const writers = new Map<string, number[]>();
  const readers = new Map<string, number[]>();
  const push = (map: Map<string, number[]>, c: string, i: number) => {
    const list = map.get(c);
    if (list) list.push(i);
    else map.set(c, [i]);
  };
  const stepWrites = steps.map((s): string[] => {
    if (s.kind === 'rule') return [...new Set([...s.then.keys(), ...(s.else?.keys() ?? [])])];
    if (s.kind === 'on_path') return [cell.onPath(def.pages[s.page]?.id ?? '')];
    if (s.kind === 'capture') return [cell.value(s.blockId)];
    return [];
  });
  steps.forEach((s, i) => {
    for (const c of compiled.reads[s.key] ?? []) push(readers, c, i);
    for (const c of stepWrites[i] ?? []) push(writers, c, i);
  });
  const blocks = new Map(Object.entries(def.blocks).flatMap(([id, b]) => (b ? [[id, b] as const] : [])));
  const fields = compiled.documentOrder.map((id) => blocks.get(id)).filter(isField);
  const keys = new Map(compiled.documentOrder.map((id): [string, BlockKeys] => {
    const page = compiled.pageOf[id];
    return [id, {
      visible: cell.visible(id), value: cell.value(id), enabled: cell.enabled(id), required: cell.required(id),
      ancestors: ancestorsOf(compiled, id).map((a) => cell.visible(a)), onPath: page === undefined ? null : cell.onPath(page),
    }];
  }));
  const staticCells = new Map<string, unknown>();
  for (const page of def.pages) staticCells.set(cell.visible(page.id), page.initiallyHidden !== true);
  const valueCells: Array<readonly [BlockId, string]> = [];
  for (const [id, block] of blocks) {
    staticCells.set(cell.visible(id), block.type === 'unsupported' || block.initiallyHidden !== true);
    if (!isField(block)) continue;
    staticCells.set(cell.enabled(id), block.initiallyDisabled !== true);
    staticCells.set(cell.required(id), block.required);
    valueCells.push([id as BlockId, cell.value(id)]);
  }
  const pageKeys = def.pages.map((pg) => ({ visible: cell.visible(pg.id), onPath: cell.onPath(pg.id), jump: cell.jump(pg.id) }));
  const p: Prepared = {
    def, steps, writers, readers, blocks, fields, documentOrder: compiled.documentOrder, pageIds: def.pages.map((pg) => pg.id), pageIndex,
    keys, pageKeys, staticCells, valueCells, stepWrites,
  };
  prepared.set(version.compiled, p);
  return p;
}

/** Answer twins are parsed once per answer object. */
const answerOk = new WeakMap<object, boolean>();
function validAnswer(block: StoredBlock | undefined, answer: AnswerValue | undefined): AnswerValue | undefined {
  if (answer === undefined || !isField(block)) return undefined;
  if (typeof answer !== 'object' || answer === null || answer.type !== block.type) return undefined;
  let ok = answerOk.get(answer);
  if (ok === undefined) {
    ok = ANSWER_VALUE_SCHEMAS[block.type].safeParse(answer).success;
    answerOk.set(answer, ok);
  }
  return ok ? answer : undefined;
}

function literalValue(literal: Literal): ScalarValue {
  switch (literal.type) {
    case 'text':
      return { t: 'text', v: literal.value };
    case 'number':
      return { t: 'number', v: literal.value };
    case 'money':
      return { t: 'money', v: literal.value, currency: literal.currency };
    case 'boolean':
      return { t: 'boolean', v: literal.value };
    case 'date':
      return { t: 'date', v: literal.value };
    case 'time':
      return { t: 'time', v: literal.value };
    case 'datetime':
      return { t: 'datetime', v: literal.value, tz: literal.tz };
    default:
      return NULL;
  }
}

const text = (v: string | undefined): ScalarValue => (v === undefined ? NULL : { t: 'text', v });

class Session {
  private cells = new Map<string, unknown>();
  readonly outputs: unknown[];
  readonly diagnostics: string[][];
  private answers: Answers = {};
  /** Blocks whose answer failed its twin: they read as unanswered. */
  private readonly rejected = new Set<string>();
  private current = -1;
  private readonly p: Prepared;
  private readonly meta: EvalMeta;
  private readonly scope: Scope;
  private readonly tracing: boolean;

  constructor(p: Prepared, meta: EvalMeta, scope: Scope, tracing: boolean) {
    this.p = p;
    this.meta = meta;
    this.scope = scope;
    this.tracing = tracing;
    this.outputs = p.steps.map(() => undefined);
    this.diagnostics = p.steps.map(() => []);
  }

  /* ── cells ─────────────────────────────────────────────────────────── */

  /** The answer a value cell starts from: the validated answer, or nothing. */
  private answerCell(id: BlockId): AnswerValue | undefined {
    const answer = Object.hasOwn(this.answers, id) ? this.answers[id] : undefined;
    const valid = validAnswer(this.p.blocks.get(id), answer);
    if (answer !== undefined && valid === undefined) this.rejected.add(id);
    else this.rejected.delete(id);
    return valid;
  }

  private initial(c: string): unknown {
    const fixed = this.p.staticCells.get(c);
    if (fixed !== undefined) return fixed;
    if (c.startsWith('value:')) return this.answerCell(c.slice(6) as BlockId);
    return c.startsWith('onPath:') ? false : undefined;
  }

  private flag(c: string): boolean {
    return this.cells.get(c) === true;
  }

  private note(message: string): void {
    const notes = this.tracing && this.current >= 0 ? this.diagnostics[this.current] : undefined;
    if (notes && !notes.includes(message)) notes.push(message);
  }

  /** visible_eff(b): b and every ancestor visible, and its page on the path (§3.3.8). */
  visibleEff(id: BlockId): boolean {
    const k = this.p.keys.get(id);
    if (!k || k.onPath === null || !this.flag(k.visible) || !this.flag(k.onPath)) return false;
    for (const a of k.ancestors) if (!this.flag(a)) return false;
    return true;
  }

  private answerOf(id: BlockId): AnswerValue | undefined {
    if (this.rejected.has(id)) this.note(`the answer for '${id}' is not a valid ${this.p.blocks.get(id)?.type ?? 'block'} answer and reads as unanswered`);
    return this.cells.get(this.p.keys.get(id)?.value ?? cell.value(id)) as AnswerValue | undefined;
  }

  /* ── values ────────────────────────────────────────────────────────── */

  private refValue(ref: ValueRef): ScalarValue {
    if (ref.kind === 'meta') return this.metaValue(ref);
    if (ref.kind === 'variable') {
      const v = this.cells.get(cell.variable(ref.varId)) as ScalarValue | undefined;
      return v ?? NULL;
    }
    const block = this.p.blocks.get(ref.blockId);
    if (!isField(block) || !this.visibleEff(ref.blockId)) return NULL;
    const answer = this.answerOf(ref.blockId);
    if (!answer) return NULL;
    return answerScalar(block as never, answer.value as never, ref.path);
  }

  private metaValue(ref: Extract<ValueRef, { kind: 'meta' }>): ScalarValue {
    const m = this.meta;
    switch (ref.key) {
      case 'locale':
        return text(m.locale);
      case 'time_zone':
        return text(m.timeZone);
      case 'device':
        return text(m.device);
      case 'url_param':
        return ref.name === undefined ? NULL : text(Object.hasOwn(m.urlParams, ref.name) ? m.urlParams[ref.name] : undefined);
      case 'page_url':
        return text(m.pageUrl);
      case 'referrer':
        return text(m.referrer);
      case 'embed_origin':
        return text(m.embedOrigin);
      case 'utm_source':
      case 'utm_medium':
      case 'utm_campaign':
      case 'utm_term':
      case 'utm_content':
        return text(Object.hasOwn(m.urlParams, ref.key) ? m.urlParams[ref.key] : undefined);
      case 'is_preview':
        return { t: 'boolean', v: m.isPreview };
      default:
        this.note(`meta '${ref.key}' is not available in logic@2 P0 and reads as null`);
        return NULL;
    }
  }

  private exprValue(expr: Expr, depth = 0): ScalarValue {
    if (depth > 64) return NULL;
    switch (expr.k) {
      case 'lit':
        return literalValue(expr.value);
      case 'ref':
        return this.refValue(expr.ref);
      case 'binary': {
        const op = expr.op;
        if (op !== '==' && op !== '!=' && op !== '<' && op !== '<=' && op !== '>' && op !== '>=') break;
        const a = this.exprValue(expr.left, depth + 1);
        const b = this.exprValue(expr.right, depth + 1);
        if (op === '==' || op === '!=') return { t: 'boolean', v: equal(a, b, true) === (op === '==') };
        if (isNull(a) || isNull(b)) return NULL;
        const sign = order(a, b);
        if (sign === null) return NULL;
        return { t: 'boolean', v: op === '<' ? sign < 0 : op === '<=' ? sign <= 0 : op === '>' ? sign > 0 : sign >= 0 };
      }
      default:
        break;
    }
    this.note(`'${expr.k === 'binary' ? expr.op : expr.k}' expressions are not available in logic@2 P0 and read as null`);
    return NULL;
  }

  private operandValue(operand: Operand | undefined): ScalarValue {
    if (!operand) return NULL;
    switch (operand.kind) {
      case 'ref':
        return this.refValue(operand.ref);
      case 'literal':
        return literalValue(operand.value);
      case 'options':
        return { t: 'list', of: 'option', items: operand.optionIds.map((v) => ({ t: 'option', blockId: operand.blockId, v })) };
      case 'expr':
        return this.exprValue(operand.expr);
      default:
        return NULL;
    }
  }

  /** is_answered: an answer ref is answered when visible, present and not empty (I9); any other operand when not null. */
  private answered(operand: Operand, left: ScalarValue): boolean {
    if (operand.kind !== 'ref' || operand.ref.kind !== 'answer' || (operand.ref.path ?? '') !== '') return !isNull(left);
    const { blockId } = operand.ref;
    const block = this.p.blocks.get(blockId);
    const answer = this.answerOf(blockId);
    if (!isField(block) || !answer || !this.visibleEff(blockId)) return false;
    return !(valueDefinition(block.type as ValueFieldType).isEmpty as (value: unknown) => boolean)(answer.value);
  }

  private condition(c: Condition): boolean {
    const left = this.operandValue(c.left);
    return compare({
      op: c.op,
      left,
      right: this.operandValue(c.right),
      right2: this.operandValue(c.right2),
      caseSensitive: c.caseSensitive === true,
      answered: this.answered(c.left, left),
    });
  }

  private group(g: ConditionGroup, depth = 0): boolean {
    if (depth > 16) return false;
    const test = (child: Condition | ConditionGroup) => (child.kind === 'group' ? this.group(child, depth + 1) : this.condition(child));
    const result = g.combinator === 'all' ? g.children.every(test) : g.children.some(test);
    return g.negate ? !result : result;
  }

  /* ── path ──────────────────────────────────────────────────────────── */

  private pageVisible(i: number): boolean {
    const k = this.p.pageKeys[i];
    return k !== undefined && this.flag(k.visible);
  }

  private nextIndex(from: number, upTo: number): number {
    const k = this.p.pageKeys[from];
    const jump = k === undefined ? undefined : (this.cells.get(k.jump) as Jump | undefined);
    if (jump && 'end' in jump) return -1;
    const start = jump ? Math.max((this.p.pageIndex.get(jump.page) ?? from + 1), from + 1) : from + 1;
    for (let i = start; i <= upTo; i += 1) if (this.pageVisible(i)) return i;
    return -1;
  }

  private firstPage(upTo: number): number {
    for (let i = 0; i <= upTo; i += 1) if (this.pageVisible(i)) return i;
    return -1;
  }

  /** onPath(p): walking from the first visible page through jumps and visible pages reaches p (§3.3.9). */
  private reaches(target: number): boolean {
    let cur = this.firstPage(target);
    while (cur !== -1 && cur < target) cur = this.nextIndex(cur, target);
    return cur === target;
  }

  /* ── steps ─────────────────────────────────────────────────────────── */

  private run(i: number): unknown {
    const s = this.p.steps[i] as Step;
    this.current = i;
    if (this.tracing) this.diagnostics[i] = [];
    switch (s.kind) {
      case 'rule':
        if (s.server && this.scope !== 'server') return null;
        return this.group(s.rule.when);
      case 'on_path':
        return this.reaches(s.page);
      case 'capture':
        return this.capture(s.blockId, this.outputs[i]);
      default:
        this.note(`'${s.step.kind}' steps are not available in logic@2 P0`);
        return null;
    }
  }

  private capture(id: BlockId, previous: unknown): AnswerValue | null {
    const block = this.p.blocks.get(id);
    if (block?.type !== 'hidden') return null;
    const source = block.config.source;
    let v: ScalarValue = NULL;
    if (source.kind === 'url_param') {
      const name = source.name ?? block.key;
      v = text(Object.hasOwn(this.meta.urlParams, name) ? this.meta.urlParams[name] : undefined);
    } else if (source.kind === 'utm') {
      const name = `utm_${source.param}`;
      v = text(Object.hasOwn(this.meta.urlParams, name) ? this.meta.urlParams[name] : undefined);
    } else if (source.kind === 'static') {
      v = text(source.value.map((part) => (typeof part === 'string' ? part : '')).join(''));
    } else {
      v = this.exprValue(source.expr);
    }
    if (v.t !== 'text' || v.v === '') return null;
    const prev = previous as AnswerValue | null | undefined;
    return prev?.type === 'hidden' && prev.value === v.v ? prev : { type: 'hidden', value: v.v };
  }

  /** The value `step` writes to `c` given its output, on top of `current`. */
  private applyOne(i: number, c: string, current: unknown): unknown {
    const s = this.p.steps[i] as Step;
    const out = this.outputs[i];
    if (s.kind === 'rule') {
      if (out === null || out === undefined) return current;
      const writes = out ? s.then : s.else;
      return writes?.has(c) ? writes.get(c) : current;
    }
    if (s.kind === 'on_path') return out === true;
    if (s.kind === 'capture') return out ?? (s.authoritative ? undefined : current);
    return current;
  }

  private apply(i: number): void {
    const s = this.p.steps[i] as Step;
    const out = this.outputs[i];
    if (s.kind === 'rule') {
      if (out === null || out === undefined) return;
      for (const [c, v] of (out ? s.then : s.else) ?? []) this.cells.set(c, v);
    } else if (s.kind === 'on_path') {
      for (const c of this.p.stepWrites[i] ?? []) this.cells.set(c, out === true);
    } else if (s.kind === 'capture' && (out || s.authoritative)) {
      for (const c of this.p.stepWrites[i] ?? []) this.cells.set(c, out ?? undefined);
    }
  }

  /** Recomputes `c` from its initial state and every writer in plan order; true when it changed. */
  private recompute(c: string): boolean {
    let v = this.initial(c);
    for (const w of this.p.writers.get(c) ?? []) v = this.applyOne(w, c, v);
    const changed = !Object.is(v, this.cells.get(c));
    if (changed) this.cells.set(c, v);
    return changed;
  }

  full(answers: Answers): void {
    this.answers = answers;
    this.current = -1;
    this.cells = new Map(this.p.staticCells);
    for (const [id, c] of this.p.valueCells) this.cells.set(c, this.answerCell(id));
    for (let i = 0; i < this.p.steps.length; i += 1) {
      this.outputs[i] = this.run(i);
      this.apply(i);
    }
    this.current = -1;
  }

  /** Re-runs only the steps downstream of the changed answers (§3.3.14); the result equals a full pass. */
  update(answers: Answers, changed: Iterable<BlockId>): void {
    this.answers = answers;
    this.current = -1;
    const dirty = new Uint8Array(this.p.steps.length);
    const touch = (c: string) => {
      for (const r of this.p.readers.get(c) ?? []) dirty[r] = 1;
    };
    for (const id of changed) {
      const c = cell.value(id);
      if (!this.p.blocks.has(id)) continue;
      /* An answer going between absent and invalid leaves the cell undefined but changes the readers' diagnostics. */
      const wasRejected = this.rejected.has(id);
      if (this.recompute(c) || wasRejected !== this.rejected.has(id)) touch(c);
    }
    for (let i = 0; i < dirty.length; i += 1) {
      if (!dirty[i]) continue;
      const out = this.run(i);
      if (Object.is(out, this.outputs[i])) continue;
      this.outputs[i] = out;
      for (const c of this.p.stepWrites[i] ?? []) if (this.recompute(c)) touch(c);
    }
    this.current = -1;
  }

  /* ── result ────────────────────────────────────────────────────────── */

  private serverEffects(): Array<ServerAction & { ruleId: RuleId }> {
    if (this.scope !== 'server') return [];
    const effects: Array<ServerAction & { ruleId: RuleId }> = [];
    this.p.steps.forEach((s, i) => {
      if (s.kind !== 'rule') return;
      const out = this.outputs[i];
      const actions = out === true ? s.rule.then : out === false ? (s.rule.else ?? []) : [];
      for (const a of actions) if (!isClientAction(a)) effects.push({ ...a, ruleId: s.rule.id });
    });
    return effects;
  }

  state(): EvalState {
    const { p } = this;
    const visible = new Set<BlockId | PageId>();
    for (const page of p.pageIds) if (this.flag(cell.onPath(page))) visible.add(page);
    for (const id of p.documentOrder) if (this.visibleEff(id)) visible.add(id);
    const required = new Set<BlockId>();
    const disabled = new Set<BlockId>();
    const values: Answers = {};
    for (const block of p.fields) {
      const id = block.id;
      const enabled = this.flag(cell.enabled(id));
      if (!enabled) disabled.add(id);
      const answer = this.answerOf(id);
      const shown = visible.has(id);
      if (shown && enabled && answer) values[id] = answer;
      if (this.flag(cell.required(id)) && shown && enabled && !(block.readOnly === true && !answer)) required.add(id);
    }
    const endingId = (this.cells.get(cell.ending()) as EndingId | undefined) ?? p.def.defaultEndingId;
    const last = p.pageIds.length - 1;
    const path: PageId[] = [];
    for (let i = this.firstPage(last); i !== -1; i = this.nextIndex(i, last)) path.push(p.pageIds[i] as PageId);
    const nextPage = (from: PageId): PageId | { end: EndingId } => {
      const index = p.pageIndex.get(from);
      const next = index === undefined ? -1 : this.nextIndex(index, last);
      const jump = this.cells.get(cell.jump(from)) as Jump | undefined;
      if (next === -1) return { end: jump && 'end' in jump ? jump.end : endingId };
      return p.pageIds[next] as PageId;
    };
    const state: EvalState = {
      visible, required, disabled, hiddenOptions: {}, values, variables: {}, submitBlocks: [], nextPage, path, endingId, serverEffects: this.serverEffects(),
    };
    if (this.tracing) {
      state.trace = p.steps.map((s, i): TraceEntry => {
        const out = this.outputs[i];
        return traceEntry(s.step, s.kind === 'rule' && typeof out === 'boolean' ? out : null, this.diagnostics[i] ?? []);
      });
    }
    return state;
  }
}

export interface Evaluator {
  /** A full pass over the plan. */
  evaluate(answers: Answers): EvalState;
  /** Re-runs only the steps that read the changed blocks' values, directly or transitively; equals `evaluate(answers)`. */
  update(answers: Answers, changed: Iterable<BlockId>): EvalState;
}

/**
 * A stateful evaluator for one session (frozen `meta`), for incremental client evaluation.
 *
 * Inputs are immutable: the prepared plan is cached per `version.compiled` object and each answer's twin
 * verdict per answer object, and `update` compares answers by identity. Pass a new object for every
 * changed answer; never mutate a version or an answer in place.
 */
export function createEvaluator(version: EvaluableVersion, meta: EvalMeta, scope: Scope, opts: { trace?: boolean } = {}): Evaluator {
  const session = new Session(prepare(version), meta, scope, opts.trace === true);
  let started = false;
  return {
    evaluate(answers) {
      session.full(answers);
      started = true;
      return session.state();
    },
    update(answers, changed) {
      if (started) session.update(answers, changed);
      else session.full(answers);
      started = true;
      return session.state();
    },
  };
}

/**
 * One full pass (schema §3.3.7), with the immutability contract of `createEvaluator`. Keep loaded versions
 * cached: preparing the plan is paid once per `compiled` object.
 */
export const evaluate: Evaluate = (version, answers, meta, scope, opts) => createEvaluator(version, meta, scope, opts).evaluate(answers);
