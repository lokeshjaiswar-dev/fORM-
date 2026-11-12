import { useState } from 'react';
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
  'picker.this_form': 'This form',
  'picker.untitled': 'Form title',
  'picker.drag': 'Drag a field onto the form',
  'picker.drag_hint': 'Drag to add · {label}',
  'picker.delete': 'Remove from Your fields',
  'picker.delete_title': 'Remove this field?',
  'picker.delete_body': '“{name}” will be removed from Your fields. Blocks already on the form stay as they are.',
  'picker.delete_confirm': 'Remove',
});

/** The sidebar palette: every registry palette entry (FND-03), searchable, draggable onto the canvas. */
export function FieldPicker() {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const title = useDoc((d) => d.title);
  const [q, setQ] = useState('');
  const edition = useEdition();
  const { fields } = useCustomFields();
  const tiles = matchTiles(q, edition, tilesFromCustomFields(fields ?? []));
  const [removing, setRemoving] = useState<Tile | null>(null);

  return (
    <aside className={cn('min-h-0 shrink-0 overflow-hidden border-r border-border bg-surface-subtle transition-[width] duration-300 ease-out', sidebarOpen ? 'w-[252px]' : 'w-0')}>
      <div className="flex h-full min-h-0 w-[252px] flex-col">
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

        <ScrollArea className="mt-3 min-h-0 flex-1 px-2 pb-4" aria-label={t(M['picker.drag'])}>
          <p className="mb-1 px-2 text-[11px] font-medium text-text-subtle">{t(M['picker.this_form'])}</p>
          <div className="mb-3 flex items-center gap-2 rounded-[6px] bg-state-hover px-2 py-1">
            <span className="flex size-5 items-center justify-center rounded-[4px] bg-background text-[11px] font-semibold shadow-sm ring-1 ring-border">F</span>
            <span className="truncate text-[14px]">{title || t(M['picker.untitled'])}</span>
          </div>
          <p className="mb-1 px-2 text-[11px] font-medium text-text-subtle">{t(M['picker.drag'])}</p>

          {CATEGORIES.map((cat) => {
            const items = tiles.filter((tile) => tile.category === cat);
            if (!items.length) return null;
            return (
              <div key={cat} className="mb-3">
                <p className="mb-0.5 px-2 py-1 text-[11px] font-medium text-text-subtle">{categoryLabel(cat)}</p>
                {items.map((tile) => (
                  <PaletteItem key={tile.id} tile={tile} onRemove={tile.id.startsWith('custom.') ? () => setRemoving(tile) : undefined} />
                ))}
              </div>
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

  return (
    <div className={cn('flex items-center gap-0.5', isDragging && 'opacity-40')}>
      <Tooltip content={t(M['picker.drag_hint'], { label: tile.label })} side="right" delay={500} className="min-w-0 flex-1">
        <button
          type="button"
          ref={setNodeRef}
          onClick={() => insertTile(tile)}
          className="flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-[14px] hover:bg-state-hover active:cursor-grabbing"
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
  );
}
