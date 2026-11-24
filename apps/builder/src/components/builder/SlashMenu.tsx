import { useEffect, useMemo, useRef } from 'react';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@dmacq/ui';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { useCustomFields } from '@/fields/custom/useCustomFields';
import { CATEGORIES, categoryLabel, matchTiles, tilesFromCustomFields, type Tile } from '@/fields/tiles';
import { FieldTile } from '@/components/builder/FieldIcon';
import { useEdition } from '@/edition/edition';
import { useProfile } from '@/embed/useProfile';
import { useDoc } from '@/state/documentStore';

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
  const { fields } = useCustomFields();
  const extras = useMemo(() => tilesFromCustomFields(fields ?? []), [fields]);
  const sectionNav = useDoc((d) => d.behavior.sectionNav?.enabled === true);
  const profile = useProfile();
  const items = useMemo(() => matchTiles(query, edition, extras, { sectionNav, profile }), [query, edition, extras, sectionNav, profile]);

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
      data-slash-menu=""
      className="absolute left-0 top-full z-40 mt-1 w-[324px]"
      style={{ color: 'var(--popover-foreground)', fontFamily: 'var(--font-sans)', fontSize: 14, lineHeight: '20px' }}
    >
      <Command label={t(M['slash.label'])} shouldFilter={false}>
        <CommandInput
          ref={inputRef}
          value={query}
          {...(onQueryChange ? { onValueChange: onQueryChange } : {})}
          placeholder={t(M['slash.filter'])}
          variant="menu"
          className="border-0 shadow-none outline-none ring-0 focus:border-0 focus:outline-none focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0"
        />
        <CommandList className="max-h-80">
          <CommandEmpty>{t(M['slash.empty'])}</CommandEmpty>
          {CATEGORIES.map((cat) => {
            const group = items.filter((i) => i.category === cat);
            if (!group.length) return null;
            return (
              <CommandGroup key={cat} heading={categoryLabel(cat)}>
                {group.map((tile) => (
                  <CommandItem key={tile.id} value={tile.id} onSelect={() => onSelect(tile)}>
                    <FieldTile tile={tile} />
                    {tile.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            );
          })}
        </CommandList>
      </Command>
    </div>
  );
}
