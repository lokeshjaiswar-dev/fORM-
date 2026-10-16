import { useState, type ReactNode } from 'react';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useFormStore } from '@/store/useFormStore';
import type { FieldType } from '@/types/form';
import { FIELD_CATALOG } from '@/lib/fields';
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

export function BuilderDnd({ children }: { children: ReactNode }) {
  const form = useFormStore((s) => s.form);
  const addBlock = useFormStore((s) => s.addBlock);
  const placeBeside = useFormStore((s) => s.placeBeside);
  const reorderBlocks = useFormStore((s) => s.reorderBlocks);
  const startBlank = useFormStore((s) => s.startBlank);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function onDragCancel() {
    setActiveId(null);
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    const fromPalette = active.data.current?.from === 'palette';
    const type = active.data.current?.type as FieldType | undefined;

    if (!over) {
      if (fromPalette && type) {
        startBlank();
        addBlock(type);
      }
      return;
    }

    const overId = String(over.id);
    if (overId.startsWith('palette-')) {
      if (fromPalette && type) {
        startBlank();
        addBlock(type);
      }
      return;
    }

    if (overId.startsWith('beside-')) {
      const hostId = overId.slice('beside-'.length);
      startBlank();
      if (fromPalette && type) placeBeside(hostId, { type });
      else placeBeside(hostId, { id: String(active.id) });
      return;
    }

    if (fromPalette && type) {
      startBlank();
      const overIndex = form.blocks.findIndex((b) => b.id === overId);
      addBlock(type, overIndex >= 0 ? overIndex : form.blocks.length);
      return;
    }

    if (overId === 'canvas-drop') return;

    const from = form.blocks.findIndex((b) => b.id === active.id);
    const to = form.blocks.findIndex((b) => b.id === overId);
    if (from >= 0 && to >= 0 && from !== to) reorderBlocks(from, to);
  }

  const overlayType = activeId?.startsWith('palette-') ? (activeId.replace('palette-', '') as FieldType) : null;
  const overlayBlock = form.blocks.find((b) => b.id === activeId);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {overlayType ? (
          <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm shadow-lg">
            <FieldTile type={overlayType} />
            {FIELD_CATALOG.find((f) => f.type === overlayType)?.label}
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
