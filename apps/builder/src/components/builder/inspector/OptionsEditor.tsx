import { useState } from 'react';
import { Plus } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import type { BlockId, BlockOf, ChoiceOption, ConditionId, OptionId, Rule, RuleId } from '@form/schema';
import { t } from '@/i18n';
import { labelString } from '@/fields/style';
import { applyPatch } from '@/lib/applyPatch';
import { APP_IDS, blockText, inlineDoc } from '@/lib/definition';
import { patchBlockConfig } from '@/fields/configSink';
import { isDropdown, withoutForbidden } from '@/fields/dropdownChoices';
import { placeBeside, removeRule, setRule, updateBlock } from '@/state/actions';
import { currentDoc, useDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { Button } from '@dmacq/ui';
import { ApiOptionsSection } from '@/components/builder/inspector/ApiOptionsSection';
import { Disclosure, ToggleRow } from '@/components/builder/inspector/parts';
import { SHOWN_SETTINGS } from '@/components/builder/inspector/shownSettings';
import { GroupedOptions, LinkSetting, PasteList, useLinkedParent } from '@/components/builder/inspector/DependentOptions';
import { OptionRow, SortableOptions, type OptionPatch } from '@/components/builder/inspector/OptionList';

const M = defineMessages('builder', {
  'options.add': 'Add option',
  'options.more': 'More options',
  'options.new': 'Option {n}',
  'options.fill': 'Fill a field from the selected option',
  'options.fill_hint': 'The field stays empty until an option is chosen, then it shows that option’s value.',
  'options.remove': 'Remove option {n}',
  'options.other': 'Add an “Other” option',
  'options.shuffle': 'Shuffle the options for each respondent',
  'options.show_codes': 'Show option codes',
  'options.show_codes_hint': 'Exports and integrations use an option’s code. An option without one exports its label.',
  'options.show_values': 'Show option values',
  'options.show_values_hint': 'A value is written to a filled field, and used in exports. An option without one uses its label.',
  'options.no_ampersand': '“&” is not allowed in dropdown choices.',
});

type ChoiceBlock = BlockOf<'single_choice'> | BlockOf<'multi_choice'> | BlockOf<'ranking'> | BlockOf<'matching'> | BlockOf<'constant_sum'> | BlockOf<'maxdiff'>;

/**
 * Edits a choice block's options. An option's id is created once and never derived from its label, and its export
 * code is edited on its own, so renaming, removing or adding options never changes another option's stored value
 * (B15, B16).
 *
 * Basics first (the list, Other, shuffle); a list linked to an earlier question is shown grouped by that question's
 * answers; settings most lists never need fold under More options.
 */
export function OptionsEditor({ block }: { block: ChoiceBlock }) {
  const options = block.config.options;
  const images = (block.type === 'single_choice' || block.type === 'multi_choice') && block.config.display === 'image';
  const valueColumn = block.type === 'single_choice' && block.config.display === 'dropdown';
  const dependent = block.type === 'single_choice' || block.type === 'multi_choice' ? block : undefined;
  const parent = useLinkedParent(block);
  const rules = useDoc((d) => d.logic.rules);
  const [fresh, setFresh] = useState<OptionId | null>(null);
  /* The code column is rarely needed, so rows stay label-only unless asked for (or a filled field uses the values). */
  const [codesOn, setCodesOn] = useState(false);
  const dropdown = isDropdown(block);
  const write = (next: ChoiceOption[], extra: Record<string, unknown> = {}) => patchBlockConfig(block, { options: dropdown ? withoutForbidden(next) : next, ...extra });

  const edit = (id: OptionId, patch: OptionPatch) => {
    const next = options.map((o) => {
      if (o.id !== id) return o;
      const merged = applyPatch(o, patch);
      if (merged.code === '') delete merged.code;
      return merged;
    });
    write(next);
  };

  /** Moves an option to where another one is, as a drag onto it or an arrow key past it does. */
  const move = (id: OptionId, over: OptionId) => {
    const from = options.findIndex((o) => o.id === id);
    const to = options.findIndex((o) => o.id === over);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...options];
    const [item] = next.splice(from, 1);
    if (item) next.splice(to, 0, item);
    write(next);
  };

  /** Removing an option also drops it from the defaults and the exclusive set that named it. */
  const remove = (id: OptionId) => {
    const next = options.filter((o) => o.id !== id);
    const config = block.config as { defaultOptionId?: OptionId; defaultOptionIds?: OptionId[]; exclusiveOptionIds?: OptionId[]; maxSelected?: number; minSelected?: number; shuffle?: unknown };
    const extra: Record<string, unknown> = {};
    if (config.defaultOptionId === id) extra['defaultOptionId'] = undefined;
    if (config.defaultOptionIds) extra['defaultOptionIds'] = config.defaultOptionIds.filter((o) => o !== id);
    if (config.exclusiveOptionIds) extra['exclusiveOptionIds'] = config.exclusiveOptionIds.filter((o) => o !== id);
    if (config.maxSelected !== undefined && config.maxSelected > next.length) extra['maxSelected'] = undefined;
    if (config.minSelected !== undefined && config.minSelected > next.length) extra['minSelected'] = undefined;
    write(next, extra);
    unlinkFromDependants(block.id, id);
  };

  /** A new option takes the lowest 'Option n' label not in use, so delete then add never repeats a label. */
  const add = (parentOptionIds?: OptionId[]): OptionId => {
    const used = new Set(options.map((o) => labelString(o.label)));
    let n = 1;
    while (used.has(t(M['options.new'], { n }))) n += 1;
    const id = APP_IDS.newId() as OptionId;
    write([...options, { id, label: t(M['options.new'], { n }), ...(parentOptionIds ? { parentOptionIds } : {}) }]);
    return id;
  };

  /** Puts existing options into a parent answer's group, keeping any groups they are already in. */
  const link = (ids: readonly OptionId[], parentId: OptionId) => {
    const chosen = new Set(ids);
    write(options.map((o) => (chosen.has(o.id) && !o.parentOptionIds?.includes(parentId) ? { ...o, parentOptionIds: [...(o.parentOptionIds ?? []), parentId] } : o)));
  };

  const fillRule = block.type === 'single_choice' ? fillRuleFor(rules, block.id) : undefined;
  const showCode = codesOn || fillRule !== undefined;
  return (
    <>
      {dependent ? <LinkSetting block={dependent} /> : null}
      {dependent && parent ? (
        <GroupedOptions block={dependent} parent={parent} images={images} valueColumn={valueColumn} showCode={showCode} onEdit={edit} onDelete={remove} onMove={move} onAdd={add} onLink={link} />
      ) : (
        <div className="space-y-2">
          <SortableOptions ids={options.map((o) => o.id)} onMove={move}>
            {options.map((option, i) => (
              <OptionRow
                key={option.id}
                option={option}
                n={i + 1}
                above={options[i - 1]?.id}
                below={options[i + 1]?.id}
                onMove={move}
                images={images}
                valueColumn={valueColumn}
                showCode={showCode}
                autoFocus={option.id === fresh}
                onEdit={(patch) => edit(option.id, patch)}
                removeLabel={t(M['options.remove'], { n: i + 1 })}
                removeDisabled={options.length <= 1}
                onRemove={() => remove(option.id)}
              />
            ))}
          </SortableOptions>
          {/* Lined up with the option inputs: past the 20px drag handle, short of the 32px remove button. */}
          <div className="ml-5 mr-8 flex items-center gap-1">
            <Button type="button" variant="outline" size="sm" className="flex-1 border-dashed text-muted-foreground hover:text-foreground" onClick={() => setFresh(add())}>
              <Plus className="size-3.5" /> {t(M['options.add'])}
            </Button>
            {dependent ? <PasteList block={dependent} /> : null}
          </div>
        </div>
      )}
      {dropdown ? <p className="ml-5 text-[12px] leading-4 text-muted-foreground">{t(M['options.no_ampersand'])}</p> : null}
      {block.type !== 'ranking' && block.type !== 'matching' && block.type !== 'constant_sum' && block.type !== 'maxdiff' ? (
        <ToggleRow
          label={t(M['options.other'])}
          checked={block.config.other?.enabled === true}
          onChange={(on) => patchBlockConfig(block, { other: on ? { enabled: true, textRequired: false } : undefined })}
        />
      ) : null}
      {block.type !== 'constant_sum' ? (
        <ToggleRow
          label={t(M['options.shuffle'])}
          checked={block.type === 'ranking' || block.type === 'matching' || block.type === 'maxdiff' ? block.config.shuffle === true : block.config.shuffle !== undefined && block.config.shuffle !== false}
          onChange={(on) => patchBlockConfig(block, { shuffle: on ? (block.type === 'ranking' || block.type === 'matching' || block.type === 'maxdiff' ? true : { keepLast: 0 }) : undefined })}
        />
      ) : null}
      {SHOWN_SETTINGS.dropdownMoreOptions || !dropdown ? (
        <Disclosure title={t(M['options.more'])} inUse={fillRule !== undefined || block.apiOptions !== undefined}>
          <ToggleRow
            label={t(M[valueColumn ? 'options.show_values' : 'options.show_codes'])}
            hint={t(M[valueColumn ? 'options.show_values_hint' : 'options.show_codes_hint'])}
            checked={showCode}
            onChange={setCodesOn}
          />
          {block.type === 'single_choice' && block.config.display === 'dropdown' ? <FillFromOption block={block} /> : null}
          <ApiOptionsSection block={block} />
        </Disclosure>
      ) : null}
    </>
  );
}

/** A removed option can no longer be a parent answer: questions that depend on this block forget it. */
function unlinkFromDependants(parentId: BlockId, optionId: OptionId): void {
  for (const other of Object.values(currentDoc().blocks)) {
    if (other?.type !== 'single_choice' && other?.type !== 'multi_choice') continue;
    if (other.config.dependsOn !== parentId) continue;
    if (!other.config.options.some((o) => o.parentOptionIds?.includes(optionId))) continue;
    const options = other.config.options.map((o) => {
      if (!o.parentOptionIds?.includes(optionId)) return o;
      const rest = o.parentOptionIds.filter((p) => p !== optionId);
      const { parentOptionIds: _old, ...plain } = o;
      return rest.length ? { ...plain, parentOptionIds: rest } : plain;
    });
    patchBlockConfig(other, { options });
  }
}

function fillRuleFor(rules: readonly Rule[], blockId: BlockId): Rule | undefined {
  return rules.find((rule) => rule.then.some((action) => {
    if (action.type !== 'set_value' || action.value.k !== 'call' || action.value.fn !== 'option_code') return false;
    const arg = action.value.args[0];
    return arg?.k === 'ref' && arg.ref.kind === 'answer' && arg.ref.blockId === blockId;
  }));
}

/** Dropdown switch: one empty field, filled with the chosen option's value. */
function FillFromOption({ block }: { block: BlockOf<'single_choice'> }) {
  const rules = useDoc((d) => d.logic.rules);
  const def = useDoc((d) => d);
  const rule = fillRuleFor(rules, block.id);
  const targetId = rule?.then[0]?.type === 'set_value' ? rule.then[0].target : undefined;
  const target = targetId ? def.blocks[targetId] : undefined;
  const turnOn = () => {
    if (rule) return;
    const name = blockText(block) || 'Option';
    const placed = placeBeside(block.id, { choice: { type: 'short_text', configOverrides: {} } });
    const id = placed.ok ? placed.created : undefined;
    if (id) updateBlock(id, { label: inlineDoc(`${name} value`), readOnly: true });
    useUiStore.setState({ activeBlockId: block.id });
    if (!id) return;
    setRule({
      id: APP_IDS.newId() as RuleId,
      enabled: true,
      when: {
        kind: 'group',
        id: APP_IDS.newId() as ConditionId,
        combinator: 'all',
        children: [{
          kind: 'condition',
          id: APP_IDS.newId() as ConditionId,
          left: { kind: 'ref', ref: { kind: 'answer', blockId: block.id } },
          op: 'is_answered',
        }],
      },
      then: [{
        type: 'set_value',
        target: id,
        value: { k: 'call', fn: 'option_code', args: [{ k: 'ref', ref: { kind: 'answer', blockId: block.id } }] },
      }],
    });
  };
  return (
    <ToggleRow
      label={t(M['options.fill'])}
      hint={rule ? `${t(M['options.fill_hint'])} ${blockText(target) || ''}`.trim() : t(M['options.fill_hint'])}
      checked={rule !== undefined}
      onChange={(on) => (on ? turnOn() : rule && removeRule(rule.id))}
    />
  );
}
