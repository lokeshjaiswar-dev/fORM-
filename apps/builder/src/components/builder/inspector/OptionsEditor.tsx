import { useRef } from 'react';
import { ChevronDown, ChevronUp, ImagePlus, Plus, Trash2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { themeImageUrl } from '@form/renderer/author';
import type { AssetId, BlockOf, ChoiceOption, OptionId } from '@form/schema';
import { t } from '@/i18n';
import { labelString } from '@/fields/style';
import { fileToThemeImage, storeThemeImage } from '@/components/builder/design/uploads';
import { APP_IDS } from '@/lib/definition';
import { uid } from '@/lib/utils';
import { applyPatch, type Patch } from '@/lib/patch';
import { patchBlockConfig } from '@/fields/configSink';
import { Button, Input, Label } from '@dmacq/ui';
import { ApiOptionsSection } from '@/components/builder/inspector/ApiOptionsSection';
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
  'options.image': 'Upload image for option {n}',
  'options.image_remove': 'Remove image from option {n}',
});

type ChoiceBlock = BlockOf<'single_choice'> | BlockOf<'multi_choice'> | BlockOf<'ranking'> | BlockOf<'matching'> | BlockOf<'constant_sum'> | BlockOf<'maxdiff'>;

/**
 * Edits a choice block's options. An option's id is created once and never derived from its label, and its export
 * code is edited on its own, so renaming, removing or adding options never changes another option's stored value
 * (B15, B16).
 */
export function OptionsEditor({ block }: { block: ChoiceBlock }) {
  const options = block.config.options;
  const images = (block.type === 'single_choice' || block.type === 'multi_choice') && block.config.display === 'image';
  const write = (next: ChoiceOption[], extra: Record<string, unknown> = {}) => patchBlockConfig(block, { options: next, ...extra });

  const edit = (i: number, patch: Patch<ChoiceOption>) => {
    const next = options.map((o, j) => {
      if (j !== i) return o;
      const merged = applyPatch(o, patch);
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
      <ApiOptionsSection block={block} />
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
            {images ? <OptionImage opt={opt} index={i} onChange={(image) => edit(i, { image })} /> : null}
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
    </div>
  );
}

function OptionImage({ opt, index, onChange }: { opt: ChoiceOption; index: number; onChange: (image: ChoiceOption['image']) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const url = themeImageUrl(opt.image?.assetId);
  const n = index + 1;
  return (
    <div className="relative shrink-0">
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        aria-label={t(M['options.image'], { n })}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          void fileToThemeImage(file).then((data) => {
            const assetId = uid() as AssetId;
            storeThemeImage(assetId, data);
            const alt = labelString(opt.label);
            onChange({ assetId, ...(alt ? { alt } : {}), decorative: true });
          });
        }}
      />
      <button
        type="button"
        className="flex size-10 items-center justify-center overflow-hidden rounded-[6px] border border-border bg-state-hover"
        aria-label={t(M['options.image'], { n })}
        onClick={() => input.current?.click()}
      >
        {url ? <img src={url} alt="" className="size-full object-cover" /> : <ImagePlus className="size-4 text-muted-foreground" />}
      </button>
      {opt.image ? (
        <Button type="button" variant="ghost" size="icon-xs" className="absolute -right-1 -top-1" aria-label={t(M['options.image_remove'], { n })} onClick={() => onChange(undefined)}>
          <Trash2 className="size-3" />
        </Button>
      ) : null}
    </div>
  );
}
