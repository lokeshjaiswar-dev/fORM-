import { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { ChevronDown, ChevronsLeft, Search } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { CATEGORIES, categoryLabel, matchTiles, type Tile } from '@/fields/tiles';
import { useDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { insertTile } from '@/components/builder/insert';
import { FieldTile } from '@/components/builder/FieldIcon';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';

const M = defineMessages('builder', {
  'picker.close': 'Close sidebar',
  'picker.search': 'Search',
  'picker.this_form': 'This form',
  'picker.untitled': 'Form title',
  'picker.drag': 'Drag a field onto the form',
  'picker.drag_hint': 'Drag to add · {label}',
});

/** The sidebar palette: every registry palette entry (FND-03), searchable, draggable onto the canvas. */
export function FieldPicker() {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const title = useDoc((d) => d.title);
  const [q, setQ] = useState('');
  const tiles = matchTiles(q);

  return (
    <aside className={cn('min-h-0 shrink-0 overflow-hidden bg-[var(--notion-sidebar)] transition-[width] duration-300 ease-out', sidebarOpen ? 'w-[252px]' : 'w-0')}>
      <div className="flex h-full min-h-0 w-[252px] flex-col">
        <div className="flex items-center gap-1 px-2 pt-2.5">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[6px] px-1.5 py-1">
            <span className="flex size-5 items-center justify-center rounded-[4px] bg-[#2383e2] text-[11px] font-bold text-white">F</span>
            <span className="truncate text-[14px] font-medium">Form+</span>
            <ChevronDown className="size-3.5 shrink-0 text-[var(--notion-text-faint)]" />
          </span>
          <Tooltip content={t(M['picker.close'])}>
            <button
              type="button"
              aria-label={t(M['picker.close'])}
              className="flex size-7 items-center justify-center rounded-[6px] text-[var(--notion-text-muted)] hover:bg-[var(--notion-hover)]"
              onClick={() => setSidebarOpen(false)}
            >
              <ChevronsLeft className="size-4" />
            </button>
          </Tooltip>
        </div>

        <div className="px-2 pt-1">
          <label className="flex h-[30px] items-center gap-2 rounded-[6px] bg-[rgba(55,53,47,0.06)] px-2 text-[var(--notion-text-muted)]">
            <Search className="size-3.5 shrink-0" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t(M['picker.search'])}
              aria-label={t(M['picker.search'])}
              className="w-full bg-transparent text-[14px] outline-none placeholder:text-[var(--notion-text-faint)]"
            />
          </label>
        </div>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4">
          <p className="mb-1 px-2 text-[11px] font-medium text-[var(--notion-text-faint)]">{t(M['picker.this_form'])}</p>
          <div className="mb-3 flex items-center gap-2 rounded-[6px] bg-[var(--notion-hover)] px-2 py-1">
            <span className="flex size-5 items-center justify-center rounded-[4px] bg-white text-[11px] font-semibold shadow-sm ring-1 ring-[var(--notion-border)]">F</span>
            <span className="truncate text-[14px]">{title || t(M['picker.untitled'])}</span>
          </div>
          <p className="mb-1 px-2 text-[11px] font-medium text-[var(--notion-text-faint)]">{t(M['picker.drag'])}</p>

          {CATEGORIES.map((cat) => {
            const items = tiles.filter((tile) => tile.category === cat);
            if (!items.length) return null;
            return (
              <div key={cat} className="mb-3">
                <p className="mb-0.5 px-2 py-1 text-[11px] font-medium text-[var(--notion-text-faint)]">{categoryLabel(cat)}</p>
                {items.map((tile) => (
                  <PaletteItem key={tile.id} tile={tile} />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

function PaletteItem({ tile }: { tile: Tile }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `palette-${tile.id}`, data: { from: 'palette', tile } });

  return (
    <Tooltip content={t(M['picker.drag_hint'], { label: tile.label })} side="right" delay={500} className="w-full">
      <button
        type="button"
        ref={setNodeRef}
        onClick={() => insertTile(tile)}
        className={cn(
          'flex w-full cursor-grab items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-[14px] hover:bg-[var(--notion-hover)] active:cursor-grabbing',
          isDragging && 'opacity-40',
        )}
        {...listeners}
        {...attributes}
      >
        <FieldTile tile={tile} />
        <span className="truncate">{tile.label}</span>
      </button>
    </Tooltip>
  );
}
