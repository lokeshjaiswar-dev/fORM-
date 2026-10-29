import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import type { BlockOf, ChoiceOption, OptionId } from '@form/schema';
import { t } from '@/i18n';
import { labelString } from '@/fields/style';
import { APP_IDS } from '@/lib/definition';
import { updateBlock } from '@/state/actions';
import { Button, Input, Label } from '@dmacq/ui';
import { ToggleRow } from '@/components/builder/inspector/parts';

const M = defineMessages('builder', {
  'options.title': 'Options',
  'options.add': 'Add option',
  'options.new': 'Option {n}',
  'options.label': 'Label of option {n}',
  'options.code': 'Export code of option {n}',
  'options.code_placeholder': 'Code (optional)',
  'options.up': 'Move option {n} up',
  'options.down': 'Move option {n} down',
  'options.remove': 'Remove option {n}',
  'options.other': 'Add an “Other” option',
  'options.shuffle': 'Shuffle the options for each respondent',
  'options.codes_hint': 'Answers store each option’s id, never its label: renaming an option keeps its answers and its code.',
});

type ChoiceBlock = BlockOf<'single_choice'> | BlockOf<'multi_choice'> | BlockOf<'ranking'>;

/**
 * Edits a choice block's options. An option's id is created once and never derived from its label, and its export
 * code is edited on its own, so renaming, removing or adding options never changes another option's stored value
 * (B15, B16).
 */
export function OptionsEditor({ block }: { block: ChoiceBlock }) {
  const options = block.config.options;
  const write = (next: ChoiceOption[], extra: Record<string, unknown> = {}) => updateBlock(block.id, { config: { ...block.config, options: next, ...extra } });

  const edit = (i: number, patch: Partial<ChoiceOption>) => {
    const next = options.map((o, j) => {
      if (j !== i) return o;
      const merged = { ...o, ...patch };
      if (merged.code === '') delete merged.code;
      return merged;
    });
    write(next);
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= options.length) return;
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
  };

  /** A new option takes the lowest 'Option n' label not in use, so delete then add never repeats a label. */
  const add = () => {
    const used = new Set(options.map((o) => labelString(o.label)));
    let n = 1;
    while (used.has(t(M['options.new'], { n }))) n += 1;
    write([...options, { id: APP_IDS.newId() as OptionId, label: t(M['options.new'], { n }) }]);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{t(M['options.title'])}</Label>
        <Button type="button" variant="ghost" size="xs" onClick={add}>
          <Plus className="size-3" /> {t(M['options.add'])}
        </Button>
      </div>
      <ul className="space-y-1.5">
        {options.map((opt, i) => (
          <li key={opt.id} className="flex items-center gap-1">
            <div className="flex flex-col">
              <Button type="button" variant="ghost" size="icon-xs" aria-label={t(M['options.up'], { n: i + 1 })} onClick={() => move(i, i - 1)}>
                <ChevronUp className="size-3" />
              </Button>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={t(M['options.down'], { n: i + 1 })} onClick={() => move(i, i + 1)}>
                <ChevronDown className="size-3" />
              </Button>
            </div>
            <Input aria-label={t(M['options.label'], { n: i + 1 })} value={labelString(opt.label)} onChange={(e) => edit(i, { label: e.target.value })} />
            <Input
              aria-label={t(M['options.code'], { n: i + 1 })}
              className="w-[96px] shrink-0"
              placeholder={t(M['options.code_placeholder'])}
              value={opt.code ?? ''}
              onChange={(e) => edit(i, { code: e.target.value.slice(0, 200) })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t(M['options.remove'], { n: i + 1 })}
              disabled={options.length <= 1}
              onClick={() => remove(opt.id)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-muted-foreground">{t(M['options.codes_hint'])}</p>
      {block.type !== 'ranking' ? (
        <ToggleRow
          label={t(M['options.other'])}
          checked={block.config.other?.enabled === true}
          onChange={(on) => updateBlock(block.id, { config: { ...block.config, other: on ? { enabled: true, textRequired: false } : undefined } })}
        />
      ) : null}
      <ToggleRow
        label={t(M['options.shuffle'])}
        checked={block.type === 'ranking' ? block.config.shuffle === true : block.config.shuffle !== undefined && block.config.shuffle !== false}
        onChange={(on) => updateBlock(block.id, { config: { ...block.config, shuffle: on ? (block.type === 'ranking' ? true : { keepLast: 0 }) : undefined } })}
      />
    </div>
  );
}
