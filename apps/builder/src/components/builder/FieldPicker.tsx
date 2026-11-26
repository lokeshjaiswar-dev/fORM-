import { useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { ChevronsLeft, Search, Trash2, X } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { useCustomFields } from '@/fields/custom/useCustomFields';
import { CATEGORIES, categoryLabel, matchTiles, tilesFromCustomFields, type Tile } from '@/fields/tiles';
import { useEdition } from '@/edition/edition';
import { useProfile } from '@/embed/useProfile';
import { useDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { insertTile } from '@/components/builder/insert';
import { FieldTile } from '@/components/builder/FieldIcon';
import { FormSummary } from '@/components/builder/sidebar/FormSummary';
import { cn } from '@/lib/utils';
import { customFields } from '@/fields/custom/repository';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Tabs, TabsContent, TabsList, TabsTrigger } from '@dmacq/ui';
import { Tooltip } from '@/components/Tooltip';
import { GLIDE_TRIGGER, TabGlide } from '@/components/TabGlide';

const M = defineMessages('builder', {
  'picker.title': 'Toolbox',
  'picker.tab_fields': 'Fields',
  'picker.tab_structure': 'Structure',
  'picker.close': 'Close sidebar',
  'picker.search': 'Search',
  'picker.search_fields': 'Search fields',
  'picker.search_structure': 'Search this form',
  'picker.search_close': 'Close search',
  'picker.drag': 'Drag a field onto the form',
  'picker.drag_hint': 'Drag to add · {label}',
  'picker.delete': 'Remove from Your fields',
  'picker.delete_title': 'Remove this field?',
  'picker.delete_body': '“{name}” will be removed from Your fields. Blocks already on the form stay as they are.',
  'picker.delete_confirm': 'Remove',
});

/**
 * The sidebar's scrolling lists: the browser's own scrolling, which the design system's quiet scrollbar styles. Not the
 * Radix ScrollArea, which writes a <style> through innerHTML that the production policy's Trusted Types rule blocks,
 * taking the whole builder down with it.
 */
const SCROLLER = 'h-full overflow-y-auto overscroll-contain px-2 pb-4';

/** Figma DMacq Design System 5361:184871: a 240px panel. */
const PICKER_WIDTH = 'w-[240px]';

type PickerTab = 'elements' | 'summary';

/**
 * The left sidebar, "Toolbox" (Figma DMacq Design System 5361:184871): "Fields", every registry palette entry (FND-03),
 * draggable onto the canvas; and "Structure", the blocks already on the form in order. One search bar, which takes
 * the title row's place while open, filters whichever tab is showing.
 */
export function FieldPicker() {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const designOpen = useUiStore((s) => s.designOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const [tab, setTab] = useState<PickerTab>('elements');
  const [q, setQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  const openSearch = () => setSearchOpen(true);
  const closeSearch = () => {
    setQ('');
    setSearchOpen(false);
  };

  return (
    <aside className={cn('vt-builder-toolbox min-h-0 shrink-0 overflow-hidden border-r border-border bg-card transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]', sidebarOpen && !designOpen ? PICKER_WIDTH : 'w-0')}>
      <div className={cn('flex h-full min-h-0 flex-col', PICKER_WIDTH)}>
        {/* One 32px row: the title and its buttons, or, while searching, the search bar in the same place. */}
        <div className="flex h-8 items-center px-3 mt-2.5">
          {searchOpen ? (
            <PickerSearch
              value={q}
              onChange={setQ}
              onClose={closeSearch}
              placeholder={t(tab === 'elements' ? M['picker.search_fields'] : M['picker.search_structure'])}
            />
          ) : (
            <>
              <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold leading-5 text-foreground">{t(M['picker.title'])}</h2>
              <Tooltip content={t(M['picker.search'])}>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['picker.search'])} onClick={openSearch}>
                  <Search className="size-4" />
                </Button>
              </Tooltip>
              <Tooltip content={t(M['picker.close'])}>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['picker.close'])} onClick={() => setSidebarOpen(false)}>
                  <ChevronsLeft className="size-4" />
                </Button>
              </Tooltip>
            </>
          )}
        </div>

        <Tabs value={tab} onValueChange={(next) => setTab(next as PickerTab)} variant="pill" size="sm" fullWidth className="flex min-h-0 flex-1 flex-col gap-0">
          <div className="px-3 pt-3">
            <TabsList className="relative w-full rounded-[6px] p-0.5">
              <TabGlide active={tab} className="rounded-md bg-card shadow-sm" />
              <TabsTrigger value="elements" className={cn(GLIDE_TRIGGER, 'min-h-7 duration-300 data-[state=active]:text-primary-text')}>{t(M['picker.tab_fields'])}</TabsTrigger>
              <TabsTrigger value="summary" className={cn(GLIDE_TRIGGER, 'min-h-7 duration-300 data-[state=active]:text-primary-text')}>{t(M['picker.tab_structure'])}</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="elements" className="mt-0 min-h-0 flex-1">
            <PaletteList query={q} />
          </TabsContent>
          <TabsContent value="summary" className="mt-0 min-h-0 flex-1">
            <div role="region" aria-label={t(M['picker.tab_structure'])} className={SCROLLER + ' pt-3'}>
              <FormSummary query={q} onAddFields={() => setTab('elements')} />
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </aside>
  );
}

/**
 * The search bar that takes the title row's place while searching. The x inside it leaves search and clears the query,
 * as does Escape, putting the title row back.
 */
function PickerSearch({ value, onChange, onClose, placeholder }: { value: string; onChange: (value: string) => void; onClose: () => void; placeholder: string }) {
  return (
    <Input
      size="sm"
      autoFocus
      role="searchbox"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
      placeholder={placeholder}
      aria-label={t(M['picker.search'])}
      className="w-full"
      startIcon={<Search aria-hidden className="size-3.5" />}
      endIcon={
        <button type="button" aria-label={t(M['picker.search_close'])} title={t(M['picker.search_close'])} onClick={onClose}>
          <X aria-hidden className="size-3.5" />
        </button>
      }
    />
  );
}

/**
 * The palette, grouped by category: groups sit 20px apart, each heading 6px above its own steady 32px rows. The Masters
 * builder (profile dms-v1) offers exactly DMS+'s seven field types in its own order, as one list without group headings
 * (fields/tiles.ts DMS_TILES); the slash menu follows the same profile.
 */
function PaletteList({ query }: { query: string }) {
  const edition = useEdition();
  const { fields } = useCustomFields();
  const sectionNav = useDoc((d) => d.behavior.sectionNav?.enabled === true);
  const profile = useProfile();
  const tiles = matchTiles(query, edition, tilesFromCustomFields(fields ?? []), { sectionNav, profile });
  const [removing, setRemoving] = useState<Tile | null>(null);

  if (profile === 'dms-v1') {
    return (
      <div role="region" aria-label={t(M['picker.drag'])} className={SCROLLER + ' pt-2'}>
        <div className="flex flex-col gap-px pt-2">
          {tiles.map((tile) => (
            <PaletteItem key={tile.id} tile={tile} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <div role="region" aria-label={t(M['picker.drag'])} className={SCROLLER + ' pt-2'}>
        {CATEGORIES.map((cat) => {
          const items = tiles.filter((tile) => tile.category === cat);
          if (!items.length) return null;
          const headingId = `picker-group-${cat}`;
          return (
            <section key={cat} aria-labelledby={headingId} className="pt-5 first:pt-2">
              <h3 id={headingId} className="px-2 pb-1.5 text-[11px] font-semibold uppercase leading-4 tracking-[0.06em] text-muted-foreground">
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
      </div>
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
    </>
  );
}

function PaletteItem({ tile, onRemove }: { tile: Tile; onRemove?: (() => void) | undefined }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `palette-${tile.id}`, data: { from: 'palette', tile } });

  /* Every palette item re-renders on each drag update; dnd-kit keeps these inputs stable, so only the dragged one redraws. */
  return useMemo(() => (
    <div className={cn('flex items-center gap-0.5', isDragging && 'opacity-40')}>
      <Tooltip content={t(M['picker.drag_hint'], { label: tile.label })} side="right" delay={500} className="min-w-0 flex-1">
        <button
          type="button"
          ref={setNodeRef}
          onClick={() => insertTile(tile)}
          className="flex h-8 min-w-0 flex-1 cursor-grab items-center gap-2.5 rounded-[6px] px-2 text-left text-[14px] font-medium leading-5 text-foreground hover:bg-state-hover active:cursor-grabbing"
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
