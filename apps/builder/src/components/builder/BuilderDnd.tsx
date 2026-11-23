import { useRef, useState, type ReactNode } from 'react';
import {
  closestCenter, defaultDropAnimationSideEffects, DndContext, DragOverlay, KeyboardSensor, PointerSensor, pointerWithin, useSensor, useSensors,
  type Active, type CollisionDetection, type DragEndEvent, type DragMoveEvent, type DragStartEvent, type DropAnimation, type KeyboardSensorOptions, type Over, type PointerSensorOptions, type UniqueIdentifier,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { BlockId } from '@form/schema';
import { tileOf as tileForBlock, type Tile } from '@/fields/tiles';
import { blockText, placementOf } from '@/lib/definition';
import { moveBlock, placeBeside } from '@/state/actions';
import { currentDoc, useBlock } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { insertTile } from '@/components/builder/insert';
import { FieldTile } from '@/components/builder/FieldIcon';
import { DropIndicatorContext, type DropIndicator } from '@/components/builder/dropIndicator';

const CANVAS = 'canvas-drop';
const BESIDE = 'beside-';
/** Pointer travel before a drag starts, so a click on the handle still opens the block's settings. */
const DRAG_START_DISTANCE = 6;

/*
 * Sensor options live outside the component: useSensor memoises on the options object, and new objects on each render
 * would rebuild every draggable's listeners, re-rendering the whole palette and every block on each drag update.
 */
const POINTER_OPTIONS: PointerSensorOptions = { activationConstraint: { distance: DRAG_START_DISTANCE } };
const KEYBOARD_OPTIONS: KeyboardSensorOptions = { coordinateGetter: sortableKeyboardCoordinates };

const isBlockTarget =(id: UniqueIdentifier): boolean => {
  const key = String(id);
  return key !== CANVAS && !key.startsWith(BESIDE);
};

/**
 * The drop target. A "beside" slot under the pointer wins. Anywhere else on the canvas the nearest block (by centre) is
 * the target, so the gaps between blocks and the margins that hold the drag handles never fall back to the whole canvas,
 * which made the blocks snap back and forth mid-drag. Off the canvas (palette, panels) there is no target. Keyboard
 * drags have no pointer and always use the nearest block.
 */
const collision: CollisionDetection = (args) => {
  const blocks = args.droppableContainers.filter((c) => isBlockTarget(c.id));
  if (!args.pointerCoordinates) return closestCenter({ ...args, droppableContainers: blocks });
  const within = pointerWithin(args);
  const beside = within.find((h) => String(h.id).startsWith(BESIDE));
  if (beside) return [beside];
  if (!within.some((h) => h.id === CANVAS)) return [];
  if (!blocks.length) return within.filter((h) => h.id === CANVAS);
  return closestCenter({ ...args, droppableContainers: blocks });
};

/** True when the dragged item's centre is below the target's centre: a palette field then goes after the target. */
function landsAfter(active: Active, over: Over): boolean {
  const dragged = active.rect.current.translated;
  if (!dragged) return false;
  return dragged.top + dragged.height / 2 > over.rect.top + over.rect.height / 2;
}

const paletteTile = (data: unknown): Tile | null => {
  const d = data as { from?: string; tile?: Tile } | undefined;
  return d?.from === 'palette' && d.tile ? d.tile : null;
};

/** No stray text selection and a grabbing cursor everywhere while something is dragged. */
function lockPageWhileDragging(locked: boolean): void {
  document.body.style.cursor = locked ? 'grabbing' : '';
  document.body.style.userSelect = locked ? 'none' : '';
}

/** A moved block settles into its new place instead of jumping there. */
const BLOCK_DROP_ANIMATION: DropAnimation = {
  duration: 180,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0.4' } } }),
};

export function BuilderDnd({ children }: { children: ReactNode }) {
  const startBlank = useUiStore((s) => s.startBlank);
  const [active, setActive] = useState<{ id: string; tile: Tile | null } | null>(null);
  /*
   * Where the current (or last) drag started. Unlike `active`, it is not cleared on drop: the overlay reads it to pick
   * its drop animation after the drag has ended. A palette field has no place to animate to (its source is the
   * palette, not the canvas), so it must not fly back there.
   */
  const [dragSource, setDragSource] = useState<'palette' | 'canvas'>('canvas');
  const [indicator, setIndicator] = useState<DropIndicator | null>(null);
  const indicatorKey = useRef('');

  const sensors = useSensors(useSensor(PointerSensor, POINTER_OPTIONS), useSensor(KeyboardSensor, KEYBOARD_OPTIONS));

  function showIndicator(next: DropIndicator | null) {
    const key = next ? `${next.id}:${next.after}` : '';
    if (key === indicatorKey.current) return;
    indicatorKey.current = key;
    setIndicator(next);
  }

  function finish() {
    setActive(null);
    showIndicator(null);
    lockPageWhileDragging(false);
  }

  function onDragStart(e: DragStartEvent) {
    const tile = paletteTile(e.active.data.current);
    setActive({ id: String(e.active.id), tile });
    setDragSource(tile ? 'palette' : 'canvas');
    lockPageWhileDragging(true);
  }

  /* Only palette drags need the line: a moved block already shows its new place as the other blocks shift. */
  function onDragMove(e: DragMoveEvent) {
    if (!paletteTile(e.active.data.current) || !e.over || !isBlockTarget(e.over.id)) {
      showIndicator(null);
      return;
    }
    showIndicator({ id: String(e.over.id), after: landsAfter(e.active, e.over) });
  }

  function onDragEnd(e: DragEndEvent) {
    finish();
    const { active: dragged, over } = e;
    const tile = paletteTile(dragged.data.current);
    const overId = over ? String(over.id) : null;

    if (tile) startBlank();
    if (overId === null || overId === CANVAS) {
      if (tile) insertTile(tile);
      return;
    }
    if (overId.startsWith(BESIDE)) {
      const hostId = overId.slice(BESIDE.length) as BlockId;
      if (!tile) placeBeside(hostId, { id: String(dragged.id) as BlockId });
      else if (tile.kind === 'block') placeBeside(hostId, { choice: tile.choice });
      else insertTile(tile);
      return;
    }
    const at = placementOf(currentDoc(), overId as BlockId);
    if (!at || !('pageId' in at.parent)) return;
    if (tile && over) {
      insertTile(tile, { pageId: at.parent.pageId, index: at.index + (landsAfter(dragged, over) ? 1 : 0) });
      return;
    }
    if (String(dragged.id) !== overId) moveBlock(String(dragged.id) as BlockId, { pageId: at.parent.pageId, index: at.index });
  }

  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={finish}>
      <DropIndicatorContext.Provider value={indicator}>{children}</DropIndicatorContext.Provider>
      <DragOverlay dropAnimation={dragSource === 'palette' ? null : BLOCK_DROP_ANIMATION}>
        {active?.tile ? <GhostCard tile={active.tile} label={active.tile.label} /> : active ? <BlockGhost id={active.id as BlockId} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

/** The card that follows the pointer: the field's icon and name. The block itself stays in the list as the placeholder. */
function GhostCard({ tile, label }: { tile: Tile | undefined; label: string }) {
  return (
    <div className="inline-flex max-w-[320px] cursor-grabbing items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-xl ring-1 ring-black/5">
      {tile ? <FieldTile tile={tile} /> : null}
      <span className="truncate">{label}</span>
    </div>
  );
}

function BlockGhost({ id }: { id: BlockId }) {
  const block = useBlock(id);
  if (!block || block.type === 'unsupported') return null;
  const tile = tileForBlock(block.type, block.config as Readonly<Record<string, unknown>>);
  const label = blockText(block) || tile?.label || block.type;
  return <GhostCard tile={tile} label={label} />;
}
