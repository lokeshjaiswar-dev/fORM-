import { useEffect, useMemo, useRef } from 'react';
import { Command } from 'cmdk';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { CATEGORIES, categoryLabel, matchTiles, type Tile } from '@/fields/tiles';
import { FieldTile } from '@/components/builder/FieldIcon';
import { useEdition } from '@/edition/edition';
import { cn } from '@/lib/utils';

const M = defineMessages('builder', {
  'slash.label': 'Insert block',
  'slash.filter': 'Filter…',
  'slash.empty': 'No results',
});

/** The slash menu: the registry palette (FND-03), filtered by label, id and keywords. */
export function SlashMenu({
  open,
  query,
  onQueryChange,
  onSelect,
  onClose,
}: {
  open: boolean;
  query: string;
  onQueryChange?: (q: string) => void;
  onSelect: (tile: Tile) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const edition = useEdition();
  const items = useMemo(() => matchTiles(query, edition), [query, edition]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (rootRef.current?.contains(target)) return;
      onClose();
    }
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      className="absolute left-0 top-full z-40 mt-1 w-[324px] overflow-hidden rounded-[10px] border border-[var(--notion-border)] bg-white shadow-[0_4px_18px_rgba(15,15,15,0.1),0_0_0_1px_rgba(15,15,15,0.04)]"
    >
      <Command label={t(M['slash.label'])} className="text-sm" shouldFilter={false}>
        <Command.Input
          ref={inputRef}
          value={query}
          {...(onQueryChange ? { onValueChange: onQueryChange } : {})}
          placeholder={t(M['slash.filter'])}
          className="h-9 w-full border-b border-[var(--notion-border)] px-3 text-sm outline-none placeholder:text-[var(--notion-text-muted)]"
        />
        <Command.List className="max-h-80 overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-[var(--notion-text-muted)]">{t(M['slash.empty'])}</Command.Empty>
          {CATEGORIES.map((cat) => {
            const group = items.filter((i) => i.category === cat);
            if (!group.length) return null;
            return (
              <Command.Group
                key={cat}
                heading={categoryLabel(cat)}
                className="mb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[var(--notion-text-faint)]"
              >
                {group.map((tile) => (
                  <Command.Item
                    key={tile.id}
                    value={tile.id}
                    onSelect={() => onSelect(tile)}
                    className={cn('flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 data-[selected=true]:bg-[var(--notion-hover)]')}
                  >
                    <FieldTile tile={tile} />
                    <span className="text-[14px]">{tile.label}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            );
          })}
        </Command.List>
      </Command>
    </div>
  );
}
