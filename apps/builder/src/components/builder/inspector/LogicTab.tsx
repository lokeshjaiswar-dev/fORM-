import { Plus, Trash2 } from 'lucide-react';
import { defineMessages, type MessageId } from '@form/i18n';
import { useState } from 'react';
import { isAvailable } from '@form/registry';
import type { BlockId, Condition, ConditionId, FieldBlock, FormDefinition, LogicOperator, Operand, OptionId, Rule, RuleId } from '@form/schema';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { labelString } from '@/fields/style';
import { APP_IDS, blockOrder, blockText, isField } from '@/lib/definition';
import { removeRule, setRule } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { Input, Label } from '@/components/ui/input';
import { NiceSelect } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { COUNT, UNARY, choiceOptions, condition, firstOperator, kindOf, literal, localToday, operatorsFor, retarget, type Defaults } from '@/components/builder/inspector/conditions';

const M = defineMessages('builder', {
  'logic.intro': 'Show or hide this block based on answers to earlier questions. A block a rule shows stays hidden until the rule matches.',
  'logic.add': 'Add a rule',
  'logic.no_sources': 'Add a question before this block to base a rule on it.',
  'logic.rule': 'Rule {n}',
  'logic.enabled': 'Rule {n} is on',
  'logic.remove': 'Remove rule {n}',
  'logic.action': 'This block should',
  'logic.show': 'Show',
  'logic.hide': 'Hide',
  'logic.when': 'When',
  'logic.source_placeholder': 'Select a question',
  'logic.operator': 'Condition',
  'logic.value': 'Value',
  'logic.options': 'Options',
  'logic.untitled': 'Untitled {type}',
  'logic.complex': 'A rule with {count, plural, one {# condition} other {# conditions}} acts on this block; edit it where it was made.',
  'logic.hidden_until': 'Hidden until a rule shows it',
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

/** Fields a rule on `target` may read: available value fields placed before it (I8: same or earlier page). */
function sourcesFor(def: FormDefinition, target: BlockId): FieldBlock[] {
  const order = blockOrder(def);
  const before = order.slice(0, Math.max(0, order.indexOf(target)));
  return before.map((id) => def.blocks[id]).filter((b): b is FieldBlock => isField(b) && isAvailable(b.type) && operatorsFor(b).length > 0);
}

/** One condition, one show or hide action on one block: the rules this tab edits. */
interface SimpleRule {
  rule: Rule;
  condition: Condition;
  action: 'show' | 'hide';
}

function simple(rule: Rule, target: BlockId): SimpleRule | null {
  const [condition, ...more] = rule.when.children;
  const [action, ...others] = rule.then;
  if (more.length || others.length || rule.else?.length || rule.when.negate || condition?.kind !== 'condition') return null;
  if (!action || (action.type !== 'show' && action.type !== 'hide') || action.targets.length !== 1 || action.targets[0] !== target) return null;
  if (condition.left.kind !== 'ref' || condition.left.ref.kind !== 'answer' || condition.left.ref.path) return null;
  return { rule, condition, action: action.type };
}

const sourceOf = (condition: Condition): BlockId | null => (condition.left.kind === 'ref' && condition.left.ref.kind === 'answer' ? condition.left.ref.blockId : null);

const newId = () => APP_IDS.newId();

/** A one-condition rule; edits keep the rule's ids, so typing in a value coalesces into one history step. */
function ruleFor(id: RuleId, groupId: ConditionId, target: BlockId, action: 'show' | 'hide', enabled: boolean, condition: Condition): Rule {
  return {
    id,
    enabled,
    when: { kind: 'group', id: groupId, combinator: 'all', children: [condition] },
    then: [{ type: action, targets: [target] }],
  };
}

const literalText = (operand: Operand | undefined): string => (operand?.kind === 'literal' && 'value' in operand.value ? String(operand.value.value) : '');

/** `group` names the condition, so two rules reading one single-choice source never share a radio group. */
function OperandEditor({ group, source, op, right, onChange }: { group: string; source: FieldBlock; op: LogicOperator; right: Operand | undefined; onChange: (right: Operand) => void }) {
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
        <legend className="text-[12px] text-[var(--notion-text-muted)]">{t(M['logic.options'])}</legend>
        {choiceOptions(source).map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-[13px]">
            <input type={kind === 'choice' && (op === 'eq' || op === 'neq') ? 'radio' : 'checkbox'} name={`logic-${group}`} checked={chosen.includes(o.id)} onChange={() => toggle(o.id)} />
            {labelString(o.label)}
          </label>
        ))}
      </fieldset>
    );
  }
  const type = COUNT.has(op) ? 'number' : kind === 'date' ? 'date' : kind === 'time' ? 'time' : 'text';
  return (
    <div className="space-y-1">
      <Label className="text-[12px] text-[var(--notion-text-muted)]">{t(M['logic.value'])}</Label>
      <Input
        type={type}
        aria-label={t(M['logic.value'])}
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

function RuleEditor({ n, item, target, sources, defaults }: { n: number; item: SimpleRule; target: BlockId; sources: FieldBlock[]; defaults: Defaults }) {
  const { rule, condition: cond, action } = item;
  const sourceId = sourceOf(cond);
  const source = sources.find((s) => s.id === sourceId);
  const write = (next: { action?: 'show' | 'hide'; enabled?: boolean; condition?: Condition }) =>
    setRule(ruleFor(rule.id, rule.when.id, target, next.action ?? action, next.enabled ?? rule.enabled, next.condition ?? cond));
  const pickSource = (id: string) => {
    const next = sources.find((s) => s.id === id);
    if (!next) return;
    write({ condition: retarget(cond.id, next, firstOperator(next, defaults), undefined, defaults) });
  };
  const pickOp = (op: string) => {
    if (!source) return;
    write({ condition: retarget(cond.id, source, op as LogicOperator, cond.right, defaults) });
  };
  return (
    <li className="space-y-3 rounded-md border border-[var(--notion-border)] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-[var(--notion-text-muted)]">{t(M['logic.rule'], { n })}</span>
        <div className="flex items-center gap-1">
          <Switch checked={rule.enabled} onCheckedChange={(enabled) => write({ enabled })} aria-label={t(M['logic.enabled'], { n })} />
          <button
            type="button"
            aria-label={t(M['logic.remove'], { n })}
            className="flex size-7 items-center justify-center rounded-[4px] text-[var(--notion-text-muted)] hover:bg-red-50 hover:text-red-500"
            onClick={() => removeRule(rule.id)}
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-[12px] text-[var(--notion-text-muted)]">{t(M['logic.action'])}</Label>
        <NiceSelect size="sm" value={action} onChange={(v) => write({ action: v === 'hide' ? 'hide' : 'show' })} options={[{ value: 'show', label: t(M['logic.show']) }, { value: 'hide', label: t(M['logic.hide']) }]} />
      </div>
      <div className="space-y-1">
        <Label className="text-[12px] text-[var(--notion-text-muted)]">{t(M['logic.when'])}</Label>
        <NiceSelect
          size="sm"
          value={sourceId ?? ''}
          onChange={pickSource}
          placeholder={t(M['logic.source_placeholder'])}
          options={sources.map((s) => ({ value: s.id, label: blockText(s) || t(M['logic.untitled'], { type: s.key }) }))}
        />
      </div>
      {source ? (
        <>
          <div className="space-y-1">
            <Label className="text-[12px] text-[var(--notion-text-muted)]">{t(M['logic.operator'])}</Label>
            <NiceSelect size="sm" value={cond.op} onChange={pickOp} options={operatorsFor(source).map((op) => ({ value: op, label: opLabel(op) }))} />
          </div>
          <OperandEditor group={`${rule.id}-${cond.id}`} source={source} op={cond.op} right={cond.right} onChange={(right) => write({ condition: condition(cond.id, source, cond.op, right) })} />
        </>
      ) : null}
    </li>
  );
}

/**
 * The per-block Logic tab: rules are form-level (`logic.rules`, logic@2), each with a typed condition on an earlier
 * question and a show or hide action on this block. Adding a show rule marks the block hidden until the rule matches;
 * removing the last one clears it (D2, done by the command).
 */
export function LogicTab({ blockId }: { blockId: BlockId }) {
  const rules = useDoc((d) => d.logic.rules);
  const def = useDoc((d) => d);
  const hidden = useDoc((d) => {
    const b = d.blocks[blockId];
    return b !== undefined && b.type !== 'unsupported' && b.initiallyHidden === true;
  });
  const [defaults] = useState<Defaults>(() => ({ today: localToday(new Date()) }));
  const sources = sourcesFor(def, blockId);
  const mine = rules.filter((r) => [...r.then, ...(r.else ?? [])].some((a) => 'targets' in a && (a.targets as readonly string[]).includes(blockId)));

  const add = () => {
    const source = sources[sources.length - 1];
    if (!source) return;
    setRule(ruleFor(newId() as RuleId, newId() as ConditionId, blockId, 'show', true, retarget(newId() as ConditionId, source, firstOperator(source, defaults), undefined, defaults)));
  };

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-[var(--notion-text-muted)]">{t(M['logic.intro'])}</p>
      {hidden ? <p className="text-[12px] font-medium text-amber-700">{t(M['logic.hidden_until'])}</p> : null}
      <ul className="space-y-2">
        {mine.map((rule, i) => {
          const item = simple(rule, blockId);
          return item ? (
            <RuleEditor key={rule.id} n={i + 1} item={item} target={blockId} sources={sources} defaults={defaults} />
          ) : (
            <li key={rule.id} className="rounded-md border border-[var(--notion-border)] p-3 text-[13px] text-[var(--notion-text-muted)]">
              {t(M['logic.complex'], { count: rule.when.children.length })}
            </li>
          );
        })}
      </ul>
      {sources.length ? (
        <button type="button" className="inline-flex items-center gap-1 rounded-[4px] px-1.5 py-1 text-[13px] text-[var(--notion-text-muted)] hover:bg-[var(--notion-hover)]" onClick={add}>
          <Plus className="size-3.5" /> {t(M['logic.add'])}
        </button>
      ) : (
        <p className="text-[13px] text-[var(--notion-text-muted)]">{t(M['logic.no_sources'])}</p>
      )}
    </div>
  );
}
