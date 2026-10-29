import { useState, type ReactNode } from 'react';
import {
  closestCenter, DndContext, DragOverlay, PointerSensor, pointerWithin, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import type { BlockId } from '@form/schema';
import type { Tile } from '@/fields/tiles';
import { placementOf } from '@/lib/definition';
import { moveBlock, placeBeside } from '@/state/actions';
import { currentDoc, useBlock } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { insertTile } from '@/components/builder/insert';
import { FieldTile } from '@/components/builder/FieldIcon';
import { EditBlock } from '@/components/blocks/EditBlock';

const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args).filter((h) => !String(h.id).startsWith('palette-'));
  const beside = hits.find((h) => String(h.id).startsWith('beside-'));
  if (beside) return [beside];
  const blocks = hits.filter((h) => h.id !== 'canvas-drop');
  if (blocks.length) {
    const containers = args.droppableContainers.filter((c) => blocks.some((b) => b.id === c.id));
    return closestCenter({ ...args, droppableContainers: containers });
  }
  const canvas = hits.find((h) => h.id === 'canvas-drop');
  if (canvas) return [canvas];
  return [];
};

const tileOf = (data: unknown): Tile | null => {
  const d = data as { from?: string; tile?: Tile } | undefined;
  return d?.from === 'palette' && d.tile ? d.tile : null;
};

export function BuilderDnd({ children }: { children: ReactNode }) {
  const startBlank = useUiStore((s) => s.startBlank);
  const [active, setActive] = useState<{ id: string; tile: Tile | null } | null>(null);
  const overlayBlock = useBlock((active && !active.tile ? active.id : '') as BlockId);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function onDragStart(e: DragStartEvent) {
    setActive({ id: String(e.active.id), tile: tileOf(e.active.data.current) });
  }

  function onDragEnd(e: DragEndEvent) {
    setActive(null);
    const { active: dragged, over } = e;
    const tile = tileOf(dragged.data.current);
    const overId = over ? String(over.id) : null;

    if (tile) startBlank();
    if (overId === null || overId.startsWith('palette-') || overId === 'canvas-drop') {
      if (tile) insertTile(tile);
      return;
    }
    if (overId.startsWith('beside-')) {
      const hostId = overId.slice('beside-'.length) as BlockId;
      if (!tile) placeBeside(hostId, { id: String(dragged.id) as BlockId });
      else if (tile.kind === 'block') placeBeside(hostId, { choice: tile.choice });
      else insertTile(tile);
      return;
    }
    const at = placementOf(currentDoc(), overId as BlockId);
    if (!at || !('pageId' in at.parent)) return;
    const slot = { pageId: at.parent.pageId, index: at.index };
    if (tile) {
      insertTile(tile, slot);
      return;
    }
    if (String(dragged.id) !== overId) moveBlock(String(dragged.id) as BlockId, slot);
  }

  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActive(null)}>
      {children}
      <DragOverlay dropAnimation={null}>
        {active?.tile ? (
          <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-lg">
            <FieldTile tile={active.tile} />
            {active.tile.label}
          </div>
        ) : overlayBlock ? (
          <div className="max-w-md rounded-md border bg-white px-4 py-3 opacity-90 shadow-lg">
            <EditBlock block={overlayBlock} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
