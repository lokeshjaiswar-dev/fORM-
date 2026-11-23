import { useRef, type ReactNode } from 'react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type Modifier } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, ImagePlus, Trash2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { themeImageUrl } from '@form/renderer';
import type { AssetId, ChoiceOption, OptionId } from '@form/schema';
import { t } from '@/i18n';
import { labelString } from '@/fields/style';
import { fileToThemeImage, storeThemeImage } from '@/components/builder/design/uploads';
import { cn, uid } from '@/lib/utils';
import { Button, Input } from '@dmacq/ui';

const M = defineMessages('builder', {
  'options.label': 'Label of option {n}',
  'options.code': 'Export code of option {n}',
  'options.code_placeholder': 'Code',
  'options.value': 'Value of option {n}',
  'options.value_placeholder': 'Value',
  'options.drag': 'Reorder option {n}: drag, or use the up and down arrow keys',
  'options.codes_hint': 'Answers store each option’s id, never its label: renaming an option keeps its answers and its code.',
  'options.image': 'Upload image for option {n}',
  'options.image_remove': 'Remove image from option {n}',
});

export type OptionPatch = { [K in keyof ChoiceOption]?: ChoiceOption[K] | undefined };

/** Options move up and down only; a sideways drag never shifts a row out of the column. */
const VERTICAL_ONLY: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** A list of option rows, sorted by dragging a row's handle. `onMove` names the moved option and the one it lands on. */
export function SortableOptions({ ids, onMove, children }: { ids: readonly OptionId[]; onMove: (id: OptionId, over: OptionId) => void; children: ReactNode }) {
  /* A few pixels of travel before a drag starts, so a click on the handle (to focus it) never moves anything. */
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) onMove(active.id as OptionId, over.id as OptionId);
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[VERTICAL_ONLY]} onDragEnd={onDragEnd}>
      <SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
        <ul className="relative space-y-1.5">{children}</ul>
      </SortableContext>
    </DndContext>
  );
}

export interface OptionRowProps {
  option: ChoiceOption;
  /** 1-based position shown in labels for assistive technology. */
  n: number;
  /** The neighbours a keyboard move lands on (the option above and below in this list). */
  above: OptionId | undefined;
  below: OptionId | undefined;
  onMove: (id: OptionId, over: OptionId) => void;
  images: boolean;
  /** A dropdown's second column is the value written to a linked field; elsewhere it is the export code. */
  valueColumn: boolean;
  /** Whether the code (or value) column shows; it is hidden unless the author asks for it under More options. */
  showCode: boolean;
  autoFocus?: boolean;
  onEdit: (patch: OptionPatch) => void;
  removeLabel: string;
  removeDisabled: boolean;
  onRemove: () => void;
}

/**
 * One option: a six-dot handle (drag it, or focus it and press the up or down arrow), the label, the code or value,
 * and a remove button.
 */
export function OptionRow({ option, n, above, below, onMove, images, valueColumn, showCode, autoFocus, onEdit, removeLabel, removeDisabled, onRemove }: OptionRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: option.id });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn('relative flex items-center gap-1 rounded-md bg-background', isDragging && 'z-10 shadow-md')}>
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t(M['options.drag'], { n })}
        aria-roledescription={undefined}
        aria-describedby={undefined}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          const to = e.key === 'ArrowUp' ? above : below;
          if (to) onMove(option.id, to);
        }}
        className={cn(
          '-ml-1 flex h-8 w-5 shrink-0 touch-none items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-state-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
          isDragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
      >
        <GripVertical aria-hidden className="size-4" />
      </button>
      {images ? <OptionImage opt={option} n={n} onChange={(image) => onEdit({ image })} /> : null}
      <Input className="min-w-0 flex-1" autoFocus={autoFocus} aria-label={t(M['options.label'], { n })} value={labelString(option.label)} onChange={(e) => onEdit({ label: e.target.value })} />
      {showCode ? (
        <Input
          aria-label={t(valueColumn ? M['options.value'] : M['options.code'], { n })}
          title={t(M['options.codes_hint'])}
          className="w-[76px] shrink-0 text-[12px]"
          placeholder={t(valueColumn ? M['options.value_placeholder'] : M['options.code_placeholder'])}
          value={option.code ?? ''}
          onChange={(e) => onEdit({ code: e.target.value.slice(0, 200) })}
        />
      ) : null}
      <Button type="button" variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground hover:text-destructive" aria-label={removeLabel} disabled={removeDisabled} onClick={onRemove}>
        <Trash2 className="size-3.5" />
      </Button>
    </li>
  );
}

function OptionImage({ opt, n, onChange }: { opt: ChoiceOption; n: number; onChange: (image: ChoiceOption['image']) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const url = themeImageUrl(opt.image?.assetId);
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
