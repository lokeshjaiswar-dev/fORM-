import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { defineMessages, type MessageId } from '@form/i18n';
import { isAvailable } from '@form/registry';
import type {
  Action, BlockId, Condition, ConditionId, DecimalString, Expr, FieldBlock, FormDefinition, LogicOperator, Operand, OptionId, PageId, Rule, RuleId,
} from '@form/schema';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { APP_IDS, blockOrder, blockText, isField, placementOf } from '@/lib/definition';
import { labelString } from '@/fields/style';
import { addBlock, endSlot, removeRule, setRule } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { Button, CheckboxField, Input, Label, RadioField, RadioGroup, Switch } from '@dmacq/ui';
import { NiceSelect } from '@/components/NiceSelect';
import {
  COUNT, UNARY, choiceOptions, compareFields, condition, firstOperator, fits, initialRight, kindOf, literal, localToday, operatorsFor, retarget,
  type Defaults,
} from '@/components/builder/inspector/conditions';

const M = defineMessages('builder', {
  'rules.intro': 'Block submit when the answers do not match.',
  'rules.add': 'Add a check',
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
  'rules.fields': 'New field',
  'rules.field_name': 'Name',
  'rules.field_place': 'Place',
  'rules.before': 'Before',
  'rules.after': 'After',
  'rules.field_anchor': 'Next to',
  'rules.add_field': 'Add field',
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

function isCheck(rule: Rule): boolean {
  return rule.then.length === 1 && rule.then[0]?.type === 'block_submit' && !rule.else?.length && rule.when.kind === 'group' && rule.when.combinator === 'all'
    && rule.when.children.every((c) => c.kind === 'condition');
}

function pageOf(def: FormDefinition, id: BlockId): PageId | undefined {
  return placementOf(def, id)?.pageId;
}

function emptyCondition(source: FieldBlock, defaults: Defaults): Condition {
  const op = firstOperator(source, defaults);
  return retarget(newId() as ConditionId, source, op, undefined, defaults);
}

/** Prefer “this text field is filled and does not start with that dropdown’s option code” — the GSTIN vs State case. */
function starterCheck(fields: FieldBlock[], defaults: Defaults): { conditions: Condition[]; anchor: BlockId } | null {
  const source = [...fields].reverse().find((f) => kindOf(f) === 'text' && operatorsFor(f).includes('not_starts_with')) ?? fields[0];
  if (!source) return null;
  const peer = compareFields(source, 'not_starts_with', fields)[0];
  if (peer && operatorsFor(source).includes('not_starts_with')) {
    return {
      anchor: source.id,
      conditions: [
        condition(newId() as ConditionId, source, 'is_answered'),
        condition(newId() as ConditionId, peer, 'is_answered'),
        condition(newId() as ConditionId, source, 'not_starts_with', { kind: 'ref', ref: { kind: 'answer', blockId: peer.id } }),
      ],
    };
  }
  return { anchor: source.id, conditions: [emptyCondition(source, defaults)] };
}

function checkRule(id: RuleId, name: string, enabled: boolean, whenId: ConditionId, conditions: Condition[], message: string, anchor: BlockId, atPage?: PageId): Rule {
  return {
    id,
    name: name.trim() || undefined,
    enabled,
    when: { kind: 'group', id: whenId, combinator: 'all', children: conditions },
    then: [{ type: 'block_submit', message: message.trim() || 'This answer does not match.', anchorBlockId: anchor, ...(atPage ? { atPage } : {}) }],
  };
}

function sourceOf(cond: Condition): BlockId | null {
  return cond.left.kind === 'ref' && cond.left.ref.kind === 'answer' ? cond.left.ref.blockId : null;
}

const literalText = (operand: Operand | undefined): string => (operand?.kind === 'literal' && 'value' in operand.value ? String(operand.value.value) : '');

function OperandValue({ group, source, op, right, onChange }: { group: string; source: FieldBlock; op: LogicOperator; right: Operand | undefined; onChange: (right: Operand) => void }) {
  const kind = kindOf(source);
  const [text, setText] = useDraft(literalText(right));
  if (UNARY.has(op)) return null;
  if ((kind === 'choice' || kind === 'choices') && !COUNT.has(op)) {
    const chosen = right?.kind === 'options' ? right.optionIds : [];
    const toggle = (id: OptionId) => {
      const optionIds = kind === 'choice' && (op === 'eq' || op === 'neq') ? [id] : chosen.includes(id) ? chosen.filter((o) => o !== id) : [...chosen, id];
      if (optionIds.length) onChange({ kind: 'options', blockId: source.id, optionIds });
    };
    return (
      <fieldset className="space-y-2">
        <legend className="text-[12px] text-muted-foreground">{t(M['rules.options'])}</legend>
        {kind === 'choice' && (op === 'eq' || op === 'neq') ? (
          <RadioGroup name={group} value={chosen[0] ?? ''} onValueChange={(v) => toggle(v as OptionId)}>
            {choiceOptions(source).map((o) => (
              <RadioField key={o.id} value={o.id} label={labelString(o.label)} size="sm" />
            ))}
          </RadioGroup>
        ) : (
          choiceOptions(source).map((o) => (
            <CheckboxField key={o.id} checked={chosen.includes(o.id)} onCheckedChange={() => toggle(o.id)} label={labelString(o.label)} size="sm" />
          ))
        )}
      </fieldset>
    );
  }
  const type = COUNT.has(op) ? 'number' : kind === 'date' ? 'date' : kind === 'time' ? 'time' : 'text';
  return (
    <div className="space-y-1">
      <Label className="text-[12px] text-muted-foreground">{t(M['rules.value'])}</Label>
      <Input
        type={type === 'date' || type === 'time' ? 'text' : type}
        aria-label={t(M['rules.value'])}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const next = literal(kind, op, e.target.value.trim());
          if (next) onChange(next);
        }}
      />
    </div>
  );
}

function ConditionRow({
  cond, fields, defaults, onChange, onRemove, canRemove,
}: {
  cond: Condition;
  fields: FieldBlock[];
  defaults: Defaults;
  onChange: (next: Condition) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const sourceId = sourceOf(cond);
  const source = fields.find((f) => f.id === sourceId);
  const others = source ? compareFields(source, cond.op, fields) : [];
  const fieldRight = cond.right?.kind === 'ref' && cond.right.ref.kind === 'answer' ? cond.right.ref.blockId : '';
  const compareMode = fieldRight ? 'field' : 'typed';
  const pickSource = (id: string) => {
    const next = fields.find((f) => f.id === id);
    if (!next) return;
    onChange(retarget(cond.id, next, firstOperator(next, defaults), undefined, defaults));
  };
  const pickOp = (op: string) => {
    if (!source) return;
    onChange(retarget(cond.id, source, op as LogicOperator, cond.right, defaults));
  };
  const pickCompare = (mode: string) => {
    if (!source) return;
    if (mode === 'field') {
      const other = others[0];
      if (other) onChange(condition(cond.id, source, cond.op, { kind: 'ref', ref: { kind: 'answer', blockId: other.id } }));
      return;
    }
    onChange(retarget(cond.id, source, cond.op, undefined, defaults));
  };
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['rules.remove_when'])} disabled={!canRemove} onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <NiceSelect
        size="sm"
        aria-label={t(M['rules.question'])}
        value={sourceId ?? ''}
        onChange={pickSource}
        placeholder={t(M['rules.source_placeholder'])}
        options={fields.map((s) => ({ value: s.id, label: blockText(s) || t(M['rules.untitled'], { type: s.key }) }))}
      />
      {source ? (
        <>
          <NiceSelect size="sm" aria-label={t(M['rules.operator'])} value={cond.op} onChange={pickOp} options={operatorsFor(source).map((op) => ({ value: op, label: opLabel(op) }))} />
          {!UNARY.has(cond.op) && others.length > 0 ? (
            <NiceSelect
              size="sm"
              aria-label={t(M['rules.compare'])}
              value={compareMode === 'field' ? 'field' : 'typed'}
              onChange={pickCompare}
              options={[
                { value: 'typed', label: t(M['rules.typed']) },
                ...(others.length ? [{ value: 'field', label: t(M['rules.other_field']) }] : []),
              ]}
            />
          ) : null}
          {compareMode === 'field' && others.length ? (
            <NiceSelect
              size="sm"
              aria-label={t(M['rules.other_field'])}
              value={fieldRight}
              onChange={(id) => onChange(condition(cond.id, source, cond.op, { kind: 'ref', ref: { kind: 'answer', blockId: id as BlockId } }))}
              options={others.map((s) => ({ value: s.id, label: blockText(s) || t(M['rules.untitled'], { type: s.key }) }))}
            />
          ) : (
            <OperandValue group={`${cond.id}`} source={source} op={cond.op} right={fits(source, cond.op, cond.right, fields) ? cond.right : initialRight(source, cond.op, defaults)} onChange={(right) => onChange(condition(cond.id, source, cond.op, right))} />
          )}
        </>
      ) : null}
    </div>
  );
}

function CheckEditor({ rule, fields, defaults, def }: { rule: Rule; fields: FieldBlock[]; defaults: Defaults; def: FormDefinition }) {
  const action = rule.then[0];
  const message = action?.type === 'block_submit' ? action.message : '';
  const anchor = action?.type === 'block_submit' ? action.anchorBlockId : undefined;
  const conditions = rule.when.children.filter((c): c is Condition => c.kind === 'condition');
  const write = (patch: { name?: string; enabled?: boolean; conditions?: Condition[]; message?: string; anchor?: BlockId }) => {
    const nextAnchor = patch.anchor ?? anchor ?? fields[0]?.id;
    if (!nextAnchor) return;
    setRule(checkRule(
      rule.id,
      patch.name ?? (rule.name ?? ''),
      patch.enabled ?? rule.enabled,
      rule.when.id,
      patch.conditions ?? conditions,
      patch.message ?? message,
      nextAnchor,
      pageOf(def, nextAnchor),
    ));
  };
  return (
    <li className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <Input aria-label={t(M['rules.name'])} placeholder={t(M['rules.name_placeholder'])} value={rule.name ?? ''} onChange={(e) => write({ name: e.target.value })} />
        <Switch checked={rule.enabled} onCheckedChange={(enabled) => write({ enabled })} aria-label={t(M['rules.enabled'])} />
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['rules.remove'])} onClick={() => removeRule(rule.id)}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <p className="text-[12px] font-medium text-muted-foreground">{t(M['rules.when'])}</p>
      {conditions.map((cond) => (
        <ConditionRow
          key={cond.id}
          cond={cond}
          fields={fields}
          defaults={defaults}
          canRemove={conditions.length > 1}
          onChange={(next) => write({ conditions: conditions.map((c) => (c.id === next.id ? next : c)) })}
          onRemove={() => write({ conditions: conditions.filter((c) => c.id !== cond.id) })}
        />
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          const source = fields[0];
          if (!source) return;
          write({ conditions: [...conditions, emptyCondition(source, defaults)] });
        }}
      >
        <Plus className="size-3.5" /> {t(M['rules.add_when'])}
      </Button>
      <p className="text-[12px] font-medium text-muted-foreground">{t(M['rules.then'])}</p>
      <NiceSelect
        size="sm"
        aria-label={t(M['rules.error_on'])}
        value={anchor ?? ''}
        onChange={(id) => write({ anchor: id as BlockId })}
        options={fields.map((s) => ({ value: s.id, label: blockText(s) || t(M['rules.untitled'], { type: s.key }) }))}
      />
      <div className="space-y-1">
        <Label className="text-[12px] text-muted-foreground">{t(M['rules.message'])}</Label>
        <Input aria-label={t(M['rules.message'])} placeholder={t(M['rules.message_placeholder'])} value={message} onChange={(e) => write({ message: e.target.value })} />
      </div>
    </li>
  );
}

const answerRef = (blockId: BlockId): Expr => ({ k: 'ref', ref: { kind: 'answer', blockId } });

function percentExpr(blockId: BlockId, percent: string): Expr {
  const amount = (/^-?(0|[1-9]\d*)(\.\d{1,10})?$/.test(percent) ? percent : '0') as DecimalString;
  return {
    k: 'binary',
    op: '/',
    left: { k: 'binary', op: '*', left: answerRef(blockId), right: { k: 'lit', value: { type: 'number', value: amount } } },
    right: { k: 'lit', value: { type: 'number', value: '100' as DecimalString } },
  };
}

type FillKind = 'set' | 'percent' | 'score' | 'show' | 'hide' | 'none';

function fillKind(action: Action | undefined): FillKind {
  if (!action) return 'none';
  if (action.type === 'show') return 'show';
  if (action.type === 'hide') return 'hide';
  if (action.type !== 'set_value') return 'none';
  const value = action.value;
  if (value.k === 'call' && value.fn === 'option_score') return 'score';
  if (value.k === 'binary' && value.op === '/') return 'percent';
  return 'set';
}

function fillTarget(action: Action | undefined): string {
  if (!action) return '';
  if (action.type === 'show' || action.type === 'hide') return action.targets[0] ?? '';
  if (action.type === 'set_value') return action.target;
  return '';
}

function fillSource(action: Action | undefined): string {
  if (!action || action.type !== 'set_value') return '';
  const value = action.value;
  if (value.k === 'call' && value.args[0]?.k === 'ref' && value.args[0].ref.kind === 'answer') return value.args[0].ref.blockId;
  if (value.k === 'binary' && value.left.k === 'binary' && value.left.left.k === 'ref' && value.left.left.ref.kind === 'answer') return value.left.left.ref.blockId;
  return '';
}

function fillAmount(action: Action | undefined): string {
  if (!action || action.type !== 'set_value') return '';
  const value = action.value;
  if (value.k === 'lit' && value.value.type === 'number') return value.value.value;
  if (value.k === 'binary' && value.left.k === 'binary' && value.left.right.k === 'lit' && value.left.right.value.type === 'number') return value.left.right.value.value;
  return '';
}

function fillAction(kind: FillKind, target: BlockId, source: BlockId, amount: string): Action | null {
  if (!target || kind === 'none') return null;
  if (kind === 'show' || kind === 'hide') return { type: kind, targets: [target] };
  if (kind === 'score') return { type: 'set_value', target, value: { k: 'call', fn: 'option_score', args: [answerRef(source || target)] } };
  if (kind === 'percent') return { type: 'set_value', target, value: percentExpr(source || target, amount || '0') };
  return { type: 'set_value', target, value: { k: 'lit', value: { type: 'number', value: ((/^-?(0|[1-9]\d*)(\.\d{1,10})?$/.test(amount) ? amount : '0') as DecimalString) } } };
}

function AddLinkedField({ fields, def }: { fields: FieldBlock[]; def: FormDefinition }) {
  const anchor = fields[fields.length - 1];
  const [name, setName] = useState('Value');
  const [where, setWhere] = useState('after');
  const [beside, setBeside] = useState(anchor?.id ?? '');
  const add = () => {
    const place = beside ? placementOf(def, beside as BlockId) : null;
    const at = place ? { pageId: place.pageId, index: where === 'before' ? place.index : place.index + 1 } : endSlot(def);
    addBlock({ type: 'number', configOverrides: {} }, at, { label: name.trim() || 'Value', readOnly: true });
  };
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-[12px] font-medium text-sidebar-muted">{t(M['rules.fields'])}</p>
      <Input aria-label={t(M['rules.field_name'])} value={name} onChange={(e) => setName(e.target.value)} />
      <div className="grid grid-cols-2 gap-2">
        <NiceSelect size="sm" aria-label={t(M['rules.field_place'])} value={where} onChange={setWhere} options={[{ value: 'before', label: t(M['rules.before']) }, { value: 'after', label: t(M['rules.after']) }]} />
        <NiceSelect size="sm" aria-label={t(M['rules.field_anchor'])} value={beside} onChange={setBeside} options={fields.map((s) => ({ value: s.id, label: blockText(s) || t(M['rules.untitled'], { type: s.key }) }))} />
      </div>
      <Button type="button" variant="ghost" size="sm" disabled={fields.length === 0} onClick={add}>
        <Plus className="size-3.5" /> {t(M['rules.add_field'])}
      </Button>
    </div>
  );
}

function FillEditor({ rule, fields, defaults }: { rule: Rule; fields: FieldBlock[]; defaults: Defaults }) {
  const then = rule.then[0];
  const otherwise = rule.else?.[0];
  const conditions = rule.when.children.filter((c): c is Condition => c.kind === 'condition');
  const write = (patch: { name?: string; enabled?: boolean; conditions?: Condition[]; then?: Action | null; else?: Action | null }) => {
    const nextThen = patch.then === undefined ? then : patch.then;
    if (!nextThen) return;
    const nextElse = patch.else === undefined ? otherwise : patch.else;
    const name = (patch.name ?? rule.name ?? '').trim();
    setRule({
      id: rule.id,
      ...(name ? { name } : {}),
      enabled: patch.enabled ?? rule.enabled,
      when: { kind: 'group', id: rule.when.id, combinator: 'all', children: patch.conditions ?? conditions },
      then: [nextThen],
      ...(nextElse ? { else: [nextElse] } : {}),
    });
  };
  const numbers = fields.filter((f) => f.type === 'number' || f.type === 'calculation');
  const choices = fields.filter((f) => f.type === 'single_choice');
  const row = (label: string, action: Action | undefined, onChange: (next: Action | null) => void) => {
    const kind = fillKind(action);
    const target = fillTarget(action) || fields[0]?.id || '';
    const source = fillSource(action) || choices[0]?.id || numbers[0]?.id || '';
    const amount = fillAmount(action);
    const setKind = (next: string) => onChange(fillAction(next as FillKind, (target || fields[0]?.id) as BlockId, (source || fields[0]?.id) as BlockId, amount || '0'));
    return (
      <div className="space-y-2">
        <p className="text-[12px] font-medium text-sidebar-muted">{label}</p>
        <NiceSelect size="sm" aria-label={label} value={kind} onChange={setKind} options={[
          { value: 'none', label: t(M['rules.none']) },
          { value: 'set', label: t(M['rules.act_set']) },
          { value: 'percent', label: t(M['rules.act_percent']) },
          { value: 'score', label: t(M['rules.act_score']) },
          { value: 'show', label: t(M['rules.act_show']) },
          { value: 'hide', label: t(M['rules.act_hide']) },
        ]} />
        {kind !== 'none' ? (
          <NiceSelect size="sm" aria-label={t(M['rules.target'])} value={target} onChange={(id) => onChange(fillAction(kind, id as BlockId, source as BlockId, amount))} options={fields.map((s) => ({ value: s.id, label: blockText(s) || s.key }))} />
        ) : null}
        {kind === 'set' || kind === 'percent' ? (
          <Input aria-label={kind === 'percent' ? t(M['rules.percent']) : t(M['rules.amount'])} value={amount} onChange={(e) => onChange(fillAction(kind, target as BlockId, source as BlockId, e.target.value.trim()))} />
        ) : null}
        {kind === 'percent' || kind === 'score' ? (
          <NiceSelect size="sm" aria-label={t(M['rules.source'])} value={source} onChange={(id) => onChange(fillAction(kind, target as BlockId, id as BlockId, amount))} options={(kind === 'score' ? choices : numbers).map((s) => ({ value: s.id, label: blockText(s) || s.key }))} />
        ) : null}
      </div>
    );
  };
  return (
    <li className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <Input aria-label={t(M['rules.name'])} placeholder={t(M['rules.name_placeholder'])} value={rule.name ?? ''} onChange={(e) => write({ name: e.target.value })} />
        <Switch checked={rule.enabled} onCheckedChange={(enabled) => write({ enabled })} aria-label={t(M['rules.enabled'])} />
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['rules.remove'])} onClick={() => removeRule(rule.id)}><Trash2 className="size-3.5" /></Button>
      </div>
      {conditions.map((cond) => (
        <ConditionRow key={cond.id} cond={cond} fields={fields} defaults={defaults} canRemove={conditions.length > 1} onChange={(next) => write({ conditions: conditions.map((c) => (c.id === next.id ? next : c)) })} onRemove={() => write({ conditions: conditions.filter((c) => c.id !== cond.id) })} />
      ))}
      {row(t(M['rules.then_action']), then, (next) => write({ then: next }))}
      {row(t(M['rules.else_action']), otherwise, (next) => write({ else: next }))}
    </li>
  );
}

function isFill(rule: Rule): boolean {
  const action = rule.then[0];
  if (action?.type === 'set_value' && action.value.k === 'call' && action.value.fn === 'option_code') return false;
  return rule.then.length === 1 && (action?.type === 'set_value' || action?.type === 'show' || action?.type === 'hide') && rule.when.children.every((c) => c.kind === 'condition');
}

/** When / Then checks for Form settings → Rules. */
export function FormLogicChecks() {
  const def = useDoc((d) => d);
  const rules = useDoc((d) => d.logic.rules);
  const [defaults] = useState<Defaults>(() => ({ today: localToday(new Date()) }));
  const fields = fieldsOf(def);
  const checks = rules.filter(isCheck);
  const fills = rules.filter(isFill);
  const add = () => {
    const start = starterCheck(fields, defaults);
    if (!start) return;
    setRule(checkRule(newId() as RuleId, '', true, newId() as ConditionId, start.conditions, t(M['rules.message_placeholder']), start.anchor, pageOf(def, start.anchor)));
  };
  const addFill = () => {
    const source = fields[0];
    const target = [...fields].reverse().find((f) => f.type === 'number') ?? source;
    if (!source || !target) return;
    setRule({
      id: newId() as RuleId,
      enabled: true,
      when: { kind: 'group', id: newId() as ConditionId, combinator: 'all', children: [emptyCondition(source, defaults)] },
      then: [{ type: 'set_value', target: target.id, value: { k: 'lit', value: { type: 'number', value: '0' as DecimalString } } }],
    });
  };
  return (
    <div className="space-y-3">
      <AddLinkedField fields={fields} def={def} />
      <p className="text-[13px] leading-relaxed text-sidebar-muted">{t(M['rules.intro'])}</p>
      {fields.length === 0 ? <p className="text-[13px] text-sidebar-muted">{t(M['rules.no_fields'])}</p> : null}
      {fields.length > 0 && checks.length === 0 ? <p className="text-[13px] text-sidebar-muted">{t(M['rules.empty'])}</p> : null}
      <ul className="space-y-3">
        {checks.map((rule) => (
          <CheckEditor key={rule.id} rule={rule} fields={fields} defaults={defaults} def={def} />
        ))}
      </ul>
      {fields.length ? (
        <Button type="button" variant="ghost" size="sm" onClick={add}>
          <Plus className="size-3.5" /> {t(M['rules.add'])}
        </Button>
      ) : null}
      <p className="text-[13px] leading-relaxed text-sidebar-muted">{t(M['rules.fill_intro'])}</p>
      <ul className="space-y-3">
        {fills.map((rule) => (
          <FillEditor key={rule.id} rule={rule} fields={fields} defaults={defaults} />
        ))}
      </ul>
      {fields.length ? (
        <Button type="button" variant="ghost" size="sm" onClick={addFill}>
          <Plus className="size-3.5" /> {t(M['rules.add_fill'])}
        </Button>
      ) : null}
    </div>
  );
}
