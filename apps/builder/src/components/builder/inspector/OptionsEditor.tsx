import { useRef, type ReactNode } from 'react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type Modifier } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, ImagePlus, Plus, Trash2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { themeImageUrl } from '@form/renderer';
import type { AssetId, BlockId, BlockOf, ChoiceOption, ConditionId, OptionId, Rule, RuleId } from '@form/schema';
import { t } from '@/i18n';
import { labelString } from '@/fields/style';
import { fileToThemeImage, storeThemeImage } from '@/components/builder/design/uploads';
import { applyPatch } from '@/lib/applyPatch';
import { APP_IDS, blockText, inlineDoc } from '@/lib/definition';
import { cn, uid } from '@/lib/utils';
import { patchBlockConfig } from '@/fields/configSink';
import { placeBeside, removeRule, setRule, updateBlock } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { Button, Input } from '@dmacq/ui';
import { ApiOptionsSection } from '@/components/builder/inspector/ApiOptionsSection';
import { ToggleRow } from '@/components/builder/inspector/parts';

const M = defineMessages('builder', {
  'options.add': 'Add option',
  'options.new': 'Option {n}',
  'options.label': 'Label of option {n}',
  'options.code': 'Export code of option {n}',
  'options.code_placeholder': 'Code',
  'options.value': 'Value of option {n}',
  'options.value_placeholder': 'Value',
  'options.fill': 'Fill a field from the selected option',
  'options.fill_hint': 'The field stays empty until an option is chosen, then it shows that option’s value.',
  'options.drag': 'Reorder option {n}: drag, or use the up and down arrow keys',
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

  const edit = (i: number, patch: { [K in keyof ChoiceOption]?: ChoiceOption[K] | undefined }) => {
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

  const valueColumn = block.type === 'single_choice' && block.config.display === 'dropdown';
  return (
    <>
      <div className="space-y-2">
        <SortableOptions ids={options.map((o) => o.id)} onMove={move}>
          {options.map((opt, i) => (
            <SortableOption key={opt.id} id={opt.id} index={i} count={options.length} onMove={move}>
              {images ? <OptionImage opt={opt} index={i} onChange={(image) => edit(i, { image })} /> : null}
              <Input className="min-w-0 flex-1" aria-label={t(M['options.label'], { n: i + 1 })} value={labelString(opt.label)} onChange={(e) => edit(i, { label: e.target.value })} />
              <Input
                aria-label={t(valueColumn ? M['options.value'] : M['options.code'], { n: i + 1 })}
                title={t(M['options.codes_hint'])}
                className="w-[76px] shrink-0 text-[12px]"
                placeholder={t(valueColumn ? M['options.value_placeholder'] : M['options.code_placeholder'])}
                value={opt.code ?? ''}
                onChange={(e) => edit(i, { code: e.target.value.slice(0, 200) })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={t(M['options.remove'], { n: i + 1 })}
                disabled={options.length <= 1}
                onClick={() => remove(opt.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </SortableOption>
          ))}
        </SortableOptions>
        <Button type="button" variant="outline" size="sm" className="w-full border-dashed text-muted-foreground hover:text-foreground" onClick={add}>
          <Plus className="size-3.5" /> {t(M['options.add'])}
        </Button>
      </div>
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
      {block.type === 'single_choice' && block.config.display === 'dropdown' ? <FillFromOption block={block} /> : null}
      <ApiOptionsSection block={block} />
    </>
  );
}

/** Options move up and down only; a sideways drag never shifts a row out of the column. */
const VERTICAL_ONLY: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** The options list, sorted by dragging a row's handle. Only vertical moves inside the list are allowed. */
function SortableOptions({ ids, onMove, children }: { ids: OptionId[]; onMove: (from: number, to: number) => void; children: ReactNode }) {
  /* A few pixels of travel before a drag starts, so a click on the handle (to focus it) never moves anything. */
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onMove(ids.indexOf(active.id as OptionId), ids.indexOf(over.id as OptionId));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[VERTICAL_ONLY]} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="relative space-y-1.5">{children}</ul>
      </SortableContext>
    </DndContext>
  );
}

/**
 * One option row with its six-dot handle. Pointer users drag the handle; keyboard users focus it and press the up or
 * down arrow to move the option one place.
 */
function SortableOption({ id, index, count, onMove, children }: { id: OptionId; index: number; count: number; onMove: (from: number, to: number) => void; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('relative flex items-center gap-1 rounded-md bg-background', isDragging && 'z-10 shadow-md')}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t(M['options.drag'], { n: index + 1 })}
        aria-roledescription={undefined}
        aria-describedby={undefined}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          const to = index + (e.key === 'ArrowUp' ? -1 : 1);
          if (to >= 0 && to < count) onMove(index, to);
        }}
        className={cn(
          '-ml-1 flex h-8 w-5 shrink-0 touch-none items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-state-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
          isDragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
      >
        <GripVertical aria-hidden className="size-4" />
      </button>
      {children}
    </li>
  );
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
            onChange({ assetId, decorative: true, ...(labelString(opt.label) ? { alt: labelString(opt.label) } : {}) });
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
