import { memo, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Copy, GripVertical, Plus, Trash2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import type { BlockId } from '@form/schema';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import { isOptionValueField } from '@/state/commands/rules';
import { duplicateBlock, requestDeleteBlock, slotAfter } from '@/state/actions';
import { useBlock, useDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { insertTile } from '@/components/builder/insert';
import { EditBlock } from '@/components/blocks/EditBlock';
import { SlashMenu } from '@/components/builder/SlashMenu';
import { useDropIndicator } from '@/components/builder/dropIndicator';
import { Button, Popover, PopoverAnchor, PopoverContent } from '@dmacq/ui';
import { Tooltip } from '@/components/Tooltip';

const M = defineMessages('builder', {
  'block.delete': 'Delete block',
  'block.duplicate': 'Duplicate block',
  'block.insert': 'Insert block',
  'block.drag': 'Drag to reorder · click for settings',
});

/** How a block's handle and actions show: always (selected, menu open), on hover, or not at all (while dragging). */
type Visibility = 'shown' | 'hover' | 'hidden';

const VISIBILITY: Record<Visibility, string> = {
  shown: 'opacity-100',
  hover: 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100',
  hidden: 'pointer-events-none opacity-0',
};

/**
 * One block on the canvas. It reads its own block from the store (a per-block selector) and is memoised on its id,
 * so typing in one block re-renders that block only (FND-13). While sorting, every block re-renders as the drop target
 * changes; its content, handle and actions are memoised so only the wrapper's transform updates.
 */
export const CanvasBlock = memo(function CanvasBlock({ id, span, share }: { id: BlockId; span: number; share: boolean }) {
  const block = useBlock(id);
  const { active, attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, data: { type: 'block' } });
  const selected = useUiStore((s) => s.activeBlockId === id);
  const openInspector = useUiStore((s) => s.openInspector);
  const filledFromOption = useDoc((d) => isOptionValueField(d, id));
  const indicator = useDropIndicator(id);
  const [menuOpen, setMenuOpen] = useState(false);
  const content = useMemo(() => (block ? <EditBlock block={block} /> : null), [block]);
  if (!block) return null;
  /* While anything is dragged, other blocks show no hover tint or controls as the pointer passes over them. */
  const dragging = active !== null;
  const visibility: Visibility = dragging ? 'hidden' : selected || menuOpen ? 'shown' : 'hover';

  return (
    <div
      ref={setNodeRef}
      data-block-id={id}
      data-selected={selected || undefined}
      /* Translate only: blocks of different heights must not be stretched as they trade places. */
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('group min-w-0 py-1', span >= 12 ? 'w-full' : share ? 'min-w-0 flex-1' : 'w-1/2')}
      onClick={(e) => {
        e.stopPropagation();
        if (!filledFromOption) openInspector(id);
      }}
    >
      <div className={cn('relative', visibility === 'shown' && 'z-20')}>
        {/* The selection surface: a soft accent tint and outline on the selected block, a faint tint on hover. Half-width
            blocks keep it tighter so two blocks on one row never overlap across the row gap. */}
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute -inset-y-2 rounded-xl transition-[background-color,box-shadow] duration-150',
            span >= 12 ? '-inset-x-3' : '-inset-x-1.5',
            selected && !isDragging
              ? 'bg-[color-mix(in_srgb,var(--fr-accent)_7%,transparent)] shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--fr-accent)_55%,transparent)]'
              : !dragging && 'group-hover:bg-[color-mix(in_srgb,var(--fr-text)_4%,transparent)]',
            /* The dragged block stays in the list as a dashed placeholder marking where it will land. */
            isDragging && 'shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--fr-accent)_45%,transparent)] [background:repeating-linear-gradient(-45deg,transparent_0_6px,color-mix(in_srgb,var(--fr-accent)_6%,transparent)_6px_12px)]',
          )}
        />

        {/* Where a field dragged from the palette will be inserted. */}
        {indicator ? (
          <div
            aria-hidden
            className={cn('pointer-events-none absolute -inset-x-3 z-10 h-[3px] rounded-full bg-[var(--fr-accent)]', indicator === 'after' ? '-bottom-3' : '-top-3')}
          />
        ) : null}

        <DragHandle
          id={id}
          visibility={visibility}
          attributes={attributes}
          listeners={listeners}
          setActivatorNodeRef={setActivatorNodeRef}
          opensSettings={!filledFromOption}
        />
        <BlockActions id={id} visibility={visibility} canCopy={!filledFromOption} onMenuOpenChange={setMenuOpen} />

        <div className={cn('relative min-w-0 transition-opacity', isDragging && 'opacity-40')}>{content}</div>
      </div>
    </div>
  );
});

type Sortable = ReturnType<typeof useSortable>;

interface DragHandleProps {
  id: BlockId;
  visibility: Visibility;
  attributes: Sortable['attributes'];
  listeners: Sortable['listeners'];
  setActivatorNodeRef: Sortable['setActivatorNodeRef'];
  opensSettings: boolean;
}

/** The drag handle in the left margin; a click on it (no drag) opens the block's settings. */
const DragHandle = memo(function DragHandle({ id, visibility, attributes, listeners, setActivatorNodeRef, opensSettings }: DragHandleProps) {
  const openInspector = useUiStore((s) => s.openInspector);
  return (
    <div className={cn('absolute right-full top-0 z-10 mr-3.5 transition-opacity', VISIBILITY[visibility])}>
      <Tooltip content={t(M['block.drag'])} side="top">
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label={t(M['block.drag'])}
          className="flex h-8 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-[#a3a3a3] hover:bg-black/5 hover:text-[#6b6b6b] active:cursor-grabbing"
          {...attributes}
          {...listeners}
          onClick={(e) => {
            e.stopPropagation();
            if (opensSettings) openInspector(id);
          }}
        >
          <GripVertical className="size-4" />
        </button>
      </Tooltip>
    </div>
  );
});

interface BlockActionsProps {
  id: BlockId;
  visibility: Visibility;
  /** False for a field filled from an option: it can be deleted, but not duplicated or inserted after. */
  canCopy: boolean;
  onMenuOpenChange: (open: boolean) => void;
}

/** Delete, duplicate and insert, stacked in the right margin. */
const BlockActions = memo(function BlockActions({ id, visibility, canCopy, onMenuOpenChange }: BlockActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const toggleMenu = (open: boolean) => {
    setMenuOpen(open);
    onMenuOpenChange(open);
    setQuery('');
  };
  return (
    <div
      className={cn(
        'absolute left-full top-0 z-10 ml-3.5 flex flex-col gap-0.5 rounded-lg border border-black/5 bg-[var(--fr-surface)] p-0.5 shadow-sm transition-opacity',
        VISIBILITY[visibility],
      )}
    >
      <IconBtn label={t(M['block.delete'])} danger onClick={() => requestDeleteBlock(id)}>
        <Trash2 className="size-3.5" />
      </IconBtn>
      {canCopy ? (
        <IconBtn label={t(M['block.duplicate'])} onClick={() => duplicateBlock(id)}>
          <Copy className="size-3.5" />
        </IconBtn>
      ) : null}
      {canCopy ? <InsertMenu id={id} open={menuOpen} onOpenChange={toggleMenu} query={query} onQueryChange={setQuery} /> : null}
    </div>
  );
});

interface InsertMenuProps {
  id: BlockId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
}

/**
 * The + button and its block menu. The menu floats in a portal over everything (canvas, panels), beside the button
 * and flipped or shifted to stay on screen, so it never takes room on the canvas or gets clipped by its scroll area.
 */
function InsertMenu({ id, open, onOpenChange, query, onQueryChange }: InsertMenuProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div ref={anchorRef}>
          <IconBtn label={t(M['block.insert'])} onClick={() => onOpenChange(!open)}>
            <Plus className="size-3.5" />
          </IconBtn>
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        label={t(M['block.insert'])}
        className="w-auto p-0"
        /* The menu focuses its own filter input. */
        onOpenAutoFocus={(e) => e.preventDefault()}
        /* A press on the + itself toggles through its click; letting it dismiss first would reopen the menu. */
        onInteractOutside={(e) => {
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <SlashMenu
          floating
          open={open}
          query={query}
          onQueryChange={onQueryChange}
          onClose={() => onOpenChange(false)}
          onSelect={(tile) => {
            insertTile(tile, slotAfter(id));
            onOpenChange(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function IconBtn({ children, onClick, label, danger }: { children: ReactNode; onClick: () => void; label: string; danger?: boolean }) {
  return (
    <Tooltip content={label} side="right">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        className={danger ? 'text-icon-muted hover:text-destructive' : 'text-icon-muted'}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        {children}
      </Button>
    </Tooltip>
  );
}
