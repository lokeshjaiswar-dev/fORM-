import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type KeyboardSensorOptions, type PointerSensorOptions } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Asterisk, Eye, EyeOff, GripVertical, Lock } from 'lucide-react';
import type { BlockId } from '@form/schema';
import { placementOf } from '@/lib/definition';
import { cn } from '@/lib/utils';
import { moveBlock, updateBlock } from '@/state/actions';
import { currentDoc, useDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { fieldTypePatch } from '@/lib/fieldType';
import { FieldTile } from '@/components/builder/FieldIcon';
import { Tooltip } from '@/components/Tooltip';
import { filterSummary, summaryCounts, summaryItems, type SummaryBlock, type SummaryCounts } from '@/components/builder/sidebar/summaryItems';

const SORT_PREFIX = 'summary:';
/** Pointer travel before a drag starts, so a click on the handle is not a drag. */
const POINTER_OPTIONS: PointerSensorOptions = { activationConstraint: { distance: 4 } };
const KEYBOARD_OPTIONS: KeyboardSensorOptions = { coordinateGetter: sortableKeyboardCoordinates };

const sortId = (id: BlockId): string => `${SORT_PREFIX}${id}`;
const blockIdOf = (sortable: string | number): BlockId => String(sortable).slice(SORT_PREFIX.length) as BlockId;

/** Selects the block, opens its settings and brings it into view on the canvas. */
function selectBlock(id: BlockId): void {
  useUiStore.getState().openInspector(id);
  document.querySelector(`[data-block-id="${globalThis.CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** Drops a dragged row where the row it was dropped on was, the same move the canvas makes. */
function onDragEnd({ active, over }: DragEndEvent): void {
  if (!over || active.id === over.id) return;
  const at = placementOf(currentDoc(), blockIdOf(over.id));
  if (!at || !('pageId' in at.parent)) return;
  moveBlock(blockIdOf(active.id), { pageId: at.parent.pageId, index: at.index });
}

/**
 * The Structure tab: every block in form order, with a handle to reorder it, an eye to hide or show a field, and marks
 * for required, read-only and hidden fields, so the author sees the whole form at a glance. Reordering is turned off
 * while searching, because a filtered list cannot say where a block lands among the rows it hides.
 */
export function FormSummary({ query, onAddFields }: { query: string; onAddFields: () => void }) {
  const doc = useDoc((d) => d);
  const all = useMemo(() => summaryItems(doc), [doc]);
  const items = useMemo(() => filterSummary(all, query), [all, query]);
  const counts = useMemo(() => summaryCounts(all), [all]);
  const activeBlockId = useUiStore((s) => s.activeBlockId);
  const sortable = !query.trim();
  const sortIds = useMemo(() => items.flatMap((i) => (i.kind === 'block' && i.depth === 0 ? [sortId(i.id)] : [])), [items]);
  const sensors = useSensors(useSensor(PointerSensor, POINTER_OPTIONS), useSensor(KeyboardSensor, KEYBOARD_OPTIONS));

  if (!counts.blocks) {
    return (
      <div className="px-4 py-8 text-center text-[13px] leading-5 text-muted-foreground">
        <p>No blocks on this form yet.</p>
        <button type="button" onClick={onAddFields} className="mt-2 font-medium text-primary-text hover:underline">
          Browse fields to add
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <CountsLine counts={counts} />
      {items.length === 0 ? <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No blocks match “{query.trim()}”.</p> : null}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={sortIds} strategy={verticalListSortingStrategy}>
          <ol aria-label="Form structure" className="flex flex-col gap-px">
            {items.map((item) =>
              item.kind === 'page' ? (
                <li key={`page-${item.pageId}`} className="px-2 pb-1.5 pt-4 text-[11px] font-semibold uppercase leading-4 tracking-[0.06em] text-muted-foreground first:pt-1">
                  Page {item.number}
                </li>
              ) : item.depth === 0 && sortable ? (
                <SortableRow key={item.id} row={item} active={item.id === activeBlockId} />
              ) : (
                <li key={item.id}>
                  <RowContent row={item} active={item.id === activeBlockId} handle={<span className="size-6 shrink-0" aria-hidden />} />
                </li>
              ),
            )}
          </ol>
        </SortableContext>
      </DndContext>
    </div>
  );
}

/** "6 blocks · 2 required · 1 hidden · 1 read-only": the form in one line. */
function CountsLine({ counts }: { counts: SummaryCounts }) {
  const parts = [`${counts.blocks} ${counts.blocks === 1 ? 'block' : 'blocks'}`];
  if (counts.required) parts.push(`${counts.required} required`);
  if (counts.hidden) parts.push(`${counts.hidden} hidden`);
  if (counts.readOnly) parts.push(`${counts.readOnly} read-only`);
  return (
    <p className="px-2 pb-2 text-[12px] leading-4 text-muted-foreground">
      {parts.join(' · ')}
    </p>
  );
}

function SortableRow({ row, active }: { row: SummaryBlock; active: boolean }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: sortId(row.id) });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  return (
    <li ref={setNodeRef} style={style} className={cn('relative', isDragging && 'z-10 opacity-60')}>
      <RowContent
        row={row}
        active={active}
        dragging={isDragging}
        handle={
          <button
            type="button"
            ref={setActivatorNodeRef}
            aria-label={`Reorder ${row.label}`}
            className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded-[4px] text-text-subtle outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical aria-hidden className="size-3.5" />
          </button>
        }
      />
    </li>
  );
}

function RowContent({ row, active, handle, dragging = false }: { row: SummaryBlock; active: boolean; handle: ReactNode; dragging?: boolean }) {
  return (
    <div
      className={cn(
        'group flex h-8 items-center gap-1 rounded-[6px] pr-1',
        active ? 'bg-accent' : 'hover:bg-state-hover',
        dragging && 'bg-card shadow-md ring-1 ring-border',
      )}
      style={{ paddingLeft: row.depth * 14 }}
    >
      {handle}
      <button
        type="button"
        onClick={() => selectBlock(row.id)}
        title={row.label === row.typeLabel ? row.label : `${row.label} (${row.typeLabel})`}
        aria-current={active ? 'true' : undefined}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-[4px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {row.tile ? <FieldTile tile={row.tile} /> : <span className="size-[22px] shrink-0" aria-hidden />}
        <span className={cn('truncate text-[13px] font-medium leading-5', row.hidden ? 'text-muted-foreground line-through decoration-text-subtle/60' : 'text-foreground', active && 'text-accent-foreground')}>
          {row.label}
        </span>
      </button>
      <StatusMarks row={row} />
      {row.field ? <HideToggle row={row} /> : null}
    </div>
  );
}

/** Required and read-only marks. Hidden is shown by the eye and the struck-through label. */
function StatusMarks({ row }: { row: SummaryBlock }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {row.required ? (
        <Mark label="Required">
          <Asterisk aria-hidden className="size-3.5 text-destructive" />
        </Mark>
      ) : null}
      {row.readOnly ? (
        <Mark label="Read-only">
          <Lock aria-hidden className="size-3.5 text-muted-foreground" />
        </Mark>
      ) : null}
      {row.hidden ? <span className="sr-only">Hidden</span> : null}
    </span>
  );
}

function Mark({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip content={label}>
      <span role="img" aria-label={label} className="flex size-5 items-center justify-center">
        {children}
      </span>
    </Tooltip>
  );
}

/**
 * Hides or shows a field for respondents (the same as Hidden in its settings). Hiding makes it hidden only: it is no
 * longer required or read-only, since a respondent cannot answer a field they cannot see (lib/fieldType). A hidden-type
 * field stays hidden, and a primary key stays visible because it is always required.
 */
function HideToggle({ row }: { row: SummaryBlock }) {
  const block = useDoc((d) => d.blocks[row.id]);
  const hiddenType = block?.type === 'hidden';
  const primaryKey = !!block && 'primaryKey' in block && block.primaryKey === true;
  const label = `${row.hidden ? 'Show' : 'Hide'} ${row.label}`;
  const tip = hiddenType ? 'Hidden field: always hidden' : primaryKey ? 'Primary key: always shown' : row.hidden ? 'Show on the form' : 'Hide from the form';
  return (
    <Tooltip content={tip}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={row.hidden}
        disabled={hiddenType || primaryKey}
        onClick={() => updateBlock(row.id, row.hidden ? { concealed: undefined } : fieldTypePatch({}, 'concealed'))}
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-[4px] outline-none hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
          row.hidden ? 'text-primary-text' : 'text-text-subtle hover:text-foreground',
        )}
      >
        {row.hidden ? <EyeOff aria-hidden className="size-3.5" /> : <Eye aria-hidden className="size-3.5" />}
      </button>
    </Tooltip>
  );
}
