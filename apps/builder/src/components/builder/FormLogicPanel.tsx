import { Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { defineMessages, type MessageId } from '@form/i18n';
import { isAvailable } from '@form/registry';
import type {
  BlockId, Condition, ConditionId, FieldBlock, FormDefinition, LogicOperator, Operand, OptionId, PageId, Rule, RuleId,
} from '@form/schema';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { APP_IDS, blockOrder, blockText, isField, placementOf } from '@/lib/definition';
import { labelString } from '@/fields/style';
import { removeRule, setRule } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { Button, Input, Label, Switch } from '@dmacq/ui';
import { NiceSelect } from '@/components/NiceSelect';
import {
  COUNT, UNARY, choiceOptions, compareFields, condition, firstOperator, fits, initialRight, kindOf, literal, localToday, operatorsFor, retarget,
  type Defaults,
} from '@/components/builder/inspector/conditions';

const M = defineMessages('builder', {
  'rules.title': 'Logic',
  'rules.close': 'Close logic',
  'rules.intro': 'When answers match, show an error so the person cannot continue. Put codes on dropdown options (for example 27 on Maharashtra) and compare another field to that option’s code — one check covers every option.',
  'rules.add': 'Add a check',
  'rules.empty': 'No checks yet. Add one to compare questions, for example GSTIN against State.',
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
      <fieldset className="space-y-1">
        <legend className="text-[12px] text-muted-foreground">{t(M['rules.options'])}</legend>
        {choiceOptions(source).map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-[13px]">
            <input type={kind === 'choice' && (op === 'eq' || op === 'neq') ? 'radio' : 'checkbox'} name={`rules-${group}`} checked={chosen.includes(o.id)} onChange={() => toggle(o.id)} />
            {labelString(o.label)}
          </label>
        ))}
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

/** Form-level When / Then checks that block submit when answers do not match. */
export function FormLogicPanel() {
  const def = useDoc((d) => d);
  const rules = useDoc((d) => d.logic.rules);
  const close = () => useUiStore.getState().setLogicOpen(false);
  const [defaults] = useState<Defaults>(() => ({ today: localToday(new Date()) }));
  const fields = fieldsOf(def);
  const checks = rules.filter(isCheck);
  const add = () => {
    const source = fields[0];
    const anchor = fields[1]?.id ?? source?.id;
    if (!source || !anchor) return;
    setRule(checkRule(newId() as RuleId, '', true, newId() as ConditionId, [emptyCondition(source, defaults)], t(M['rules.message_placeholder']), anchor, pageOf(def, anchor)));
  };
  return (
    <aside className="flex h-full w-[min(100%,400px)] shrink-0 flex-col border-l border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-[16px] font-semibold">{t(M['rules.title'])}</h2>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['rules.close'])} onClick={close}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t(M['rules.intro'])}</p>
        {fields.length === 0 ? <p className="text-[13px] text-muted-foreground">{t(M['rules.no_fields'])}</p> : null}
        {fields.length > 0 && checks.length === 0 ? <p className="text-[13px] text-muted-foreground">{t(M['rules.empty'])}</p> : null}
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
      </div>
    </aside>
  );
}
