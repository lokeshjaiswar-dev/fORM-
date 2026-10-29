import { isEditionFeatureAvailable, type EditionFeatures } from '@form/config';
import { defineMessages, type MessageId } from '@form/i18n';
import { AVAILABLE_TYPES, REGISTRY, type AvailableType } from '@form/registry';
import type { PaletteEntry } from '@form/schema';
import { t } from '@/i18n';
import type { BlockChoice } from '@/state/actions';

/*
 * The palette and the slash menu are views of the registry's `palette` entries (FND-03): one tile per entry of every
 * available type, grouped by the entry's category, labelled from the builder catalogue. The page break is the one
 * builder tile: pages are structure in v2, not a block type.
 */

export type Category = PaletteEntry<AvailableType>['category'];

const M = defineMessages('builder', {
  'palette.category.basic': 'Common',
  'palette.category.contact': 'Contact',
  'palette.category.choice': 'Choices',
  'palette.category.date_time': 'Date and time',
  'palette.category.rating': 'Survey',
  'palette.category.media': 'Media',
  'palette.category.layout': 'Layout',
  'palette.category.advanced': 'Advanced',
  'palette.page_break': 'Page break',
});

export type Tile =
  | { kind: 'block'; id: string; choice: BlockChoice; category: Category; label: string; icon: string; keywords: readonly string[] }
  | { kind: 'page_break'; id: 'page_break'; category: Category; label: string; icon: string; keywords: readonly string[] };

/** Categories in palette order; the registry's other categories (payments, compliance, snippets) have no P0 entries. */
export const CATEGORIES: readonly Category[] = ['basic', 'choice', 'rating', 'media', 'layout', 'advanced'];

const CATEGORY_LABELS: Partial<Record<Category, MessageId>> = {
  basic: M['palette.category.basic'],
  contact: M['palette.category.contact'],
  choice: M['palette.category.choice'],
  date_time: M['palette.category.date_time'],
  rating: M['palette.category.rating'],
  media: M['palette.category.media'],
  layout: M['palette.category.layout'],
  advanced: M['palette.category.advanced'],
};

export const categoryLabel = (category: Category): string => {
  const id = CATEGORY_LABELS[category];
  return id ? t(id) : category;
};

/** Tile colours per category (icon tile background and glyph). */
export const TILE_STYLE: Readonly<Record<Category, string>> = {
  basic: 'bg-[#d3e5ef] text-[#337ea9]',
  contact: 'bg-[#fadec9] text-[#d9730d]',
  choice: 'bg-[#dbeddb] text-[#448361]',
  date_time: 'bg-[#f5e0e9] text-[#c14c8a]',
  rating: 'bg-[#fdecc8] text-[#dfab01]',
  media: 'bg-[#ffe2dd] text-[#d44c47]',
  layout: 'bg-[#e3e2e0] text-[#787774]',
  advanced: 'bg-[#e8deee] text-[#9065b0]',
  payments: 'bg-[#dbeddb] text-[#448361]',
  compliance: 'bg-[#e8deee] text-[#9065b0]',
  snippets: 'bg-[#eee9da] text-[#9f6b53]',
};

function blockTiles(type: AvailableType): Tile[] {
  const palette = REGISTRY[type].palette as ReadonlyArray<PaletteEntry<AvailableType>>;
  return palette.map((entry) => ({
    kind: 'block',
    id: entry.id,
    choice: { type, configOverrides: entry.configOverrides },
    category: entry.category,
    label: t(entry.labelKey as MessageId),
    icon: entry.icon,
    keywords: entry.keywords,
  }));
}

const PAGE_BREAK: Tile = { kind: 'page_break', id: 'page_break', category: 'layout', label: t(M['palette.page_break']), icon: 'file-plus', keywords: ['page', 'break', 'step', 'next'] };

/** Every tile, in category order, then registry order within a category. */
export const TILES: readonly Tile[] = (() => {
  const all = [...AVAILABLE_TYPES.flatMap(blockTiles), PAGE_BREAK];
  return CATEGORIES.flatMap((c) => all.filter((tile) => tile.category === c));
})();

/** The tile of a block type (its first palette entry), for the canvas and the drag overlay. */
export const tileOf = (type: string, overrides?: Readonly<Record<string, unknown>>): Tile | undefined => {
  const of = TILES.filter((tile) => tile.kind === 'block' && tile.choice.type === type);
  if (overrides) {
    const match = of.find((tile) => tile.kind === 'block' && Object.entries(tile.choice.configOverrides).every(([k, v]) => overrides[k] === v));
    if (match) return match;
  }
  return of.find((tile) => tile.id === type) ?? of[0];
};

/** Whether the edition runs the tile's block type (`field:<type>`); a disabled feature is hidden (architecture §1.5). */
export const tileAvailable = (tile: Tile, edition: EditionFeatures): boolean =>
  tile.kind === 'page_break' || isEditionFeatureAvailable(edition, `field:${tile.choice.type}`);

/** The edition's tiles whose label, id or keywords contain `query` (case-insensitive); all of them for an empty query. */
export function matchTiles(query: string, edition: EditionFeatures): Tile[] {
  const q = query.trim().toLowerCase();
  return TILES.filter(
    (tile) =>
      tileAvailable(tile, edition) && (!q || tile.label.toLowerCase().includes(q) || tile.id.replaceAll('_', ' ').includes(q) || tile.keywords.some((k) => k.includes(q))),
  );
}
