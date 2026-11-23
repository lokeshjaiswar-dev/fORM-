import { useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { ChevronDown, ChevronsLeft, Trash2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { useCustomFields } from '@/fields/custom/useCustomFields';
import { CATEGORIES, categoryLabel, matchTiles, tilesFromCustomFields, type Tile } from '@/fields/tiles';
import { useEdition } from '@/edition/edition';
import { useDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { insertTile } from '@/components/builder/insert';
import { FieldTile } from '@/components/builder/FieldIcon';
import { cn } from '@/lib/utils';
import { customFields } from '@/fields/custom/repository';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, ScrollArea, SearchInput } from '@dmacq/ui';
import { Tooltip } from '@/components/Tooltip';

const M = defineMessages('builder', {
  'picker.close': 'Close sidebar',
  'picker.search': 'Search',
  'picker.drag': 'Drag a field onto the form',
  'picker.drag_hint': 'Drag to add · {label}',
  'picker.delete': 'Remove from Your fields',
  'picker.delete_title': 'Remove this field?',
  'picker.delete_body': '“{name}” will be removed from Your fields. Blocks already on the form stay as they are.',
  'picker.delete_confirm': 'Remove',
});

/** Narrower below 1280px so smaller desktop screens leave the canvas room for the form. */
const PICKER_WIDTH = 'w-[224px] xl:w-[252px]';

/** The sidebar palette: every registry palette entry (FND-03), searchable, draggable onto the canvas. */
export function FieldPicker() {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const designOpen = useUiStore((s) => s.designOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const [q, setQ] = useState('');
  const edition = useEdition();
  const { fields } = useCustomFields();
  const sectionNav = useDoc((d) => d.behavior.sectionNav?.enabled === true);
  const tiles = matchTiles(q, edition, tilesFromCustomFields(fields ?? []), { sectionNav });
  const [removing, setRemoving] = useState<Tile | null>(null);

  return (
    <aside className={cn('min-h-0 shrink-0 overflow-hidden border-r border-border bg-surface-subtle transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]', sidebarOpen && !designOpen ? PICKER_WIDTH : 'w-0')}>
      <div className={cn('flex h-full min-h-0 flex-col', PICKER_WIDTH)}>
        <div className="flex items-center gap-1 px-2 pt-2.5">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[6px] px-1.5 py-1">
            <span className="flex size-5 items-center justify-center rounded-[4px] bg-primary text-[11px] font-bold text-primary-foreground">F</span>
            <span className="truncate text-[14px] font-medium">Form+</span>
            <ChevronDown className="size-3.5 shrink-0 text-text-subtle" />
          </span>
          <Tooltip content={t(M['picker.close'])}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t(M['picker.close'])}
              onClick={() => setSidebarOpen(false)}
            >
              <ChevronsLeft className="size-4" />
            </Button>
          </Tooltip>
        </div>

        <div className="px-2 pt-1">
          <SearchInput
            size="sm"
            value={q}
            onValueChange={setQ}
            placeholder={t(M['picker.search'])}
            aria-label={t(M['picker.search'])}
          />
        </div>

        {/*
          * Straight into the fields: groups sit 20px apart, each heading 6px above its own rows, so a heading reads as
          * belonging to the fields under it rather than floating between groups. Rows are a steady 32px.
          */}
        <ScrollArea className="mt-2 min-h-0 flex-1 px-2 pb-4" aria-label={t(M['picker.drag'])}>
          {CATEGORIES.map((cat) => {
            const items = tiles.filter((tile) => tile.category === cat);
            if (!items.length) return null;
            const headingId = `picker-group-${cat}`;
            return (
              <section key={cat} aria-labelledby={headingId} className="pt-5 first:pt-2">
                <h3 id={headingId} className="px-2 pb-1.5 text-[11px] font-semibold uppercase leading-4 tracking-[0.06em] text-text-subtle">
                  {categoryLabel(cat)}
                </h3>
                <div className="flex flex-col gap-px">
                  {items.map((tile) => (
                    <PaletteItem key={tile.id} tile={tile} {...(tile.id.startsWith('custom.') ? { onRemove: () => setRemoving(tile) } : {})} />
                  ))}
                </div>
              </section>
            );
          })}
        </ScrollArea>
        <Dialog open={removing !== null} onOpenChange={(next) => !next && setRemoving(null)}>
          <DialogContent className="gap-5 p-6 sm:max-w-[440px]">
            <DialogHeader>
              <DialogTitle>{t(M['picker.delete_title'])}</DialogTitle>
              <DialogDescription>{t(M['picker.delete_body'], { name: removing?.label ?? '' })}</DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  const id = removing?.id.replace(/^custom\./, '');
                  setRemoving(null);
                  if (id) void customFields.remove(id);
                }}
              >
                {t(M['picker.delete_confirm'])}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </aside>
  );
}

function PaletteItem({ tile, onRemove }: { tile: Tile; onRemove?: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `palette-${tile.id}`, data: { from: 'palette', tile } });

  /* Every palette item re-renders on each drag update; dnd-kit keeps these inputs stable, so only the dragged one redraws. */
  return useMemo(() => (
    <div className={cn('flex items-center gap-0.5', isDragging && 'opacity-40')}>
      <Tooltip content={t(M['picker.drag_hint'], { label: tile.label })} side="right" delay={500} className="min-w-0 flex-1">
        <button
          type="button"
          ref={setNodeRef}
          onClick={() => insertTile(tile)}
          className="flex h-8 min-w-0 flex-1 cursor-grab items-center gap-2.5 rounded-[6px] px-2 text-left text-[14px] leading-5 hover:bg-state-hover active:cursor-grabbing"
          {...listeners}
          {...attributes}
        >
          <FieldTile tile={tile} />
          <span className="truncate">{tile.label}</span>
        </button>
      </Tooltip>
      {onRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label={t(M['picker.delete'])}
          title={t(M['picker.delete'])}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Trash2 className="size-3.5" />
        </Button>
      ) : null}
    </div>
  ), [tile, onRemove, attributes, listeners, setNodeRef, isDragging]);
}
