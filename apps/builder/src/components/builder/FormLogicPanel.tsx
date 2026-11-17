import { Plus, Trash2 } from 'lucide-react';
import type { ComponentProps } from 'react';
import { defineMessages, type MessageId } from '@form/i18n';
import { isAvailable } from '@form/registry';
import type {
  Action, BlockId, Condition, ConditionId, DecimalString, Expr, FieldBlock, FormDefinition, LogicOperator, Operand, OptionId, Rule, RuleId,
} from '@form/schema';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { APP_IDS, blockOrder, blockText, isField } from '@/lib/definition';
import { labelString } from '@/fields/style';
import { removeRule, setRule } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { Button, Input, RadioField, RadioGroup, Switch } from '@dmacq/ui';
import { NiceSelect } from '@/components/NiceSelect';
import {
  choiceOptions, firstOperator, kindOf, literal, localToday, operatorsFor, retarget,
  type Defaults,
} from '@/components/builder/inspector/conditions';

const M = defineMessages('builder', {
  'rules.intro': 'Name a rule, compare two fields, then say what happens if it matches and if it does not.',
  'rules.add': 'Add a rule',
  'rules.empty': 'No checks yet.',
  'rules.no_fields': 'Add questions to the form before writing a check.',
  'rules.name': 'Name',
  'rules.name_placeholder': 'Untitled check',
  'rules.enabled': 'This check is on',
  'rules.remove': 'Remove this check',
  'rules.when': 'When all of these are true',
  'rules.add_when': 'Add condition',
  'rules.remove_when': 'Remove condition',
  'rules.question': 'Question',
  'rules.operator': 'Condition',
  'rules.value': 'Value',
  'rules.options': 'Options',
  'rules.compare': 'Compare with',
  'rules.typed': 'A value I type',
  'rules.other_field': 'Another question',
  'rules.then': 'Then',
  'rules.error_on': 'Show this error on',
  'rules.message': 'Error message',
  'rules.message_placeholder': 'This answer does not match.',
  'rules.field_place': 'Place',
  'rules.before': 'Before',
  'rules.after': 'After',
  'rules.field_anchor': 'Next to',
  'rules.fill_intro': 'Fill or calculate a field.',
  'rules.add_fill': 'Add a rule',
  'rules.then_action': 'Then',
  'rules.else_action': 'Otherwise',
  'rules.none': 'Nothing',
  'rules.act_set': 'Set a number',
  'rules.act_percent': 'Percent of a field',
  'rules.act_score': 'Option value',
  'rules.act_show': 'Show',
  'rules.act_hide': 'Hide',
  'rules.target': 'Field',
  'rules.source': 'From',
  'rules.amount': 'Amount',
  'rules.percent': 'Percent',
  'rules.untitled': 'Untitled {type}',
  'rules.source_placeholder': 'Select a question',
  'op.is_answered': 'is answered',
  'op.is_not_answered': 'is not answered',
  'op.eq': 'is',
  'op.neq': 'is not',
  'op.contains': 'contains',
  'op.not_contains': 'does not contain',
  'op.starts_with': 'starts with',
  'op.not_starts_with': 'does not start with',
  'op.ends_with': 'ends with',
  'op.not_ends_with': 'does not end with',
  'op.gt': 'is greater than',
  'op.gte': 'is at least',
  'op.lt': 'is less than',
  'op.lte': 'is at most',
  'op.before': 'is before',
  'op.after': 'is after',
  'op.on_or_before': 'is on or before',
  'op.on_or_after': 'is on or after',
  'op.includes_any': 'includes any of',
  'op.includes_all': 'includes all of',
  'op.includes_none': 'includes none of',
  'op.count_eq': 'has exactly this many',
  'op.count_gte': 'has at least this many',
  'op.count_lte': 'has at most this many',
});

const opLabel = (op: LogicOperator): string => {
  const id = (M as Record<string, MessageId>)[`op.${op}`];
  return id ? t(id) : op;
};

const newId = () => APP_IDS.newId();

function fieldsOf(def: FormDefinition): FieldBlock[] {
  return blockOrder(def).map((id) => def.blocks[id]).filter((b): b is FieldBlock => isField(b) && isAvailable(b.type) && operatorsFor(b).length > 0);
}

function emptyCondition(source: FieldBlock, defaults: Defaults): Condition {
  const op = firstOperator(source, defaults);
  return retarget(newId() as ConditionId, source, op, undefined, defaults);
}

const literalText = (operand: Operand | undefined): string => (operand?.kind === 'literal' && 'value' in operand.value ? String(operand.value.value) : '');

type Part = 'whole' | 'first' | 'last' | 'code' | 'score' | 'option';
type ActKind = 'show' | 'hide' | 'error' | 'set' | 'percent' | 'none';

const TEXT_OPS: LogicOperator[] = ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'not_starts_with', 'ends_with', 'not_ends_with'];
const NUMBER_OPS: LogicOperator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];
const DATE_OPS: LogicOperator[] = ['eq', 'neq', 'before', 'after', 'on_or_before', 'on_or_after'];

function partsFor(field: FieldBlock): Part[] {
  const kind = kindOf(field);
  if (kind === 'choice' || kind === 'choices') return ['code', 'option', 'score', 'first', 'last'];
  if (kind === 'text') return ['whole', 'first', 'last'];
  if (kind === 'number') return ['whole'];
  if (kind === 'date' || kind === 'time') return ['whole'];
  return ['whole'];
}

function opsFor(field: FieldBlock, part: Part): LogicOperator[] {
  if (part === 'option') return ['eq', 'neq'];
  if (part === 'score' || kindOf(field) === 'number') return NUMBER_OPS;
  if (part === 'whole' && (kindOf(field) === 'date' || kindOf(field) === 'time')) return DATE_OPS;
  return TEXT_OPS;
}

function answerExpr(id: BlockId): Expr {
  return { k: 'ref', ref: { kind: 'answer', blockId: id } };
}

function litNum(n: string): Expr {
  const value = (/^\d+$/.test(n) ? n : '2') as DecimalString;
  return { k: 'lit', value: { type: 'number', value } };
}

function sideOperand(field: FieldBlock, part: Part, n: string): Operand {
  const id = field.id;
  if (part === 'whole' || part === 'option') return { kind: 'ref', ref: { kind: 'answer', blockId: id } };
  if (part === 'code') return { kind: 'expr', expr: { k: 'call', fn: 'option_code', args: [answerExpr(id)] } };
  if (part === 'score') return { kind: 'expr', expr: { k: 'call', fn: 'option_score', args: [answerExpr(id)] } };
  const base: Expr = kindOf(field) === 'choice' || kindOf(field) === 'choices'
    ? { k: 'call', fn: 'option_code', args: [answerExpr(id)] }
    : answerExpr(id);
  return { kind: 'expr', expr: { k: 'call', fn: part === 'first' ? 'left' : 'right', args: [base, litNum(n)] } };
}

function readSide(operand: Operand | undefined, _fields: FieldBlock[]): { fieldId: BlockId; part: Part; n: string } | null {
  if (!operand) return null;
  if (operand.kind === 'ref' && operand.ref.kind === 'answer') {
    const id = operand.ref.blockId;
    const part: Part = 'whole';
    return { fieldId: id, part, n: '2' };
  }
  if (operand.kind !== 'expr') return null;
  const expr = operand.expr;
  if (expr.k === 'call' && (expr.fn === 'option_code' || expr.fn === 'option_score') && expr.args[0]?.k === 'ref' && expr.args[0].ref.kind === 'answer') {
    return { fieldId: expr.args[0].ref.blockId, part: expr.fn === 'option_code' ? 'code' : 'score', n: '2' };
  }
  if (expr.k === 'call' && (expr.fn === 'left' || expr.fn === 'right')) {
    const n = expr.args[1]?.k === 'lit' && expr.args[1].value.type === 'number' ? expr.args[1].value.value : '2';
    const inner = expr.args[0];
    if (inner?.k === 'ref' && inner.ref.kind === 'answer') return { fieldId: inner.ref.blockId, part: expr.fn === 'left' ? 'first' : 'last', n };
    if (inner?.k === 'call' && inner.fn === 'option_code' && inner.args[0]?.k === 'ref' && inner.args[0].ref.kind === 'answer') {
      return { fieldId: inner.args[0].ref.blockId, part: expr.fn === 'left' ? 'first' : 'last', n };
    }
  }
  return null;
}

function partLabel(part: Part): string {
  if (part === 'whole') return 'Whole value';
  if (part === 'first') return 'First characters';
  if (part === 'last') return 'Last characters';
  if (part === 'code') return 'Option value';
  if (part === 'score') return 'Option score';
  return 'Selected option';
}

function fieldName(field: FieldBlock | undefined): string {
  return field ? (blockText(field) || field.key) : '';
}

function ComparisonRow({
  cond, fields, onChange, onRemove, canRemove,
}: {
  cond: Condition;
  fields: FieldBlock[];
  onChange: (next: Condition) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const left = readSide(cond.left, fields);
  const leftField = fields.find((f) => f.id === left?.fieldId);
  const rightSide = readSide(cond.right, fields);
  const typed = cond.right?.kind === 'literal' || cond.right?.kind === 'options';
  const [draft, setDraft] = useDraft(literalText(cond.right));
  const write = (nextLeft: FieldBlock, part: Part, n: string, op: LogicOperator, right: Operand | undefined) => {
    onChange({ kind: 'condition', id: cond.id, left: sideOperand(nextLeft, part, n), op, ...(right ? { right } : {}) });
  };
  const pickLeft = (id: string) => {
    const field = fields.find((f) => f.id === id);
    if (!field) return;
    const part = partsFor(field)[0] ?? 'whole';
    const op = opsFor(field, part)[0] ?? 'eq';
    write(field, part, '2', op, undefined);
  };
  if (!left || !leftField) {
    return (
      <NiceSelect size="sm" aria-label={t(M['rules.question'])} value="" onChange={pickLeft} placeholder={t(M['rules.source_placeholder'])} options={fields.map((f) => ({ value: f.id, label: fieldName(f) }))} />
    );
  }
  const part = partsFor(leftField).includes(left.part) ? left.part : (partsFor(leftField)[0] ?? 'whole');
  const ops = opsFor(leftField, part);
  const op = ops.includes(cond.op) ? cond.op : (ops[0] ?? 'eq');
  const peers = fields.filter((f) => f.id !== leftField.id && opsFor(f, partsFor(f)[0] ?? 'whole').some((candidate) => TEXT_OPS.includes(candidate) === TEXT_OPS.includes(op) || NUMBER_OPS.includes(candidate) === NUMBER_OPS.includes(op)));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <NiceSelect size="sm" aria-label={t(M['rules.question'])} value={leftField.id} onChange={pickLeft} options={fields.map((f) => ({ value: f.id, label: fieldName(f) }))} />
        <NiceSelect size="sm" aria-label="Part" value={part} onChange={(value) => write(leftField, value as Part, left.n, opsFor(leftField, value as Part)[0] ?? 'eq', undefined)} options={partsFor(leftField).map((p) => ({ value: p, label: partLabel(p) }))} />
        {part === 'first' || part === 'last' ? (
          <LooseInput aria-label="How many characters" className="w-16" value={left.n} commit={(text) => /^\d+$/.test(text) && write(leftField, part, text, op, cond.right)} />
        ) : null}
        <NiceSelect size="sm" aria-label={t(M['rules.operator'])} value={op} onChange={(value) => write(leftField, part, left.n, value as LogicOperator, cond.right)} options={ops.map((item) => ({ value: item, label: opLabel(item) }))} />
        {part === 'option' ? (
          <RadioGroup name={cond.id} value={cond.right?.kind === 'options' ? (cond.right.optionIds[0] ?? '') : ''} onValueChange={(id) => write(leftField, part, left.n, op, { kind: 'options', blockId: leftField.id, optionIds: [id as OptionId] })}>
            {choiceOptions(leftField).map((o) => (
              <RadioField key={o.id} value={o.id} label={labelString(o.label)} size="sm" />
            ))}
          </RadioGroup>
        ) : (
          <>
            <NiceSelect
              size="sm"
              aria-label={t(M['rules.compare'])}
              value={typed || !rightSide ? 'typed' : rightSide.fieldId}
              onChange={(id) => {
                if (id === 'typed') write(leftField, part, left.n, op, literal(kindOf(leftField) === 'number' || part === 'score' ? 'number' : 'text', op, '') ?? undefined);
                else {
                  const other = fields.find((f) => f.id === id);
                  if (other) write(leftField, part, left.n, op, sideOperand(other, partsFor(other).includes(part) ? part : (partsFor(other)[0] ?? 'whole'), left.n));
                }
              }}
              options={[{ value: 'typed', label: t(M['rules.typed']) }, ...peers.map((f) => ({ value: f.id, label: fieldName(f) }))]}
            />
            {rightSide && !typed ? (
              <>
                <NiceSelect size="sm" aria-label="Other part" value={rightSide.part} onChange={(value) => {
                  const other = fields.find((f) => f.id === rightSide.fieldId);
                  if (other) write(leftField, part, left.n, op, sideOperand(other, value as Part, rightSide.n));
                }} options={partsFor(fields.find((f) => f.id === rightSide.fieldId) ?? leftField).map((p) => ({ value: p, label: partLabel(p) }))} />
                {rightSide.part === 'first' || rightSide.part === 'last' ? (
                  <LooseInput aria-label="Other character count" className="w-16" value={rightSide.n} commit={(text) => {
                    const other = fields.find((f) => f.id === rightSide.fieldId);
                    if (other && /^\d+$/.test(text)) write(leftField, part, left.n, op, sideOperand(other, rightSide.part, text));
                  }} />
                ) : null}
              </>
            ) : (
              <Input aria-label={t(M['rules.value'])} value={draft} onChange={(e) => {
                setDraft(e.target.value);
                const next = literal(part === 'score' || kindOf(leftField) === 'number' ? 'number' : 'text', op, e.target.value);
                if (next) write(leftField, part, left.n, op, next);
              }} />
            )}
          </>
        )}
      </div>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['rules.remove_when'])} disabled={!canRemove} onClick={onRemove}><Trash2 className="size-3.5" /></Button>
    </div>
  );
}

/** Keeps spaces and a cleared field on screen. The store is updated only when `commit` accepts the text. */
function LooseInput({ value, commit, ...props }: { value: string; commit: (text: string) => void } & Omit<ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useDraft(value);
  return (
    <Input
      {...props}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        commit(e.target.value);
      }}
    />
  );
}

function actKind(action: Action | undefined): ActKind {
  if (!action) return 'none';
  if (action.type === 'show' || action.type === 'hide') return action.type;
  if (action.type === 'block_submit') return 'error';
  if (action.type === 'set_value' && action.value.k === 'binary') return 'percent';
  if (action.type === 'set_value') return 'set';
  return 'none';
}

function actTarget(action: Action | undefined): string {
  if (!action) return '';
  if (action.type === 'show' || action.type === 'hide') return action.targets[0] ?? '';
  if (action.type === 'block_submit') return action.anchorBlockId ?? '';
  if (action.type === 'set_value') return action.target;
  return '';
}

function percentExpr(blockId: BlockId, percent: string): Expr {
  const amount = (/^-?(0|[1-9]\d*)(\.\d{1,10})?$/.test(percent) ? percent : '0') as DecimalString;
  return { k: 'binary', op: '/', left: { k: 'binary', op: '*', left: answerExpr(blockId), right: { k: 'lit', value: { type: 'number', value: amount } } }, right: { k: 'lit', value: { type: 'number', value: '100' as DecimalString } } };
}

function buildAction(kind: ActKind, target: BlockId, extra: { message?: string; amount?: string; source?: BlockId }): Action | null {
  if (!target || kind === 'none') return null;
  if (kind === 'show' || kind === 'hide') return { type: kind, targets: [target] };
  if (kind === 'error') return { type: 'block_submit', message: extra.message || 'This answer does not match.', anchorBlockId: target };
  if (kind === 'percent') return { type: 'set_value', target, value: percentExpr(extra.source || target, extra.amount || '0') };
  const amount = (/^-?(0|[1-9]\d*)(\.\d{1,10})?$/.test(extra.amount ?? '') ? extra.amount : '0') as DecimalString;
  return { type: 'set_value', target, value: { k: 'lit', value: { type: 'number', value: amount } } };
}

function EffectBlock({
  title, actions, fields, onChange,
}: {
  title: string;
  actions: Action[];
  fields: FieldBlock[];
  onChange: (next: Action[]) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-medium text-muted-foreground">{title}</p>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Add to ${title}`} onClick={() => onChange([...actions, { type: 'show', targets: [fields[0]?.id].filter(Boolean) as BlockId[] }])}>
          <Plus className="size-3.5" />
        </Button>
      </div>
      {actions.map((action, index) => {
        const kind = actKind(action);
        const target = actTarget(action);
        const message = action.type === 'block_submit' ? action.message : '';
        const amount = action.type === 'set_value' && action.value.k === 'lit' && action.value.value.type === 'number'
          ? action.value.value.value
          : action.type === 'set_value' && action.value.k === 'binary' && action.value.left.k === 'binary' && action.value.left.right.k === 'lit' && action.value.left.right.value.type === 'number'
            ? action.value.left.right.value.value
            : '';
        const source = action.type === 'set_value' && action.value.k === 'binary' && action.value.left.k === 'binary' && action.value.left.left.k === 'ref' && action.value.left.left.ref.kind === 'answer'
          ? action.value.left.left.ref.blockId
          : '';
        const set = (next: Action | null) => onChange(next ? actions.map((item, i) => (i === index ? next : item)) : actions.filter((_, i) => i !== index));
        return (
          <div key={`${action.type}-${index}`} className="space-y-2">
            <NiceSelect size="sm" aria-label={t(M['rules.target'])} value={target} onChange={(id) => set(buildAction(kind, id as BlockId, { message, amount, source: source as BlockId }))} options={fields.map((f) => ({ value: f.id, label: fieldName(f) }))} />
            <NiceSelect size="sm" aria-label={title} value={kind} onChange={(value) => set(buildAction(value as ActKind, (target || fields[0]?.id) as BlockId, { message, amount, source: source as BlockId }))} options={[
              { value: 'show', label: t(M['rules.act_show']) },
              { value: 'hide', label: t(M['rules.act_hide']) },
              { value: 'error', label: 'Show error' },
              { value: 'set', label: t(M['rules.act_set']) },
              { value: 'percent', label: t(M['rules.act_percent']) },
            ]} />
            {kind === 'error' ? (
              <LooseInput aria-label={t(M['rules.message'])} value={message} commit={(text) => { if (text.trim()) set(buildAction('error', target as BlockId, { message: text })); }} />
            ) : null}
            {kind === 'set' || kind === 'percent' ? (
              <LooseInput aria-label={kind === 'percent' ? t(M['rules.percent']) : t(M['rules.amount'])} value={amount} commit={(text) => { if (/^-?(0|[1-9]\d*)(\.\d{1,10})?$/.test(text)) set(buildAction(kind, target as BlockId, { message, amount: text, source: source as BlockId })); }} />
            ) : null}
            {kind === 'percent' ? (
              <NiceSelect size="sm" aria-label={t(M['rules.source'])} value={source} onChange={(id) => set(buildAction('percent', target as BlockId, { amount, source: id as BlockId }))} options={fields.map((f) => ({ value: f.id, label: fieldName(f) }))} />
            ) : null}
            <Button type="button" variant="ghost" size="sm" onClick={() => set(null)}>Remove</Button>
          </div>
        );
      })}
    </div>
  );
}

function RuleCard({ rule, fields }: { rule: Rule; fields: FieldBlock[] }) {
  const conditions = rule.when.children.filter((c): c is Condition => c.kind === 'condition');
  const write = (patch: { name?: string; enabled?: boolean; conditions?: Condition[]; then?: Action[]; else?: Action[] }) => {
    const name = patch.name !== undefined ? patch.name : (rule.name ?? '');
    const then = patch.then ?? rule.then;
    if (!then.length) return;
    const otherwise = patch.else === undefined ? rule.else : patch.else;
    setRule({
      id: rule.id,
      ...(name ? { name } : {}),
      enabled: patch.enabled ?? rule.enabled,
      when: { kind: 'group', id: rule.when.id, combinator: 'all', children: patch.conditions ?? conditions },
      then,
      ...(otherwise && otherwise.length ? { else: otherwise } : {}),
    });
  };
  return (
    <li className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <Input aria-label={t(M['rules.name'])} placeholder={t(M['rules.name_placeholder'])} value={rule.name ?? ''} onChange={(e) => write({ name: e.target.value })} />
        <Switch checked={rule.enabled} onCheckedChange={(enabled) => write({ enabled })} aria-label={t(M['rules.enabled'])} />
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['rules.remove'])} onClick={() => removeRule(rule.id)}><Trash2 className="size-3.5" /></Button>
      </div>
      <div className="space-y-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between">
          <p className="text-[12px] font-medium text-muted-foreground">{t(M['rules.when'])}</p>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['rules.add_when'])} onClick={() => {
            const source = fields[0];
            const other = fields[1];
            if (!source) return;
            const part = partsFor(source)[0] ?? 'whole';
            const extra = emptyCondition(source, { today: localToday(new Date()) });
            const next = other
              ? { ...extra, left: sideOperand(source, part === 'option' ? 'code' : part, '2'), op: 'eq' as const, right: sideOperand(other, (partsFor(other)[0] === 'option' ? 'code' : partsFor(other)[0]) ?? 'whole', '2') }
              : extra;
            write({ conditions: [...conditions, next] });
          }}>
            <Plus className="size-3.5" />
          </Button>
        </div>
        {conditions.map((cond) => (
          <ComparisonRow key={cond.id} cond={cond} fields={fields} canRemove={conditions.length > 1} onChange={(next) => write({ conditions: conditions.map((c) => (c.id === next.id ? next : c)) })} onRemove={() => write({ conditions: conditions.filter((c) => c.id !== cond.id) })} />
        ))}
      </div>
      <EffectBlock title={t(M['rules.then_action'])} actions={rule.then} fields={fields} onChange={(then) => write({ then })} />
      <EffectBlock title={t(M['rules.else_action'])} actions={rule.else ?? []} fields={fields} onChange={(otherwise) => write({ else: otherwise })} />
    </li>
  );
}

/** When / Then checks for Form settings → Rules. */
export function FormLogicChecks() {
  const def = useDoc((d) => d);
  const rules = useDoc((d) => d.logic.rules);
  const fields = fieldsOf(def);
  const add = () => {
    const left = fields[0];
    const right = fields[1];
    if (!left) return;
    const leftPart = (partsFor(left)[0] === 'option' ? 'code' : partsFor(left)[0]) ?? 'whole';
    const rightPart = right ? ((partsFor(right)[0] === 'option' ? 'code' : partsFor(right)[0]) ?? 'whole') : 'whole';
    const textPair = kindOf(left) === 'text' && right && kindOf(right) === 'text';
    setRule({
      id: newId() as RuleId,
      enabled: true,
      when: {
        kind: 'group',
        id: newId() as ConditionId,
        combinator: 'all',
        children: [{
          kind: 'condition',
          id: newId() as ConditionId,
          left: sideOperand(left, textPair ? 'first' : leftPart, '2'),
          op: 'eq',
          ...(right ? { right: sideOperand(right, textPair ? 'first' : rightPart, '2') } : {}),
        }],
      },
      then: [{ type: 'show', targets: [left.id] }],
      else: [{ type: 'hide', targets: [left.id] }],
    });
  };
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-sidebar-muted">{t(M['rules.intro'])}</p>
      {fields.length === 0 ? <p className="text-[13px] text-sidebar-muted">{t(M['rules.no_fields'])}</p> : null}
      <ul className="space-y-3">
        {rules.map((rule) => <RuleCard key={rule.id} rule={rule} fields={fields} />)}
      </ul>
      {fields.length ? (
        <Button type="button" variant="ghost" size="sm" onClick={add}>
          <Plus className="size-3.5" /> {t(M['rules.add'])}
        </Button>
      ) : null}
    </div>
  );
}
